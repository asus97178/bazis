import { afterEach, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, Schema, Nullable } from "@/library/orm";
import { IAccess, AccessModule, AccessPolicy, AttributeLookup, definePermissions, grantsToWhere, type AccessValue, type Condition, type Grants, type PermissionsOf } from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singleton, singletonValue } from "@/core/di";
import { createTestContainer } from "@/core/testing";

// ACCESS-001 §4.3: the list filter and the object check agree on real rows.
const url = process.env.BAZIS_PG_URL;
let schema: string | undefined;

afterEach(async () => {
  if (!url || !schema) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []); }
  finally { await provider.close(); schema = undefined; }
});

class GroupLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) {
    return { column: "kind", in: values.includes("paper") ? ["book", "magazine"] : [] };
  }
}

const permissions = definePermissions({
  "shop.items.read": {
    title: "See items",
    scope: { column: "shopId" },
    on: { status: { type: "string" }, kind: { type: "string" }, group: { type: "string", lookup: GroupLookup } },
    owner: "ownerId",
  },
  "shop.deals.read": {
    title: "See deals",
    on: { total: { type: "number" }, qty: { type: "number" }, weight: { type: "number" } },
  },
});

declare module "@/core/access" {
  interface BazisPermissions extends PermissionsOf<typeof permissions> {}
}

describe.skipIf(!url)("access filters on PostgreSQL (live)", () => {
  test("every row passes the filter exactly when can() allows it", async () => {
    schema = `bazis_access_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "items" })
    class Item {
      @Key() id = 0;
      @Nullable() @Column() shopId: string | null = null;
      @Nullable() @Column() ownerId: string | null = null;
      @Nullable() @Column() status: string | null = null;
      @Nullable() @Column() kind = "";
    }
    class Db extends DbContext { readonly items = this.set(Item); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [Item] }));

    const grants: Grants = [
      { scopes: ["s1", null], where: { any: [{ own: true }, { all: [{ status: { in: ["new", "paid"] } }, { not: { kind: { eq: "secret" } } }] }] } },
      { scopes: "all", where: { all: [{ group: { eq: "paper" } }, { not: { status: { isNull: true } } }] } },
    ];
    @Module({ imports: [AccessModule], permissions, providers: [singleton(GroupLookup), singletonValue(AccessPolicy, new StaticAccessPolicy({ grants: { "user:7": { "shop.items.read": grants } } }))] })
    class AppModule {}

    try {
      await db().database.ensureCreated();
      const ctx = db();
      const shops = ["s1", "s2", null];
      const owners = ["7", "8", null];
      const statuses = ["new", "paid", "cancelled", null];
      const kinds = ["book", "magazine", "secret", "toy"];
      let id = 0;
      for (const shopId of shops) for (const ownerId of owners) for (const status of statuses) for (const kind of kinds) {
        ctx.items.add(Object.assign(new Item(), { id: ++id, shopId, ownerId, status, kind }));
      }
      await ctx.saveChanges();

      const scope = (await createTestContainer(AppModule)).createScope();
      const access = scope.resolve(IAccess).as({ sub: "user:7" }, scope);
      const where = grantsToWhere(await access.filter("shop.items.read"));
      expect(typeof where).toBe("object");
      const listed = (await db().items.asNoTracking().where(() => where as Exclude<typeof where, string>).orderBy((i) => i.id).toList()).map((item) => item.id);

      const all = await db().items.asNoTracking().orderBy((i) => i.id).toList();
      const allowed: number[] = [];
      for (const item of all) {
        const group = item.kind === "book" || item.kind === "magazine" ? "paper" : "other";
        if (await access.can("shop.items.read", { ...item, group, scope: item.shopId })) allowed.push(item.id);
      }
      expect(allowed.length).toBeGreaterThan(0);
      expect(allowed.length).toBeLessThan(all.length);
      expect(listed).toEqual(allowed);
    } finally {
      await provider.close();
    }
  });

  // ACCESS-001 §4.2: a number attribute is compared as a number, exactly, the way the database does it.
  test("number conditions: the filter lists exactly the rows can() allows, for every kind of test", async () => {
    schema = `bazis_access_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
    @Schema(schema) @Entity({ table: "deals" })
    class Deal {
      @Key() id = 0;
      @Nullable() @Column({ type: "decimal", precision: 20, scale: 2 }) total: string | null = null;
      @Nullable() @Column({ type: "integer" }) qty: number | null = null;
      @Nullable() @Column({ type: "real" }) weight: number | null = null;
    }
    class Db extends DbContext { readonly deals = this.set(Deal); }
    const provider = postgres({ url: url! });
    const db = () => new Db(new DbContextOptions({ provider, entities: [Deal] }));

    const conditions: Condition[] = [
      { total: { gt: 100000 } },
      { total: { gte: 100000 } },
      { total: { lt: 100000 } },
      { total: { lte: 100000 } },
      { total: { eq: 100000 } },
      { total: { eq: "12345678901234567.89" } },
      { total: { in: [0, 100000.01, -5.5] } },
      { total: { notIn: [0, 100000] } },
      { total: { isNull: true } },
      { not: { total: { gt: 99999.99 } } },
      { all: [{ total: { gte: 0 } }, { total: { lte: 100000 } }] },
      { any: [{ total: { lt: 0 } }, { qty: { gt: 5 } }] },
      { qty: { gt: 1 } },
      { qty: { lte: 5 } },
      { not: { qty: { lte: 5 } } },
      { weight: { gt: 0.1 } },
      { weight: { lte: 0.1 } },
      { weight: { eq: 0.1 } },
      { all: [{ total: { lte: 100000 } }, { not: { qty: { in: [0, 10] } } }, { weight: { gte: 0.1 } }] },
    ];
    const grants = Object.fromEntries(conditions.map((where, index) => [`user:${index}`, { "shop.deals.read": [{ scopes: "all", where }] satisfies Grants }]));
    @Module({ imports: [AccessModule], permissions, providers: [singleton(GroupLookup), singletonValue(AccessPolicy, new StaticAccessPolicy({ grants }))] })
    class AppModule {}

    try {
      await db().database.ensureCreated();
      const ctx = db();
      const totals = [null, "0.00", "-5.50", "99999.99", "100000.00", "100000.01", "12345678901234567.89"];
      const quantities = [null, 0, 1, 5, 10];
      const weights = [null, 0.1, 0.30000000000000004];
      let id = 0;
      for (const total of totals) for (const qty of quantities) for (const weight of weights) {
        ctx.deals.add(Object.assign(new Deal(), { id: ++id, total, qty, weight }));
      }
      await ctx.saveChanges();
      const all = await db().deals.asNoTracking().orderBy((deal) => deal.id).toList();
      expect(all.length).toBe(totals.length * quantities.length * weights.length);
      // A numeric column comes back as a string: the check must not compare it as text.
      expect(typeof all.find((deal) => deal.total !== null)!.total).toBe("string");

      const container = await createTestContainer(AppModule);
      const scope = container.createScope();
      for (const [index, condition] of conditions.entries()) {
        const access = scope.resolve(IAccess).as({ sub: `user:${index}` }, scope);
        const where = grantsToWhere(await access.filter("shop.deals.read"));
        expect(typeof where, JSON.stringify(condition)).toBe("object");
        const listed = (await db().deals.asNoTracking().where(() => where as Exclude<typeof where, string>).orderBy((deal) => deal.id).toList()).map((deal) => deal.id);
        const allowed: number[] = [];
        for (const deal of all) if (await access.can("shop.deals.read", { ...deal })) allowed.push(deal.id);
        expect(allowed.length, JSON.stringify(condition)).toBeGreaterThan(0);
        expect(allowed.length, JSON.stringify(condition)).toBeLessThan(all.length);
        expect(listed, JSON.stringify(condition)).toEqual(allowed);
      }
      await scope.dispose();
      await container.dispose();
    } finally {
      await provider.close();
    }
  }, 60_000);
});
