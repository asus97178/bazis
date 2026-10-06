import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, ForeignKey, Schema, UUID, postgres } from "../index";

/**
 * Live check of UUID v7 keys: exact `ensureCreated` admission (first run and
 * replay), native `uuid` columns without a default, ORM-assigned keys, and a
 * foreign key to a v7 key. Runs only when `BAZIS_PG_URL` is set; creates and
 * drops its own random schema.
 */
const url = process.env.BAZIS_PG_URL;
const SCHEMA = `bazis_uuid_v7_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 63);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Schema(SCHEMA) @Entity({ table: "orders" })
class Order {
  @UUID({ version: "v7" }) id = "";
  @Column({ type: "text" }) name = "";
}

@Schema(SCHEMA) @Entity({ table: "order_lines" })
class OrderLine {
  @UUID({ version: "v7" }) id = "";
  @ForeignKey(() => Order) @Column({ type: "text" }) orderId = "";
}

class Context extends DbContext {
  readonly orders = this.set(Order);
  readonly lines = this.set(OrderLine);
}

const providers: ReturnType<typeof postgres>[] = [];
function context(): Context {
  const provider = postgres({ url });
  providers.push(provider);
  return new Context(new DbContextOptions({ provider, entities: [Order, OrderLine] }));
}

afterAll(async () => {
  if (!url) return;
  const provider = postgres({ url });
  try { await provider.execute(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`, []); }
  finally {
    await provider.close();
    for (const item of providers) await item.close();
  }
});

describe.skipIf(!url)("PostgreSQL UUID v7 keys (live)", () => {
  test("ensureCreated admits v7 tables, and saved keys round-trip as native uuid", async () => {
    const db = context();
    await db.database.ensureCreated();
    // Replay: the second admission verifies the existing schema exactly.
    await context().database.ensureCreated();

    const columns = await db.database.querySqlRaw(
      `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = {0} AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('id', 'orderId') ORDER BY 1, 2`,
      SCHEMA,
    );
    expect(columns).toEqual([
      { table_name: "order_lines", column_name: "id", type: "uuid", default_expr: null },
      { table_name: "order_lines", column_name: "orderId", type: "uuid", default_expr: null },
      { table_name: "orders", column_name: "id", type: "uuid", default_expr: null },
    ]);

    const order = db.orders.add(Object.assign(new Order(), { name: "first" }));
    await db.saveChanges();
    expect(order.id).toMatch(UUID_V7);
    const line = db.lines.add(Object.assign(new OrderLine(), { orderId: order.id }));
    await db.saveChanges();
    expect(line.id).toMatch(UUID_V7);

    const fresh = context();
    expect((await fresh.orders.find(order.id))?.name).toBe("first");
    expect((await fresh.lines.find(line.id))?.orderId).toBe(order.id);
  }, 30_000);
});
