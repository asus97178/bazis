import { expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, Schema, postgres } from "../index";

const enabled = process.env.OSNV_ORM_REPEAT_AUDIT_LIVE === "1";
const values: unknown[] = ["123", "false", "null", '{"role":"reader"}', '[1,2]', '"quoted"', "ordinary text", "", 123, 0, -7, 3.25, false, true, null, [1, "false"], { value: "null" }];

function fixtureUrl(): string {
  const raw = process.env.OSNV_PG_URL;
  if (!enabled || !raw) throw new Error("Native JSON regression requires its owned disposable PostgreSQL guard and URL.");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || !url.port || url.port === "5432" || url.pathname !== "/orm_audit") {
    throw new Error("Native JSON regression only accepts orm_audit on a dedicated non-default 127.0.0.1 port.");
  }
  return raw;
}

async function withFixture(work: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try { await work(fixture); } finally { await fixture.close(); }
}

async function createFixture() {
  const schema = `native_json_${crypto.randomUUID().replaceAll("-", "")}`;
  const provider = postgres({ url: fixtureUrl(), operationTimeoutMs: 5_000 });
  let created = false;
  async function close() {
    try { if (created) await provider.execute(`DROP SCHEMA "${schema}" CASCADE`, []); }
    finally { await provider.close(); }
  }
  @Entity({ table: "rows" }) @Schema(schema)
  class JsonRow {
    @Key({ generated: false }) id = 0;
    @Column({ type: "json", nullable: true }) data: unknown = null;
  }
  class Context extends DbContext { readonly rows = this.set(JsonRow); }
  try {
    await provider.execute(`CREATE SCHEMA "${schema}"`, []); created = true;
    await provider.execute(`CREATE TABLE "${schema}"."rows" (id bigint PRIMARY KEY, data jsonb)`, []);
    const options = new DbContextOptions({ provider, entities: [JsonRow] });
    return { provider, schema, JsonRow, context: () => new Context(options), close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "JSON fixture setup and cleanup failed."); }
    throw error;
  }
}

if (!enabled) {
  test.skip("SKIP — native JSON PostgreSQL regression requires OSNV_ORM_REPEAT_AUDIT_LIVE=1 and dedicated OSNV_PG_URL", () => {});
} else {
  test("native JSONB values preserve entity and projection types", async () => withFixture(async ({ provider, schema, context }) => {
    // Constants only: bypass parameter encoding to isolate native result decoding.
    for (const [index, value] of values.entries()) {
      const literal = JSON.stringify(value).replaceAll("'", "''");
      await provider.execute(`INSERT INTO "${schema}"."rows" VALUES (${index + 1}, '${literal}'::jsonb)`, []);
    }
    const db = context();
    expect((await db.rows.orderBy(row => row.id).toList()).map(row => row.data)).toEqual(values);
    expect((await db.rows.orderBy(row => row.id).select(row => ({ data: row.data })).toList()).map(row => row.data)).toEqual(values);
    expect(await db.saveChanges()).toBe(0);
  }), 30_000);

  test("ORM JSONB insert and update round-trip scalar strings through fresh contexts", async () => withFixture(async ({ JsonRow, context }) => {
    const writer = context();
    writer.rows.addRange(values.map((data, index) => Object.assign(new JsonRow(), { id: index + 1, data })));
    expect(await writer.saveChanges()).toBe(values.length);
    const reader = context();
    const stored = await reader.rows.orderBy(row => row.id).toList();
    expect(stored.map(row => row.data)).toEqual(values);
    const changed = values.map((_value, index) => values[(index + 1) % values.length]);
    stored.forEach((row, index) => { row.data = changed[index]; });
    expect(await reader.saveChanges()).toBe(values.length);
    expect((await context().rows.orderBy(row => row.id).select(row => ({ data: row.data })).toList()).map(row => row.data)).toEqual(changed);
  }), 30_000);

  test("immediate JSONB insert and update retain scalar number and boolean types", async () => withFixture(async ({ JsonRow, context }) => {
    const scalars = [0, -7, 3.25, true, false];
    for (const [index, data] of scalars.entries()) {
      const db = context();
      const row = Object.assign(new JsonRow(), { id: index + 1, data });
      expect(await db.rows.insertIfAbsent(row, { conflictBy: item => [item.id] })).toEqual({ inserted: true });
    }
    expect((await context().rows.orderBy(row => row.id).toList()).map(row => row.data)).toEqual(scalars);
    for (const [index] of scalars.entries()) {
      expect(await context().rows.asNoTracking().where(row => row.id.eq(index + 1)).executeUpdate({ data: scalars[(index + 1) % scalars.length] })).toEqual({ affectedRows: 1 });
    }
    expect((await context().rows.orderBy(row => row.id).select(row => ({ data: row.data })).toList()).map(row => row.data)).toEqual(scalars.map((_value, index) => scalars[(index + 1) % scalars.length]));
  }), 30_000);
}
