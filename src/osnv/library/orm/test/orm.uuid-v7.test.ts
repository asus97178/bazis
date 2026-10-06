import { describe, expect, test } from "bun:test";
import {
  Column, DbContext, DbContextOptions, DbUpdateError, Entity, ForeignKey, ModelBuilder, OrmModel,
  PostgresDialect, UUID, buildDynamicModel, type DatabaseProvider, type Row, type SqlParam,
} from "../index";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Entity({ table: "v7_orders" })
class Order {
  @UUID({ version: "v7" }) id = "";
  @Column({ type: "text" }) name = "";
}

@Entity({ table: "v7_order_lines" })
class OrderLine {
  @UUID({ version: "v7" }) id = "";
  @ForeignKey(() => Order) @Column({ type: "text" }) orderId = "";
}

@Entity({ table: "v4_orders" })
class LegacyOrder {
  @UUID() id = "";
}

class Context extends DbContext {
  readonly orders = this.set(Order);
}

function fixture() {
  const statements: Array<{ sql: string; params: readonly SqlParam[] }> = [];
  const provider: DatabaseProvider = {
    name: "uuid-v7-recording", dialect: new PostgresDialect(),
    async query(sql, params) { statements.push({ sql, params }); return [] as Row[]; },
    async execute(sql, params) { statements.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; },
    async transaction(work) { return work(provider); },
    async introspect() { return { tables: new Map() }; }, async ping() { return true; }, async close() {},
  };
  const db = new Context(new DbContextOptions({ provider, entities: [Order], validateOnSave: false }));
  return { db, statements };
}

describe("UUID v7 primary keys", () => {
  test("@UUID({ version: 'v7' }) builds an ORM-generated key without a database default", () => {
    const key = ModelBuilder.build(Order).key[0];
    expect(key.generation).toBe("uuidV7");
    expect(key.convention).toBeUndefined();
    expect(key.databaseDefault).toEqual({ kind: "none" });
    expect(ModelBuilder.build(LegacyOrder).key[0].generation).toBe("uuid");
  });

  test("DDL declares a native uuid key without gen_random_uuid()", () => {
    const dialect = new PostgresDialect();
    const sql = dialect.createTableSql(ModelBuilder.build(Order), []);
    expect(sql).toContain(`"id" uuid NOT NULL PRIMARY KEY`);
    expect(sql).not.toContain("gen_random_uuid");
    expect(dialect.createTableSql(ModelBuilder.build(LegacyOrder), [])).toContain("DEFAULT gen_random_uuid()");
  });

  test("the expected schema has a native uuid key and propagates uuid to foreign keys", () => {
    const tables = compileExpectedSchema(new OrmModel([Order, OrderLine])).tables;
    const column = (table: string, name: string) => tables.find((item) => item.table === table)!.columns.find((item) => item.column === name)!;
    expect(column("v7_orders", "id")).toMatchObject({ physicalType: "uuid", generation: "none", default: { kind: "none" }, nullable: false });
    expect(column("v7_order_lines", "orderId")).toMatchObject({ physicalType: "uuid", generation: "none" });
  });

  test("saveChanges assigns distinct v7 keys before INSERT and sends them as parameters", async () => {
    const { db, statements } = fixture();
    const first = db.orders.add(Object.assign(new Order(), { name: "first" }));
    const second = db.orders.add(Object.assign(new Order(), { name: "second" }));
    expect(await db.saveChanges()).toBe(2);
    expect(first.id).toMatch(UUID_V7);
    expect(second.id).toMatch(UUID_V7);
    expect(first.id).not.toBe(second.id);
    const insert = statements.find((item) => item.sql.startsWith("INSERT"))!;
    expect(insert.sql).not.toContain("RETURNING");
    expect(insert.params).toEqual([first.id, "first", second.id, "second"]);
  });

  test("a key set by the application is kept", async () => {
    const { db, statements } = fixture();
    const id = Bun.randomUUIDv7();
    db.orders.add(Object.assign(new Order(), { id, name: "manual" }));
    await db.saveChanges();
    expect(statements.find((item) => item.sql.startsWith("INSERT"))!.params).toEqual([id, "manual"]);
  });

  test("duplicate keys are rejected before any SQL", async () => {
    const { db, statements } = fixture();
    const id = Bun.randomUUIDv7();
    db.orders.add(Object.assign(new Order(), { id }));
    db.orders.add(Object.assign(new Order(), { id }));
    await expect(db.saveChanges()).rejects.toBeInstanceOf(DbUpdateError);
    expect(statements).toHaveLength(0);
  });

  test("a dynamic table key with uuidVersion v7 is ORM-generated, not a v4 database default", () => {
    const model = buildDynamicModel({ name: "DynamicV7", fields: [{ name: "id", type: "uuid", isKey: true, uuidVersion: "v7" }] });
    expect(model.key[0].generation).toBe("uuidV7");
    expect(model.key[0].databaseDefault).toEqual({ kind: "none" });
    const v4 = buildDynamicModel({ name: "DynamicV4", fields: [{ name: "id", type: "uuid", isKey: true }] });
    expect(v4.key[0].generation).toBe("uuid");
  });
});
