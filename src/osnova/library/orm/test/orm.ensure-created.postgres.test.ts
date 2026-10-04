import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, ForeignKey, Key, Required, Schema, type DatabaseProvider } from "../index";

@Schema("zeta") @Entity({ table: "parents" }) class Parent { @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; }
@Schema("alpha") @Entity({ table: "children" }) @ForeignKey(() => Parent, { properties: ["tenant", "parentId"] }) class Child { @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = ""; @Column({ type: "text" }) id = ""; @Required() @Column({ type: "text" }) parentId = ""; }
class Context extends DbContext {}
@Entity({ table: "cycle_a" }) class CycleA { @Key() @Column({ type: "integer" }) id = 0; @ForeignKey(() => CycleB) @Column({ type: "integer" }) bId = 0; }
@Entity({ table: "cycle_b" }) class CycleB { @Key() @Column({ type: "integer" }) id = 0; @ForeignKey(() => CycleA) @Column({ type: "integer" }) aId = 0; }

describe("PostgreSQL ensure-created recording admission", () => {
  test("sorts schemas, creates all missing tables before cyclic FKs, and replay is DDL-free", async () => {
    const log: string[] = []; let created = false;
    const provider = recording(log, () => created, () => { created = true; });
    const context = new Context(new DbContextOptions({ provider, entities: [Parent, Child] }));
    await context.database.ensureCreated();
    expect(log.filter((x) => x.startsWith("CREATE SCHEMA")).map((x) => x.match(/"([^"]+)"/)?.[1])).toEqual(["alpha", "zeta"]);
    const firstFk = log.findIndex((x) => x.startsWith("ALTER TABLE"));
    expect(log.filter((x) => x.startsWith("CREATE TABLE")).every((x) => log.indexOf(x) < firstFk)).toBeTrue();
    log.length = 0; await context.database.ensureCreated();
    expect(log.filter((x) => /^(CREATE|ALTER)/.test(x))).toEqual([]);
  });
  test("creates both sides of a real scalar FK cycle before either FK ALTER", async () => {
    const log: string[] = []; let created = false; const provider = recording(log, () => created, () => { created = true; });
    await new Context(new DbContextOptions({ provider, entities: [CycleA, CycleB] })).database.ensureCreated();
    const creates = log.map((entry, index) => entry.startsWith("CREATE TABLE") ? index : -1).filter((index) => index >= 0);
    const alters = log.map((entry, index) => entry.startsWith("ALTER TABLE") ? index : -1).filter((index) => index >= 0);
    expect(creates).toHaveLength(2); expect(alters).toHaveLength(2); expect(Math.max(...creates)).toBeLessThan(Math.min(...alters));
  });
  test("capability absence maps safely without legacy fallback", async () => {
    const provider = { ...recording([], () => false, () => undefined), schemaAdmissionCapability: undefined } as DatabaseProvider;
    const context = new Context(new DbContextOptions({ provider, entities: [Parent] }));
    await expect(context.database.ensureCreated()).rejects.toMatchObject({ code: "ORM_SCHEMA_PROVIDER_UNSUPPORTED" });
  });
});

function recording(log: string[], isCreated: () => boolean, markCreated: () => void): DatabaseProvider {
  const scope = { query: async (sql: string, params: readonly unknown[]) => { if (sql.includes("pg_namespace")) { log.push(`schema:${params[0]}`); return []; } return []; }, execute: async (sql: string) => { log.push(sql); if (sql.startsWith("CREATE TABLE")) markCreated(); return { changes: 0, lastInsertId: 0 }; }, introspectExpected: async (expected: any) => isCreated() ? { tables: new Map(expected.tables.map((t: any) => [`${t.schema}.${t.table}`, { name: t.table, columns: new Map(t.columns.map((c: any) => [c.column, { name: c.column, notNull: !c.nullable, isPrimaryKey: true, physicalType: c.physicalType, default: c.default, generation: c.generation }])), indexes: [], primaryKey: t.primaryKey, foreignKeys: t.foreignKeys.map((fk: any) => ({ name: fk.name, columns: fk.columns, targetSchema: fk.target.schema, targetTable: fk.target.table, targetColumns: fk.targetColumns, onDelete: fk.onDelete, onUpdate: fk.onUpdate })), checks: t.checks }])) } : { tables: new Map() } };
  return { name: "postgres", dialect: { name: "postgres" } as any, query: scope.query as any, execute: scope.execute as any, transaction: async (work: any) => work(scope), ping: async () => true, close: async () => undefined, introspect: async () => ({ tables: new Map() }), schemaAdmissionCapability: { version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true, withSchemaAdmission: async (_schemas: readonly string[], work: any) => work(scope) } };
}
