import { describe, expect, test } from "bun:test";
import {
  Column, DbContext, DbContextOptions, Entity, EntityState, HasConversion,
  Key, ManyToOne, PostgresProvider, Schema, UUID, type Row,
} from "../index";

// Explicitly opt in on an owner-approved disposable database. This suite
// creates and drops only its own random schema; without the opt-in env it runs no SQL.
const url = process.env.OSNV_PG_URL;
const enabled = !!url && process.env.OSNV_ORM_REGRESSIONS_LIVE === "1";
class Context extends DbContext {}

async function withFixture(work: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try { await work(fixture); }
  finally {
    try { await fixture.provider.execute(`DROP SCHEMA IF EXISTS ${fixture.quotedSchema} CASCADE`, []); }
    finally { await fixture.provider.close(); }
  }
}
async function createFixture() {
  const schema = `osnv_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  const provider = new PostgresProvider({ url });
  const quotedSchema = provider.dialect.quoteId(schema);
  @Schema(schema) @Entity({ table: "parents" })
  class Parent {
    @UUID() id = "";
    @Column({ type: "text", name: "label.external" }) label = "parent";
  }
  @Schema(schema) @Entity({ table: "children" })
  class Child {
    @Key() id = 0;
    @Column({ type: "uuid", name: "parent.uuid" }) parentId: string | null = null;
    @ManyToOne(() => Parent, { foreignKey: "parentId" }) parent?: Parent;
  }
  @Schema(schema) @Entity({ table: "empty_rows" })
  class Empty { @Key() id = 0; }
  @Schema(schema) @Entity({ table: "broken_rows" })
  class Broken {
    @Key({ generated: false }) id = 1;
    @Column({ type: "text" })
    @HasConversion({ toProvider() { throw new Error("audit conversion failed"); }, fromProvider(value: unknown) { return value; } })
    value = "broken";
  }
  @Schema(schema) @Entity({ table: "date_parents" })
  class DateParent {
    @Key({ generated: false }) @Column({ type: "datetime" }) id = new Date(0);
  }
  @Schema(schema) @Entity({ table: "date_children" })
  class DateChild {
    @Key({ generated: false }) id = 1;
    @Column({ type: "datetime" }) parentId = new Date(0);
    @ManyToOne(() => DateParent, { foreignKey: "parentId" }) parent?: DateParent;
  }
  const entities = [Parent, Child, Empty, Broken, DateParent, DateChild];
  const context = new Context(new DbContextOptions({ provider, entities, validateOnSave: false,
    executionStrategy: { maxRetries: 2, baseDelayMs: 0 } }));
  try { await context.database.ensureCreated(); }
  catch (error) {
    try { await provider.execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`, []); }
    finally { await provider.close(); }
    throw error;
  }
  return { provider, context, schema, quotedSchema, Parent, Child, Empty, Broken, DateParent, DateChild };
}

describe.skipIf(!enabled)("ORM regressions on disposable PostgreSQL", () => {
  test("caught conversion error rolls back earlier real INSERTs", async () => withFixture(async f => {
    const parent = new f.Parent(); f.context.add(parent); f.context.add(new f.Broken());
    await expect(f.context.database.transaction(async () => {
      await expect(f.context.saveChanges()).rejects.toThrow("audit conversion failed");
    })).rejects.toThrow("audit conversion failed");
    expect(await f.provider.query(`SELECT id FROM ${f.quotedSchema}.parents`, [])).toHaveLength(0);
    expect(parent.id).toBe(""); expect(f.context.stateOf(parent)).toBe(EntityState.Added);
  }));

  test("UUID FK roundtrip, dotted identifiers, and locked reload preserve edits", async () => withFixture(async f => {
    const parent = new f.Parent(); f.context.add(parent); await f.context.saveChanges();
    const child = new f.Child(); child.parentId = parent.id; f.context.add(child); await f.context.saveChanges();
    const loaded = await f.context.setOf(f.Child).include(c => c.parent).asNoTracking().first();
    expect(loaded.parent?.id).toBe(parent.id);
    expect(loaded.parent?.label).toBe("parent");
    const tracked = await f.context.setOf(f.Parent).where(p => p.label.eq("parent")).first();
    tracked.label = "unsaved edit";
    await expect(f.context.database.transaction(() => f.context.setOf(f.Parent).findForUpdate(parent.id))).rejects.toThrow("pending tracked changes");
    expect(tracked.label).toBe("unsaved edit");
    expect(await f.context.saveChanges()).toBe(1);
    expect((await f.provider.query(`SELECT "label.external" FROM ${f.quotedSchema}.parents`, []))[0]?.["label.external"]).toBe("unsaved edit");
    await f.context.database.ensureCreated();
  }));

  test("exact admission rejects real GENERATED ALWAYS drift", async () => withFixture(async f => {
    await f.provider.execute(`ALTER TABLE ${f.quotedSchema}.empty_rows ALTER COLUMN id SET GENERATED ALWAYS`, []);
    await expect(f.context.database.ensureCreated()).rejects.toMatchObject({ code: "ORM_SCHEMA_CATALOG_UNSUPPORTED" });
  }));

  test("Date key include and multiple DEFAULT VALUES inserts roundtrip", async () => withFixture(async f => {
    f.context.add(new f.DateParent()); f.context.add(new f.DateChild());
    const rows = [new f.Empty(), new f.Empty()]; f.context.setOf(f.Empty).addRange(rows);
    expect(await f.context.saveChanges()).toBe(4);
    expect(rows[0]!.id).toBeGreaterThan(0); expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
    const child = await f.context.setOf(f.DateChild).include(c => c.parent).asNoTracking().first();
    expect(child.parent?.id.getTime()).toBe(0);
  }));

  test("a client fault after real server COMMIT never duplicates the saved row", async () => withFixture(async f => {
    type Session = { unsafe(sql: string, params?: readonly unknown[]): Promise<Row[]>; release(): void | Promise<void>; close?(options?: { timeout?: number }): Promise<void> };
    type Root = Session & { reserve(): Promise<Session>; close(): Promise<void> };
    const root = (f.provider as unknown as { sql: Root }).sql;
    let inserts = 0;
    Object.defineProperty(f.provider, "sql", { configurable: true, value: {
      unsafe: root.unsafe.bind(root), close: root.close.bind(root),
      async reserve() {
        const session = await root.reserve();
        return {
          release: session.release.bind(session), close: session.close?.bind(session),
          async unsafe(sql: string, params?: readonly unknown[]) {
            const result = await session.unsafe(sql, params);
            if (sql.startsWith("INSERT")) inserts++;
            // Deterministic client-side fault injection after a real commit;
            // this is not a claim of a physical network-disconnect experiment.
            if (sql === "COMMIT") throw new Error("ECONNRESET (audit injected after server commit)");
            return result;
          },
        };
      },
    } });
    f.context.add(new f.Empty());
    await expect(f.context.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
    expect(await f.provider.query(`SELECT id FROM ${f.quotedSchema}.empty_rows`, [])).toHaveLength(1);
    await expect(f.context.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
    expect(inserts).toBe(1);
  }));
});
