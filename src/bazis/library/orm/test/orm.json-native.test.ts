import { expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, OrmUnsafeImmediateMutationError, PostgresDialect, type DatabaseProvider, type SqlParam } from "../index";

@Entity({ table: "native_json_rows" })
class JsonRow {
  @Key({ generated: false }) id = 1;
  @Column({ type: "json" }) data: unknown = null;
}
class Context extends DbContext { readonly rows = this.set(JsonRow); }

const values = ["123", "false", "null", '{"role":"reader"}', '[1,2]', '"quoted"', "ordinary text", "", 123, 0, -7, 3.25, false, true, null, [1, "false"], { value: "null" }];
for (const data of values) {
  test(`Bun-native JSON value survives entity and projection materialization: ${JSON.stringify(data)}`, async () => {
    const provider: DatabaseProvider = {
      name: "native-json-recording", dialect: new PostgresDialect(),
      async query() { return [{ id: 1, data }]; },
      async execute() { throw new Error("Unexpected write in read-only native JSON fixture."); },
      async transaction(work) { return work(provider); },
      async introspect() { return { tables: new Map() }; }, async ping() { return true; }, async close() {},
    };
    const db = new Context(new DbContextOptions({ provider, entities: [JsonRow] }));
    const entity = await db.rows.first();
    const projected = await db.rows.select(row => ({ data: row.data })).first();
    expect(entity.data).toEqual(data);
    expect(projected.data).toEqual(data);
    expect(await db.saveChanges()).toBe(0);
  });
}

function recordingContext(dialect = new PostgresDialect()) {
  const writes: Array<{ sql: string; params: readonly SqlParam[] }> = [];
  const provider: DatabaseProvider = {
    name: "native-json-recording", dialect,
    async query() { return []; },
    async execute(sql, params) { writes.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; },
    async transaction(work) { return work(provider); },
    async introspect() { return { tables: new Map() }; }, async ping() { return true; }, async close() {},
  };
  return { db: new Context(new DbContextOptions({ provider, entities: [JsonRow] })), writes };
}

for (const data of [0, -7, 3.25, true, false]) {
  test(`save and immediate mutations bind JSON scalar ${data} as JSON without changing its value`, async () => {
    const { db, writes } = recordingContext();
    db.rows.add(Object.assign(new JsonRow(), { data }));
    expect(await db.saveChanges()).toBe(1);
    db.changeTracker.clear();
    expect(await db.rows.asNoTracking().where(row => row.id.eq(1)).executeUpdate({ data })).toEqual({ affectedRows: 1 });
    expect(await db.rows.insertIfAbsent(Object.assign(new JsonRow(), { id: 2, data }), { conflictBy: row => [row.id] })).toEqual({ inserted: true });
    const encoded = [writes[0]!.params[1], writes[1]!.params[0], writes[2]!.params[1]];
    for (const parameter of encoded) {
      // The native driver's type inference requires an object for JSON binding;
      // its JSON serializer must still transmit the original primitive.
      expect(typeof parameter).toBe("object");
      expect(Object.isFrozen(parameter)).toBe(true);
      expect(JSON.parse(JSON.stringify(parameter))).toBe(data);
    }
  });
}

test("the native scalar binding does not admit user or dialect toJSON hooks", async () => {
  let calls = 0;
  const hook = { toJSON() { calls++; return false; } };
  const { db, writes } = recordingContext();
  for (const data of [hook, Object.create(hook), () => false]) {
    await expect(db.rows.asNoTracking().where(row => row.id.eq(1)).executeUpdate({ data })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
    await expect(db.rows.insertIfAbsent(Object.assign(new JsonRow(), { data }), { conflictBy: row => [row.id] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  }
  const dialect = new PostgresDialect();
  dialect.encode = () => hook;
  const forged = recordingContext(dialect);
  await expect(forged.db.rows.asNoTracking().where(row => row.id.eq(1)).executeUpdate({ data: false })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(calls).toBe(0);
  expect(writes).toEqual([]);
  expect(forged.writes).toEqual([]);
});
