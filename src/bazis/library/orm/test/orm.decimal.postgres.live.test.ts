import { afterEach, describe, expect, test } from "bun:test";
import { buildDynamicModel, Column, DbContext, DbContextOptions, Entity, Key, OrmError, postgres, Required, Schema } from "../index";

// 0.117.0: decimal keeps every digit end to end; real (double precision) does not.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

describe.skipIf(!url)("PostgreSQL decimal (live)", () => {
  test("a decimal column stores and returns exact strings, refuses lost digits and survives a restart", async () => {
    schema = `bazis_decimal_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "items" })
    class Item {
      @Key() id = 0;
      @Required() @Column({ type: "decimal", precision: 12, scale: 2 }) price = "0";
      @Column({ type: "real" }) approx = 0;
    }
    class Db extends DbContext { readonly items = this.set(Item); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [Item] }));
    try {
      await db().database.ensureCreated();
      const [column] = await provider.query(`SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'items' AND a.attname = 'price'`, [schema]);
      expect(column).toEqual({ type: "numeric(12,2)" });

      const ctx = db();
      ctx.items.add(Object.assign(new Item(), { price: "0.10", approx: 0.1 }));
      ctx.items.add(Object.assign(new Item(), { price: "0.20", approx: 0.2 }));
      await ctx.saveChanges();
      const items = await db().items.orderBy((i) => i.id).toList();
      expect(items.map((i) => i.price)).toEqual(["0.10", "0.20"]);
      const [sums] = await provider.query(`SELECT sum(price)::text AS exact, sum(approx)::text AS approx FROM "${schema}"."items"`, []);
      expect(sums).toEqual({ exact: "0.30", approx: "0.30000000000000004" });

      const bad = db();
      bad.items.add(Object.assign(new Item(), { price: "1.005" }));
      await expect(bad.saveChanges()).rejects.toThrow('Item.price: "1.005" has 3 digits after the point; numeric(12, 2) keeps 2. Round it in the code.');
      const float = db();
      float.items.add(Object.assign(new Item(), { price: 0.1 as unknown as string }));
      await expect(float.saveChanges()).rejects.toBeInstanceOf(OrmError);

      expect((await db().items.asNoTracking().where((i) => i.id.eq(1)).executeUpdate({ price: "19.90" })).affectedRows).toBe(1);
      await expect(db().items.asNoTracking().where((i) => i.id.eq(1)).executeUpdate({ price: "19.999" })).rejects.toThrow("has 3 digits after the point");
      expect((await db().items.where((i) => i.price.gt("10")).toList()).map((i) => i.price)).toEqual(["19.90"]);

      // The second start reads numeric(12,2) back as the declared decimal.
      await db().database.ensureCreated();
    } finally { await provider.close(); }
  }, 30_000);

  test("the dynamic decimal field is an exact numeric too", async () => {
    schema = `bazis_decimal_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    class Db extends DbContext {}
    const provider = postgres({ url: url! });
    try {
      const options = new DbContextOptions({ provider, entities: [] });
      options.model.registerModel(buildDynamicModel({ name: "Ledger", tableName: "ledger", schema, fields: [{ name: "id", type: "int", isKey: true }, { name: "amount", type: "decimal" }] }));
      const ctx = new Db(options);
      await ctx.database.ensureCreated();
      const [column] = await provider.query(`SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'ledger' AND a.attname = 'amount'`, [schema]);
      expect(column).toEqual({ type: "numeric" });
      const set = ctx.setByName("Ledger");
      set.add({ id: 1, amount: "0.1" });
      set.add({ id: 2, amount: "0.2" });
      await ctx.saveChanges();
      const [sum] = await provider.query(`SELECT sum(amount)::text AS total FROM "${schema}"."ledger"`, []);
      expect(sum).toEqual({ total: "0.3" });
    } finally { await provider.close(); }
  }, 30_000);
});
