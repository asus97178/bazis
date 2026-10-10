import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";
import { Column, CreatedAt, DbContext, DbContextOptions, Entity, EntityState, HasConversion, Index, Key, Operand, OrmError, OrmTrackedMutationConflictError, OrmTransactionScopeError, OrmUndeclaredConflictTargetError, OrmUnsafeImmediateMutationError, QueryFilter, SoftDelete, UpdatedAt, UUID, ValueConverters, withRetry, type DatabaseProvider, type DbExecutor, type ExecuteResult, type Row, type SqlDialect } from "../index";
import { observeProviderDispatch, registerPostgresTransactionCapability } from "../Providers/ormTransactionRuntime";
import { runPostCommitCallbacks, runRollbackCallbacks } from "../Providers/transactionCallbacks";
import { assertTransactionCanCommit, beginChildTransactionScope, createTransactionCallbackScope, endChildTransactionScope, mergeTransactionScopeCallbacks, type TransactionCallbackScope } from "../Providers/transactionScopes";

@Entity({ table: "immediate_rows" })
@Index(["name"], { unique: true })
class RowEntity {
  @Key()
  @Column({ type: "integer" })
  id!: number;
  @Column()
  name!: string;
  @Column({ nullable: true })
  note?: string | null;
}
let converterCalls = 0;
let reentrantContext: Context | undefined;
@Entity()
class ConvertedRow {
  @Key({ generated: false }) id = 0;
  @HasConversion({ toProvider(value: Date | null) { converterCalls += 1; if (value === null) return null; reentrantContext?.attach(Object.assign(new ConvertedRow(), { id: 99, value: new Date(0) })); value.setTime(0); return value.toISOString(); }, fromProvider: (value: string) => new Date(value) })
  @Column({ type: "text" }) value = new Date(1);
}
@Entity({ table: "filtered_rows" })
@QueryFilter<FilteredRow>((row) => row.tenant.eq("tenant"))
class FilteredRow { @Key({ generated: false }) id = 0; @Column() tenant = "tenant"; @Column() name = ""; @SoftDelete() deletedAt: Date | null = null; }
@Entity({ table: "immediate_key_rows" })
@Index(["externalKey", "tenantKey"], { unique: true })
@Index(["tenantKey", "payload"], { unique: false })
class KeyRow {
  @Key(["tenantKey", "sequence"]) @Column({ name: "tenant_key", type: "text" }) tenantKey = "";
  @Column({ name: "sequence_no", type: "integer" }) sequence = 0;
  @Column({ name: "external_key", type: "text" }) externalKey = "";
  @Column({ name: "payload_text", type: "text" }) payload = "";
}
@Entity({ table: "immediate_identity_rows" })
class IdentityRow { @Key() @Column({ name: "identity_id", type: "integer" }) id = 0; @Column({ name: "identity_value", type: "text" }) value = ""; }
@Entity({ table: "immediate_uuid_rows" })
class UuidLiteralRow { @UUID() @Column({ name: "uuid_id", type: "uuid" }) id = ""; @Column({ name: "uuid_value", type: "text" }) value = ""; }
@Entity({ table: "immediate_rules_rows" })
class RulesRow { @Key() @Column({ type: "integer" }) id = 0; @CreatedAt() createdAt = new Date(0); @UpdatedAt() updatedAt = new Date(0); @Column({ type: "text" }) plain = ""; }
let jsonConverterCalls = 0; let jsonConverterInput: unknown;
const controlledJsonConverter = { toProvider(value: { nested: { value: number | null }; items: unknown[] }) { jsonConverterCalls += 1; jsonConverterInput = value; value.nested.value = 99; value.items.push("converter"); return { stored: value }; }, fromProvider: (value: unknown) => value as { nested: { value: number | null }; items: unknown[] } };
@Entity({ table: "immediate_json_rows" })
class JsonRow { @Key({ generated: false }) id = 0; @HasConversion(controlledJsonConverter) @Column({ type: "json" }) payload: { nested: { value: number | null }; items: unknown[] } = { nested: { value: 0 }, items: [] }; }
let bytesConverterCalls = 0;
const bytesConverter = { toProvider(value: Uint8Array) { bytesConverterCalls += 1; value[0] = 9; return `${value[0]},${value[1]}`; }, fromProvider: (value: string) => new Uint8Array(value.split(",").map(Number)) };
@Entity({ table: "immediate_bytes_rows" })
class BytesRow { @Key({ generated: false }) id = 0; @HasConversion(bytesConverter) @Column({ type: "text" }) payload = new Uint8Array([1, 2]); }
let dateOutput: Date | undefined;
const datetimeConverter = { toProvider(value: Date) { dateOutput = new Date(value.getTime()); return dateOutput; }, fromProvider: (value: Date) => value };
@Entity({ table: "immediate_datetime_rows" })
class DatetimeRow { @Key({ generated: false }) id = 0; @HasConversion(datetimeConverter) @Column({ type: "datetime" }) at = new Date(0); }
let nullableConverterCalls = 0;
const nullableConverter = { toProvider(value: string) { nullableConverterCalls += 1; return `enc:${value}`; }, fromProvider: (value: string) => value.slice(4) };
@Entity({ table: "immediate_nullable_rows" })
class NullableConvertedRow { @Key({ generated: false }) id = 0; @HasConversion(nullableConverter) @Column({ type: "text", nullable: true }) value: string | null = null; }
@Entity({ table: "immediate_json_text_rows" })
class JsonTextRow { @Key({ generated: false }) id = 0; @HasConversion(ValueConverters.json<{ nested: string[] }>()) @Column({ type: "text" }) payload: { nested: string[] } = { nested: [] }; }
const dialect: SqlDialect = { name: "postgres", supportsReturning: false, quoteId: (name) => `"${name}"`, qualifyTable: (model) => `"${model.tableName}"`, parameter: (index) => `$${index + 1}`, columnType: () => "text", encode: (value) => value as never, decode: (value) => value, rowLockClause: () => "", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "" };
const queryLog: { sql: string; params: readonly unknown[] }[] = [];
function provider(log: { sql: string; params: readonly unknown[] }[]): DatabaseProvider { return { name: "test", dialect, query: async (sql, params): Promise<Row[]> => { queryLog.push({ sql, params }); return []; }, execute: async (sql, params): Promise<ExecuteResult> => { log.push({ sql, params }); return { changes: sql.startsWith("INSERT") ? 1 : 2, lastInsertId: 0 }; }, transaction: async (work) => work({ query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }) }), ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {} }; }
type M12Provider = DatabaseProvider & { calls(): number; commits(): number; rollbacks(): number; quarantines(): number; rootCloses(): number; setExecute(work: () => Promise<ExecuteResult>): void; setQuarantine(work: () => Promise<void>): void; };
function m12Provider(): M12Provider {
  let calls = 0; let commits = 0; let rollbacks = 0; let quarantines = 0; let closes = 0; let active = false; let quarantineWork: () => Promise<void> = async () => {}; let executeWork: () => Promise<ExecuteResult> = async () => ({ changes: 1, lastInsertId: 0 }); const scopes = new AsyncLocalStorage<TransactionCallbackScope>();
  const executor: DbExecutor = { query: async () => [], execute: async () => { calls += 1; return executeWork(); } };
  const transaction = async <T>(work: (current: DbExecutor) => Promise<T>): Promise<T> => { const parent = scopes.getStore(); if (parent) { const child = beginChildTransactionScope(parent); try { const value = await scopes.run(child.callbacks, () => work(executor)); assertTransactionCanCommit(child.callbacks); mergeTransactionScopeCallbacks(parent, child.callbacks); return value; } catch (error) { return runRollbackCallbacks(child.callbacks.afterRollback, error); } finally { endChildTransactionScope(parent, child.ownership); } } const callbacks = createTransactionCallbackScope(); active = true; let value!: T; try { value = await scopes.run(callbacks, () => work(executor)); assertTransactionCanCommit(callbacks); commits += 1; } catch (error) { rollbacks += 1; return runRollbackCallbacks(callbacks.afterRollback, error); } finally { active = false; } await runPostCommitCallbacks(callbacks.afterCommit); return value; };
  const value = { name: "postgres", dialect, query: executor.query, execute: executor.execute, transaction, transactionScope: transaction, isTransactionActive: () => active, afterCommit: (callback: () => void | Promise<void>) => { const scope = scopes.getStore(); return scope ? void scope.afterCommit.push(callback) : callback(); }, afterRollback: (callback: () => void | Promise<void>) => { scopes.getStore()?.afterRollback.push(callback); }, ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => { closes += 1; }, calls: () => calls, commits: () => commits, rollbacks: () => rollbacks, quarantines: () => quarantines, rootCloses: () => closes, setExecute: (work: () => Promise<ExecuteResult>) => { executeWork = work; }, setQuarantine: (work: () => Promise<void>) => { quarantineWork = work; } } as M12Provider;
  registerPostgresTransactionCapability(value, { databaseTime: async () => ({ instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" }), assertScopedClose: () => {}, quarantine: async () => { quarantines += 1; await quarantineWork(); } }); return value;
}
class Context extends DbContext { readonly rows = this.set(RowEntity); readonly converted = this.set(ConvertedRow); readonly filtered = this.set(FilteredRow); readonly keyRows = this.set(KeyRow); readonly identities = this.set(IdentityRow); readonly uuidLiterals = this.set(UuidLiteralRow); readonly rules = this.set(RulesRow); readonly json = this.set(JsonRow); readonly bytes = this.set(BytesRow); readonly datetimes = this.set(DatetimeRow); readonly nullable = this.set(NullableConvertedRow); readonly jsonText = this.set(JsonTextRow); constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [RowEntity, ConvertedRow, FilteredRow, KeyRow, IdentityRow, UuidLiteralRow, RulesRow, JsonRow, BytesRow, DatetimeRow, NullableConvertedRow, JsonTextRow] })); } }
class SharedRowsContext extends DbContext { readonly rows = this.set(RowEntity); readonly filtered = this.set(FilteredRow); constructor(options: DbContextOptions) { super(options); } }

test("immediate update and delete render parameterized physical DML", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  const update = await db.rows.asNoTracking().where((row) => row.id.eq(7)).executeUpdate({ name: "next" });
  const deleted = await db.rows.asNoTracking().where((row) => row.id.eq(7)).executeDelete();
  expect(update).toEqual({ affectedRows: 2 }); expect(Object.isFrozen(update)).toBe(true);
  expect(deleted).toEqual({ affectedRows: 2 });
  expect(log[0]).toEqual({ sql: 'UPDATE "immediate_rows" SET "name" = $1 WHERE "id" = $2', params: ["next", 7] });
  expect(log[1]).toEqual({ sql: 'DELETE FROM "immediate_rows" WHERE "id" = $1', params: [7] });
});
test("reject missing explicit predicate and unsafe update values before dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  await expect(db.rows.asNoTracking().executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  await expect(db.rows.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ id: 2 })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(log).toEqual([]);
});
test("insert requires a declared exact conflict target", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const entity = Object.assign(new RowEntity(), { id: 1, name: "a", note: null });
  const inserted = await db.rows.insertIfAbsent(entity, { conflictBy: (row) => [row.id] }); expect(inserted).toEqual({ inserted: true });
  expect(log[0]?.sql).toBe('INSERT INTO "immediate_rows" ("id", "name", "note") VALUES ($1, $2, $3) ON CONFLICT ("id") DO NOTHING');
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: (row) => [row.name, row.id] })).rejects.toBeInstanceOf(OrmUndeclaredConflictTargetError);
});
test("same-model tracked entries block immediate DML", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); db.rows.attach(Object.assign(new RowEntity(), { id: 1, name: "a" }));
  await expect(db.rows.asNoTracking().where((row) => row.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmTrackedMutationConflictError); expect(log).toEqual([]);
});
test("descriptor, proxy and cyclic input are rejected before SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let reads = 0;
  const accessor = Object.create(null); Object.defineProperty(accessor, "name", { enumerable: true, get() { reads += 1; return "x"; } });
  await expect(db.rows.asNoTracking().where((row) => row.id.eq(1)).executeUpdate(accessor)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  const cyclic: { nested?: unknown } = {}; cyclic.nested = cyclic;
  // @ts-expect-error exercise malformed JavaScript input despite the typed DSL
  await expect(db.rows.asNoTracking().where((row) => row.id.eq(cyclic)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(reads).toBe(0); expect(log).toEqual([]);
});
test("foreign, duplicate and sparse selector results have no dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const entity = Object.assign(new RowEntity(), { id: 1, name: "a", note: null });
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: () => [new Operand("id")] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: (row) => [row.id, row.id] })).rejects.toBeInstanceOf(OrmUndeclaredConflictTargetError);
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: () => { const sparse: unknown[] = []; sparse.length = 1; return sparse as never; } })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  let proxyTrap = 0; const proxyOperand = new Proxy(new Operand("id"), { getPrototypeOf() { proxyTrap += 1; return Operand.prototype; } });
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: () => [proxyOperand] as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(proxyTrap).toBe(0);
  expect(log).toEqual([]);
});
test("converter receives an isolated mutable Date copy exactly once", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const original = new Date(1234); converterCalls = 0;
  await db.converted.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ value: original });
  expect(converterCalls).toBe(1); expect(original.getTime()).toBe(1234); expect(log[0]?.params).toEqual(["1970-01-01T00:00:00.000Z", 1]);
});
test("late invalid update input prevents every converter call", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); converterCalls = 0;
  await expect(db.converted.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ value: new Date(1), unknown: "late" } as never)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("intrinsic and inherited toJSON failures are safe before converter", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); converterCalls = 0;
  const original = Object.getOwnPropertyDescriptor(Date.prototype, "toJSON")!; let reads = 0;
  try {
    Object.defineProperty(Date.prototype, "toJSON", { configurable: true, get() { reads += 1; return original.value; } });
    await expect(db.converted.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ value: new Date(1) })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  } finally { Object.defineProperty(Date.prototype, "toJSON", original); }
  const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { return "hook"; } });
    await expect(db.converted.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ value: { nested: 1 } as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  } finally { if (inherited) Object.defineProperty(Object.prototype, "toJSON", inherited); else delete (Object.prototype as { toJSON?: unknown }).toJSON; }
  await expect(db.converted.asNoTracking().where((row) => row.id.eq(1)).executeUpdate({ value: Object.create(Date.prototype) as Date })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(reads).toBe(0); expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("effective global, soft-delete and explicit conditions have exact order; ignore removes only filters", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  await db.filtered.asNoTracking().where((row) => row.id.eq(7)).executeUpdate({ name: "n" });
  await db.filtered.asNoTracking().ignoreQueryFilters().where((row) => row.id.eq(7)).executeDelete();
  expect(log[0]).toEqual({ sql: 'UPDATE "filtered_rows" SET "name" = $1 WHERE "tenant" = $2 AND "deletedAt" IS NULL AND "id" = $3', params: ["n", "tenant", 7] });
  expect(log[1]).toEqual({ sql: 'DELETE FROM "filtered_rows" WHERE "id" = $1', params: [7] });
});
test("all condition AST forms retain empty and tuple row-major semantics", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const query = db.rows.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> };
  query.plan = { conditions: [{ kind: "and", left: { kind: "compare", property: "id", op: ">", value: 1 }, right: { kind: "not", inner: { kind: "or", left: { kind: "in", property: "id", values: [] }, right: { kind: "tuples", properties: ["id", "name"], values: [[2, "a"], [3, "b"]] } } } }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  await query.executeDelete();
  expect(log[0]).toEqual({ sql: 'DELETE FROM "immediate_rows" WHERE ("id" > $1 AND NOT ((0 = 1 OR (("id" = $2 AND "name" = $3) OR ("id" = $4 AND "name" = $5)))))', params: [1, 2, "a", 3, "b"] });
});
test("hostile late AST node is rejected before converters and SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); converterCalls = 0; let reads = 0; const bad = Object.create(null); Object.defineProperty(bad, "kind", { enumerable: true, get() { reads += 1; return "compare"; } });
  const query = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = { conditions: [{ kind: "compare", property: "id", op: "=", value: 1 }, bad], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(reads).toBe(0); expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("predicate null invokes converter once and binds SQL NULL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); converterCalls = 0;
  const query = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = { conditions: [{ kind: "compare", property: "value", op: "=", value: null }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  await query.executeDelete();
  expect(converterCalls).toBe(1); expect(log[0]).toEqual({ sql: 'DELETE FROM "ConvertedRows" WHERE "value" = $1', params: [null] });
});
test("predicate converter reentrancy is stopped by final tracker guard", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  const query = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = { conditions: [{ kind: "compare", property: "value", op: "=", value: new Date(1) }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  reentrantContext = db; converterCalls = 0;
  try { await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmTrackedMutationConflictError); } finally { reentrantContext = undefined; }
  expect(converterCalls).toBe(1); expect(log).toEqual([]);
});
test("SELECT control retains existing filter renderer", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; queryLog.length = 0; const db = new Context(provider(log)); await db.filtered.where((row) => row.id.eq(4)).toList();
  expect(log).toEqual([]); expect(queryLog).toEqual([{ sql: 'SELECT "id", "tenant", "name", "deletedAt" FROM "filtered_rows" WHERE "tenant" = $1 AND "deletedAt" IS NULL AND "id" = $2', params: ["tenant", 4] }]);
});
test("B-global hostile shapes reject before dispatch; empty controls retain exact SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const model = (db.filtered as unknown as { model: { queryFilters: unknown } }).model; const original = model.queryFilters; let reads = 0; const accessor = Object.create(null); Object.defineProperty(accessor, "kind", { enumerable: true, get() { reads += 1; return "compare"; } });
  try { model.queryFilters = [accessor]; await expect(db.filtered.asNoTracking().where(x => x.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); model.queryFilters = [{ kind: "null", property: "id", negated: false, extra: true }]; await expect(db.filtered.asNoTracking().where(x => x.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); for (const control of [{ kind: "in", property: "id", values: [] }, { kind: "tuples", properties: ["id"], values: [] }]) { model.queryFilters = [control]; await expect(db.filtered.asNoTracking().where(x => x.id.eq(1)).executeDelete()).resolves.toBeDefined(); } } finally { model.queryFilters = original; }
  expect(reads).toBe(0); expect(log[0]?.sql).toContain("0 = 1");
});
test("75 final encoded params accept copied Date bytes JSON and arbitrary bigint", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const outputs: unknown[] = [new Date(5), new Uint8Array([1, 2]), { nested: [true, 2] }, 999999999999999999999999999999n]; let encodes = 0;
  const custom: DatabaseProvider = { ...provider(log), dialect: { ...dialect, encode: () => { const call = encodes++; return call % 2 === 0 ? outputs[call / 2] as never : 1 as never; } } }; const db = new Context(custom);
  for (const id of [1, 2, 3, 4]) await db.rows.asNoTracking().where(x => x.id.eq(id)).executeUpdate({ name: "storage" });
  expect(encodes).toBe(8); expect(log).toHaveLength(4); expect(log[0]!.params[0]).toBeInstanceOf(Date); expect(log[1]!.params[0]).toEqual(new Uint8Array([1, 2])); expect(log[2]!.params[0]).toEqual({ nested: [true, 2] }); expect(log[3]!.params[0]).toBe(999999999999999999999999999999n);
});
test("75 invalid encoded nested values fail after one dialect encode without dispatch", async () => {
  const invalid = [{ nested: 1n }, { nested: new Date() }, { nested: new Uint8Array([1]) }, { nested: Number.NaN }, [1, , 3]]; for (const output of invalid) { const log: { sql: string; params: readonly unknown[] }[] = []; let encodes = 0; const custom: DatabaseProvider = { ...provider(log), dialect: { ...dialect, encode: () => { const call = encodes++; return call === 0 ? output as never : 1 as never; } } }; const db = new Context(custom); await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "storage" })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(encodes).toBe(1); expect(log).toEqual([]); }
});
test("75 retained dialect Date bytes and JSON output cannot mutate dispatched params", async () => {
  const outputs: unknown[] = [new Date(7), new Uint8Array([4, 5]), { nested: { values: [1] } }]; const log: { sql: string; params: readonly unknown[] }[] = []; let calls = 0; const custom: DatabaseProvider = { ...provider(log), dialect: { ...dialect, encode: () => calls++ % 2 === 0 ? outputs[Math.floor((calls - 1) / 2)] as never : 1 as never } }; const db = new Context(custom);
  for (let index = 0; index < 3; index += 1) await db.rows.asNoTracking().where(x => x.id.eq(index + 1)).executeUpdate({ name: "v" });
  (outputs[0] as Date).setTime(99); (outputs[1] as Uint8Array)[0] = 9; ((outputs[2] as { nested: { values: number[] } }).nested.values[0] = 9);
  expect((log[0]!.params[0] as Date).getTime()).toBe(7); expect((log[1]!.params[0] as Uint8Array)[0]).toBe(4); expect(log[2]!.params[0]).toEqual({ nested: { values: [1] } }); expect(Object.isFrozen(log[2]!.params[0])).toBe(true);
});
test("75 converter throw, invalid storage and out-of-range integer stop before dialect", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; let encodes = 0; const custom: DatabaseProvider = { ...provider(log), dialect: { ...dialect, encode: () => { encodes += 1; return "encoded"; } } }; const db = new Context(custom);
  const throwing = { toProvider() { throw new Error("secret"); }, fromProvider: (value: string) => value }; const model = (db.rows as unknown as { model: { propertyByName(name: string): { converter?: unknown } } }).model; const property = model.propertyByName("name")!; const previous = property.converter; (property as { converter?: unknown }).converter = throwing;
  try { await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "x" })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); } finally { (property as { converter?: unknown }).converter = previous; }
  expect(encodes).toBe(0); expect(log).toEqual([]);
  // @ts-expect-error exercise out-of-range JavaScript input despite the numeric field type
  await expect(db.rows.asNoTracking().where(x => x.id.eq(9223372036854775808n)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(encodes).toBe(0);
});
test("75 encoded Proxy accessor and cycle are unsafe with no hooks or dispatch", async () => {
  const hostile: unknown[] = []; let traps = 0; const proxy = new Proxy({}, { get() { traps += 1; return undefined; }, getPrototypeOf() { traps += 1; return Object.prototype; } }); const accessor = Object.create(null); Object.defineProperty(accessor, "x", { enumerable: true, get() { traps += 1; return 1; } }); const cycle: { self?: unknown } = {}; cycle.self = cycle; hostile.push(proxy, accessor, cycle);
  for (const output of hostile) { const log: { sql: string; params: readonly unknown[] }[] = []; let encodes = 0; const custom: DatabaseProvider = { ...provider(log), dialect: { ...dialect, encode: () => { encodes += 1; return output as never; } } }; const db = new Context(custom); await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "x" })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(encodes).toBe(1); expect(log).toEqual([]); }
  expect(traps).toBe(0);
});
test("immediate result counts are frozen and malformed provider counts are safe", async () => {
  for (const changes of [0, 1, 7]) { const log: { sql: string; params: readonly unknown[] }[] = []; const base = provider(log); const custom: DatabaseProvider = { ...base, execute: async (sql, params) => { log.push({ sql, params }); return { changes, lastInsertId: 0 }; } }; const db = new Context(custom); const update = await db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "n" }); const deleted = await db.rows.asNoTracking().where(x => x.id.eq(1)).executeDelete(); expect(update.affectedRows).toBe(changes); expect(deleted.affectedRows).toBe(changes); expect(Object.isFrozen(update)).toBe(true); }
  for (const changes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) { const log: { sql: string; params: readonly unknown[] }[] = []; const base = provider(log); const db = new Context({ ...base, execute: async () => ({ changes, lastInsertId: 0 }) }); await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmError); }
});
test("insert count matrix and physical aliases are exact", async () => {
  for (const changes of [0, 1]) { const log: { sql: string; params: readonly unknown[] }[] = []; const base = provider(log); const db = new Context({ ...base, execute: async (sql, params) => { log.push({ sql, params }); return { changes, lastInsertId: 0 }; } }); const result = await db.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 1, name: "alias", note: null }), { conflictBy: x => [x.id] }); expect(result.inserted).toBe(changes === 1); expect(Object.isFrozen(result)).toBe(true); expect(log[0]).toEqual({ sql: 'INSERT INTO "immediate_rows" ("id", "name", "note") VALUES ($1, $2, $3) ON CONFLICT ("id") DO NOTHING', params: [1, "alias", null] }); }
  for (const changes of [2, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) { const base = provider([]); const db = new Context({ ...base, execute: async () => ({ changes, lastInsertId: 0 }) }); await expect(db.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 1, name: "bad", note: null }), { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmError); }
});
test("update admission rejects empty symbols undefined generated and unknown before SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const query = db.rows.asNoTracking().where(x => x.id.eq(1));
  const symbol = Symbol("field"); const cases: unknown[] = [{}, { name: undefined }, { id: 2 }, { unknown: "x" }, Object.assign(Object.create(null), { [symbol]: "x" }), new Proxy({ name: "x" }, {})];
  for (const values of cases) await expect(query.executeUpdate(values as never)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(log).toEqual([]);
});
test("insert admission rejects missing undefined required-null accessors symbols proxies and unsafe options", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const valid = () => Object.assign(new RowEntity(), { id: 1, name: "n", note: null });
  const missing = Object.assign(new RowEntity(), { id: 1, name: "n" }); delete (missing as { note?: unknown }).note;
  const undefinedNote = Object.assign(new RowEntity(), { id: 1, name: "n", note: undefined });
  const accessor = valid(); Object.defineProperty(accessor, "name", { enumerable: true, get() { return "hook"; } }); const symbol = Object.assign(valid(), { [Symbol("x")]: 1 });
  for (const entity of [missing, undefinedNote, accessor, symbol, new Proxy(valid(), {})]) await expect(db.rows.insertIfAbsent(entity as never, { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  await expect(db.keyRows.insertIfAbsent(Object.assign(new KeyRow(), { tenantKey: null, sequence: 1 }) as never, { conflictBy: x => [x.tenantKey, x.sequence] })).rejects.toThrow('"tenantKey" is required (NOT NULL); got null');
  const options = Object.create(null); Object.defineProperty(options, "conflictBy", { enumerable: true, get() { return () => []; } }); await expect(db.rows.insertIfAbsent(valid(), options)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(log).toEqual([]);
});
test("nullable null and ordinary extra data are preserved outside immutable insert command", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const entity = Object.assign(new RowEntity(), { id: 9, name: "extra", note: null, navigation: { ignored: true } });
  await expect(db.rows.insertIfAbsent(entity, { conflictBy: x => [x.id] })).resolves.toEqual({ inserted: true });
  expect(entity).toHaveProperty("navigation"); expect(log[0]!.params).toEqual([9, "extra", null]); expect(log[0]!.sql).not.toContain("navigation");
});
test("QueryPlan descriptors reject getters and every forbidden optional field before SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const base = { conditions: [{ kind: "compare", property: "id", op: "=", value: 1 }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  for (const optional of ["limit", "requestedLimit", "invalidRequestedLimit", "offset", "rowLock", "skipLocked"]) { const query = db.rows.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = { ...base, [optional]: undefined }; await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); }
  let reads = 0; const hostile = Object.create(Object.prototype); Object.defineProperties(hostile, { conditions: { value: base.conditions }, orders: { value: [] }, noTracking: { get() { reads += 1; return true; } }, includes: { value: [] }, ignoreQueryFilters: { value: true }, projections: { value: [] } }); const query = db.rows.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = hostile;
  await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(reads).toBe(0); expect(log).toEqual([]);
});
test("every QueryPlan field accessor, malformed shape and arrays fail closed", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const values: Record<string, unknown> = { conditions: [{ kind: "compare", property: "id", op: "=", value: 1 }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  for (const field of [...Object.keys(values), "limit", "requestedLimit", "invalidRequestedLimit", "offset", "rowLock", "skipLocked", "unknown"]) { let reads = 0; const plan = Object.create(Object.prototype); for (const [key, value] of Object.entries(values)) if (key !== field) Object.defineProperty(plan, key, { value, enumerable: true }); Object.defineProperty(plan, field, { enumerable: true, get() { reads += 1; return undefined; } }); const query = db.rows.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = plan; await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect(reads).toBe(0); }
  for (const plan of [null, Object.create(null), new Proxy(values, {}), { ...values, conditions: [] }, { ...values, orders: ["x"] }, { ...values, includes: ["x"] }, { ...values, projections: ["x"] }]) { const query = db.rows.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; query.plan = plan; await expect(query.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); }
  expect(log).toEqual([]);
});
test("non-Postgres insert fails before entity selector or converter admission", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = [];
  const nonPostgres: DatabaseProvider = { ...provider(log), dialect: { ...dialect, name: "sqlite" } as SqlDialect };
  const db = new Context(nonPostgres); let entityReads = 0; let selectorCalls = 0; converterCalls = 0;
  const entity = Object.create(null);
  Object.defineProperties(entity, {
    id: { enumerable: true, get() { entityReads += 1; return 1; } },
    value: { enumerable: true, get() { entityReads += 1; return new Date(1); } },
  });
  await expect(db.converted.insertIfAbsent(entity, { conflictBy: () => { selectorCalls += 1; return []; } })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(entityReads).toBe(0); expect(selectorCalls).toBe(0); expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("sparse explicit and global condition lists reject before nodes or dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let reads = 0; converterCalls = 0;
  const sparse = () => { const result: unknown[] = []; result.length = 1; const unreachable = Object.create(null); Object.defineProperty(unreachable, "kind", { enumerable: true, get() { reads += 1; return "compare"; } }); Object.defineProperty(result, "extra", { enumerable: true, value: unreachable }); return result; };
  const plan = { conditions: sparse(), orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  const explicit = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; explicit.plan = plan;
  await expect(explicit.executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  const model = (db.filtered as unknown as { model: { queryFilters: unknown } }).model; const original = model.queryFilters;
  try {
    model.queryFilters = sparse();
    await expect(db.filtered.asNoTracking().where(row => row.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  } finally { model.queryFilters = original; }
  expect(reads).toBe(0); expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
const keyRow = () => Object.assign(new KeyRow(), { tenantKey: "tenant-a", sequence: 7, externalKey: "external-a", payload: "before" });
test("composite aliases render exact UPDATE DELETE INSERT and leave caller entities detached", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const row = keyRow();
  const update = await db.keyRows.asNoTracking().where(x => x.tenantKey.eq("tenant-a").and(x.sequence.eq(7))).executeUpdate({ payload: "after" });
  const deleted = await db.keyRows.asNoTracking().where(x => x.tenantKey.eq("tenant-a").and(x.sequence.eq(7))).executeDelete();
  const inserted = await db.keyRows.insertIfAbsent(row, { conflictBy: x => [x.tenantKey, x.sequence] });
  expect(update).toEqual({ affectedRows: 2 }); expect(deleted).toEqual({ affectedRows: 2 }); expect(Object.isFrozen(deleted)).toBe(true); expect(inserted).toEqual({ inserted: true });
  expect(log).toEqual([
    { sql: 'UPDATE "immediate_key_rows" SET "payload_text" = $1 WHERE ("tenant_key" = $2 AND "sequence_no" = $3)', params: ["after", "tenant-a", 7] },
    { sql: 'DELETE FROM "immediate_key_rows" WHERE ("tenant_key" = $1 AND "sequence_no" = $2)', params: ["tenant-a", 7] },
    { sql: 'INSERT INTO "immediate_key_rows" ("tenant_key", "sequence_no", "external_key", "payload_text") VALUES ($1, $2, $3, $4) ON CONFLICT ("tenant_key", "sequence_no") DO NOTHING', params: ["tenant-a", 7, "external-a", "before"] },
  ]);
  expect(row).toEqual(keyRow()); expect(db.stateOf(row)).toBe(EntityState.Detached);
});
test("accepts declared composite primary and unique tuples in their physical order", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  await db.keyRows.insertIfAbsent(keyRow(), { conflictBy: x => [x.tenantKey, x.sequence] });
  await db.keyRows.insertIfAbsent(keyRow(), { conflictBy: x => [x.externalKey, x.tenantKey] });
  expect(log.map(item => item.sql)).toEqual([
    'INSERT INTO "immediate_key_rows" ("tenant_key", "sequence_no", "external_key", "payload_text") VALUES ($1, $2, $3, $4) ON CONFLICT ("tenant_key", "sequence_no") DO NOTHING',
    'INSERT INTO "immediate_key_rows" ("tenant_key", "sequence_no", "external_key", "payload_text") VALUES ($1, $2, $3, $4) ON CONFLICT ("external_key", "tenant_key") DO NOTHING',
  ]);
});
test("rejects undeclared composite target shapes before dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  const selectors = [
    (x: { tenantKey: Operand; sequence: Operand }) => [x.sequence, x.tenantKey],
    (x: { tenantKey: Operand; externalKey: Operand }) => [x.tenantKey, x.externalKey],
    (x: { tenantKey: Operand }) => [x.tenantKey],
    (x: { tenantKey: Operand; sequence: Operand; payload: Operand }) => [x.tenantKey, x.sequence, x.payload],
    (x: { tenantKey: Operand; payload: Operand }) => [x.tenantKey, x.payload],
  ];
  for (const conflictBy of selectors) await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: conflictBy as never })).rejects.toBeInstanceOf(OrmUndeclaredConflictTargetError);
  expect(log).toEqual([]);
});
test("foreign selector operands and hostile options or result arrays are safe before SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let callbacks = 0; let reads = 0; let applies = 0; let foreign: Operand<string> | undefined;
  await db.keyRows.insertIfAbsent(keyRow(), { conflictBy: x => { foreign = x.tenantKey; return [x.tenantKey, x.sequence]; } }); log.length = 0;
  await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: x => [foreign!, x.sequence] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  const accessorTarget = () => { const target: unknown[] = []; target.length = 1; Object.defineProperty(target, "0", { enumerable: true, get() { reads += 1; return undefined; } }); return target; };
  const extraTarget = (x: { tenantKey: Operand; sequence: Operand }) => { const target = [x.tenantKey, x.sequence]; Object.defineProperty(target, "extra", { enumerable: true, value: 1 }); return target; };
  const symbolTarget = (x: { tenantKey: Operand; sequence: Operand }) => Object.assign([x.tenantKey, x.sequence], { [Symbol("target")]: 1 });
  for (const conflictBy of [() => accessorTarget(), () => new Proxy([], {}), symbolTarget, extraTarget]) await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: conflictBy as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  const accessorOptions = Object.create(null); Object.defineProperty(accessorOptions, "conflictBy", { enumerable: true, get() { reads += 1; return () => []; } });
  for (const options of [new Proxy({ conflictBy: () => [] }, {}), accessorOptions, { conflictBy: () => { callbacks += 1; return []; }, extra: true }]) await expect(db.keyRows.insertIfAbsent(keyRow(), options as never)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  converterCalls = 0; const proxyCallback = new Proxy((x: { id: Operand<number> }) => [x.id], { apply(target, thisArg, args) { applies += 1; return Reflect.apply(target, thisArg, args); } });
  await expect(db.converted.insertIfAbsent(Object.assign(new ConvertedRow(), { id: 4, value: new Date(1) }), { conflictBy: proxyCallback })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: () => { callbacks += 1; throw new Error("selector"); } })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(reads).toBe(0); expect(applies).toBe(0); expect(converterCalls).toBe(0); expect(callbacks).toBe(1); expect(log).toEqual([]);
});
test("permits an ordinary bound selector function", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  const conflictBy = ((x: { tenantKey: Operand; sequence: Operand }) => [x.tenantKey, x.sequence]).bind(undefined);
  await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: conflictBy as never })).resolves.toEqual({ inserted: true });
  expect(log[0]?.sql).toContain('ON CONFLICT ("tenant_key", "sequence_no") DO NOTHING');
});
test("reentrant selector attachment is stopped by the final tracker guard", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  await expect(db.keyRows.insertIfAbsent(keyRow(), { conflictBy: x => { db.keyRows.attach(keyRow()); return [x.tenantKey, x.sequence]; } })).rejects.toBeInstanceOf(OrmTrackedMutationConflictError);
  expect(log).toEqual([]);
});
test("caller identity and UUID values remain literal and detached for all insert outcomes", async () => {
  for (const changes of [1, 0, 2]) {
    const log: { sql: string; params: readonly unknown[] }[] = []; const base = provider(log); const db = new Context({ ...base, execute: async (sql, params) => { log.push({ sql, params }); return { changes, lastInsertId: 0 }; } });
    const identity = Object.assign(new IdentityRow(), { id: 41, value: "identity" }); const uuid = "52c71693-8f3b-4bd1-944f-df9321b30f7b"; const uuidRow = Object.assign(new UuidLiteralRow(), { id: uuid, value: "uuid" });
    if (changes === 2) {
      await expect(db.identities.insertIfAbsent(identity, { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmError);
      await expect(db.uuidLiterals.insertIfAbsent(uuidRow, { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmError);
    } else {
      expect((await db.identities.insertIfAbsent(identity, { conflictBy: x => [x.id] })).inserted).toBe(changes === 1);
      expect((await db.uuidLiterals.insertIfAbsent(uuidRow, { conflictBy: x => [x.id] })).inserted).toBe(changes === 1);
    }
    expect(identity).toEqual(Object.assign(new IdentityRow(), { id: 41, value: "identity" })); expect(uuidRow.id).toBe(uuid); expect(db.stateOf(identity)).toBe(EntityState.Detached); expect(db.stateOf(uuidRow)).toBe(EntityState.Detached);
    expect(log.map(item => item.sql)).toEqual([
      'INSERT INTO "immediate_identity_rows" ("identity_id", "identity_value") VALUES ($1, $2) ON CONFLICT ("identity_id") DO NOTHING',
      'INSERT INTO "immediate_uuid_rows" ("uuid_id", "uuid_value") VALUES ($1, $2) ON CONFLICT ("uuid_id") DO NOTHING',
    ]);
    expect(log.map(item => item.params)).toEqual([[41, "identity"], [uuid, "uuid"]]);
  }
});
test("every tracked state blocks all three same-model immediate terminals before selector or SQL", async () => {
  const cases: readonly [EntityState, (db: Context, row: RowEntity) => void][] = [
    [EntityState.Unchanged, (db, row) => { db.rows.attach(row); }],
    [EntityState.Added, (db, row) => { delete (row as { id?: unknown }).id; db.rows.add(row); }],
    [EntityState.Modified, (db, row) => { db.rows.update(row); }],
    [EntityState.Deleted, (db, row) => { db.rows.remove(row); }],
  ];
  for (const [state, track] of cases) {
    const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const tracked = Object.assign(new RowEntity(), { id: 71, name: `state-${state}`, note: null }); track(db, tracked); let selectors = 0;
    expect(db.stateOf(tracked)).toBe(state);
    await expect(db.rows.asNoTracking().where(x => x.id.eq(71)).executeUpdate({ name: "blocked" })).rejects.toBeInstanceOf(OrmTrackedMutationConflictError);
    await expect(db.rows.asNoTracking().where(x => x.id.eq(71)).executeDelete()).rejects.toBeInstanceOf(OrmTrackedMutationConflictError);
    await expect(db.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 72, name: "insert", note: null }), { conflictBy: x => { selectors += 1; return [x.id]; } })).rejects.toBeInstanceOf(OrmTrackedMutationConflictError);
    expect(selectors).toBe(0); expect(log).toEqual([]);
  }
});
test("another model in the same context remains tracked while Row terminals dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const filtered = Object.assign(new FilteredRow(), { id: 91, tenant: "tenant", name: "tracked", deletedAt: null }); db.filtered.attach(filtered);
  expect(db.stateOf(filtered)).toBe(EntityState.Unchanged);
  await db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "allowed" }); await db.rows.asNoTracking().where(x => x.id.eq(1)).executeDelete(); await db.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 2, name: "allowed", note: null }), { conflictBy: x => [x.id] });
  expect(db.stateOf(filtered)).toBe(EntityState.Unchanged); expect(log).toHaveLength(3);
});
test("another context sharing the exact model allows all Row terminals and retains tracker A", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const options = new DbContextOptions({ provider: provider(log), entities: [RowEntity, FilteredRow] }); const contextA = new SharedRowsContext(options); const contextB = new SharedRowsContext(options); const tracked = Object.assign(new RowEntity(), { id: 101, name: "a", note: null }); contextA.rows.attach(tracked);
  const modelA = (contextA.rows as unknown as { model: unknown }).model; const modelB = (contextB.rows as unknown as { model: unknown }).model; expect(modelA).toBe(modelB); expect(contextA.stateOf(tracked)).toBe(EntityState.Unchanged);
  await contextB.rows.asNoTracking().where(x => x.id.eq(101)).executeUpdate({ name: "b" }); await contextB.rows.asNoTracking().where(x => x.id.eq(101)).executeDelete(); await contextB.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 102, name: "b", note: null }), { conflictBy: x => [x.id] });
  expect(contextA.stateOf(tracked)).toBe(EntityState.Unchanged); expect(contextB.stateOf(tracked)).toBe(EntityState.Detached); expect(log).toHaveLength(3);
});
test("convention and generated-key update values reject before conversion or SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); converterCalls = 0; const query = db.rules.asNoTracking().where(x => x.id.eq(1));
  for (const values of [{ id: 2 }, { createdAt: new Date(1) }, { updatedAt: new Date(1) }, { unknown: "x" }]) await expect(query.executeUpdate(values as never)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("controlled JSON converter receives one mutable isolated clone and SQL retains immutable output", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const shared = { label: "shared" }; const input = { nested: { value: null as number | null }, items: [shared, shared] }; jsonConverterCalls = 0; jsonConverterInput = undefined;
  await db.json.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: input });
  expect(jsonConverterCalls).toBe(1); expect(jsonConverterInput).not.toBe(input); expect((jsonConverterInput as { items: unknown[] }).items[0]).toBe((jsonConverterInput as { items: unknown[] }).items[1]); expect(input).toEqual({ nested: { value: null }, items: [shared, shared] }); expect(log[0]!.params[0]).toEqual({ stored: { nested: { value: 99 }, items: [shared, shared, "converter"] } }); (jsonConverterInput as { nested: { value: number }; items: unknown[] }).nested.value = 7; (jsonConverterInput as { nested: { value: number }; items: unknown[] }).items.push("later"); expect(log[0]!.params[0]).toEqual({ stored: { nested: { value: 99 }, items: [shared, shared, "converter"] } }); expect(Object.isFrozen(log[0]!.params[0])).toBe(true);
});
test("hostile JSON values fail as Unsafe before converter or SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let hooks = 0; const accessor = Object.create(null); Object.defineProperty(accessor, "x", { enumerable: true, get() { hooks += 1; return 1; } }); const inherited = Object.create({ toJSON() { hooks += 1; return {}; } }); inherited.x = 1; const cycle: { self?: unknown } = {}; cycle.self = cycle; const sparse = [1, , 3]; const symbolKey = { ok: 1, [Symbol("x")]: 2 }; const undefinedValue = { x: undefined }; const custom = Object.create({}); custom.x = 1;
  const extraArray = [1]; Object.defineProperty(extraArray, "extra", { enumerable: true, value: 2 }); const ownToJson = { x: 1, toJSON() { hooks += 1; return {}; } }; const hostile = [accessor, new Proxy({}, {}), () => 1, symbolKey, { x: Symbol("value") }, cycle, sparse, extraArray, { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }, custom, new Map(), new Set(), /x/, new ArrayBuffer(1), inherited, ownToJson, undefinedValue];
  jsonConverterCalls = 0;
  for (const payload of hostile) await expect(db.json.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: payload as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(hooks).toBe(0); expect(jsonConverterCalls).toBe(0); expect(log).toEqual([]);
});
test("bytes converter mutates only its isolated intrinsic Uint8Array input", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const bytes = new Uint8Array([1, 2]); bytesConverterCalls = 0;
  await db.bytes.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: bytes });
  bytes[0] = 8; expect(bytesConverterCalls).toBe(1); expect(bytes).toEqual(new Uint8Array([8, 2])); expect(log[0]!.params).toEqual(["9,2", 1]);
});
test("rejects non-intrinsic bytes and Date forms without hooks or converters", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let hooks = 0; class BytesSubclass extends Uint8Array {} class DateSubclass extends Date {} const extra = new Uint8Array([1]); Object.defineProperty(extra, "extra", { enumerable: true, value: 1 }); const dateOwn = new Date(1); Object.defineProperty(dateOwn, "x", { enumerable: true, value: 1 });
  const symbolBytes = new Uint8Array([1]); Object.defineProperty(symbolBytes, Symbol("x"), { value: 1 }); const lengthBytes = new Uint8Array([1]); Object.defineProperty(lengthBytes, "length", { enumerable: true, get() { hooks += 1; return 1; } }); const ownToJsonDate = new Date(1); Object.defineProperty(ownToJsonDate, "toJSON", { enumerable: true, value() { hooks += 1; return "hook"; } }); const symbolDate = new Date(1); Object.defineProperty(symbolDate, Symbol("x"), { value: 1 });
  const byteValues = [Buffer.from([1]), new BytesSubclass([1]), new Int8Array([1]), new Proxy(new Uint8Array([1]), {}), extra, symbolBytes, lengthBytes, runInNewContext("new Uint8Array([1])")];
  const dateValues = [new DateSubclass(1), runInNewContext("new Date(1)"), new Date(Number.NaN), dateOwn, ownToJsonDate, symbolDate, Object.create(Date.prototype)]; bytesConverterCalls = 0; converterCalls = 0;
  for (const payload of byteValues) await expect(db.bytes.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: payload as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  for (const value of dateValues) await expect(db.converted.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ value: value as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(hooks).toBe(0); expect(bytesConverterCalls).toBe(0); expect(converterCalls).toBe(0); expect(log).toEqual([]);
});
test("captured Uint8Array intrinsics ignore iterator species and length hooks", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let hooks = 0; const iterator = Object.getOwnPropertyDescriptor(Uint8Array.prototype, Symbol.iterator); const length = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "length"); const species = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
  try {
    Object.defineProperty(Uint8Array.prototype, Symbol.iterator, { configurable: true, get() { hooks += 1; return iterator?.value; } }); Object.defineProperty(Uint8Array.prototype, "length", { configurable: true, get() { hooks += 1; return 99; } }); Object.defineProperty(Uint8Array, Symbol.species, { configurable: true, get() { hooks += 1; return Uint8Array; } }); bytesConverterCalls = 0;
    await db.bytes.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: new Uint8Array([1, 2]) });
  } finally { if (iterator) Object.defineProperty(Uint8Array.prototype, Symbol.iterator, iterator); else delete (Uint8Array.prototype as { [Symbol.iterator]?: unknown })[Symbol.iterator]; if (length) Object.defineProperty(Uint8Array.prototype, "length", length); else delete (Uint8Array.prototype as { length?: unknown }).length; if (species) Object.defineProperty(Uint8Array, Symbol.species, species); else delete (Uint8Array as { [Symbol.species]?: unknown })[Symbol.species]; }
  expect(hooks).toBe(0); expect(bytesConverterCalls).toBe(1); expect(log[0]!.params).toEqual(["9,2", 1]);
});
test("captured constructors and Date getTime survive replaced globals without hooks", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const savedDate = new Date(5); const savedBytes = new Uint8Array([1, 2]); const NativeDate = globalThis.Date; const NativeBytes = globalThis.Uint8Array; const getTime = Object.getOwnPropertyDescriptor(NativeDate.prototype, "getTime")!; let dateConstructors = 0; let byteConstructors = 0; let getTimeHooks = 0;
  try {
    Object.defineProperty(NativeDate.prototype, "getTime", { configurable: true, value() { getTimeHooks += 1; throw new Error("hook"); } }); globalThis.Date = class extends NativeDate { constructor(...args: ConstructorParameters<typeof NativeDate>) { dateConstructors += 1; super(...args); } } as typeof Date; globalThis.Uint8Array = class extends NativeBytes { constructor(...args: ConstructorParameters<typeof NativeBytes>) { byteConstructors += 1; super(...args); } } as typeof Uint8Array; converterCalls = 0; bytesConverterCalls = 0;
    await db.converted.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ value: savedDate }); await db.bytes.asNoTracking().where(x => x.id.eq(2)).executeUpdate({ payload: savedBytes });
  } finally { globalThis.Date = NativeDate; globalThis.Uint8Array = NativeBytes; Object.defineProperty(NativeDate.prototype, "getTime", getTime); }
  expect(getTimeHooks).toBe(0); expect(dateConstructors).toBe(0); expect(byteConstructors).toBe(0); expect(converterCalls).toBe(1); expect(bytesConverterCalls).toBe(1); expect(log).toHaveLength(2);
});
test("retained converter Date output and ValueConverters.json input cannot alias caller or params", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const at = new Date(10); const json = { nested: ["caller"] };
  await db.datetimes.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ at }); await db.jsonText.asNoTracking().where(x => x.id.eq(2)).executeUpdate({ payload: json });
  dateOutput!.setTime(99); json.nested.push("later"); expect((log[0]!.params[0] as Date).getTime()).toBe(10); expect(log[1]!.params[0]).toBe('{"nested":["caller"]}'); expect(at.getTime()).toBe(10);
});
test("ValueConverters.json accepts a dense top-level array clone without touching caller", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const input = ["one", { nested: ["two"] }];
  await db.jsonText.asNoTracking().where(x => x.id.eq(3)).executeUpdate({ payload: input as never }); input.push("later");
  expect(log[0]!.params).toEqual(['["one",{"nested":["two"]}]', 3]);
});
test("nullable insert and update null bypass the converter while predicate null counts occurrences", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); nullableConverterCalls = 0;
  await db.nullable.insertIfAbsent(Object.assign(new NullableConvertedRow(), { id: 2, value: null }), { conflictBy: x => [x.id] }); expect(nullableConverterCalls).toBe(0); expect(log[0]!.params).toEqual([2, null]);
  const query = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; converterCalls = 0; query.plan = { conditions: [{ kind: "tuples", properties: ["value"], values: [[null], [null]] }], orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] }; await query.executeDelete(); expect(converterCalls).toBe(2); expect(log[1]!.params).toEqual([null, null]);
  // Like insert, an update to NULL binds SQL NULL without the converter.
  await db.nullable.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ value: null }); expect(nullableConverterCalls).toBe(0); expect(log[2]!.params).toEqual([null, 1]);
});
test("admitted predicate null AST uses zero calls while compare and IN bind each null occurrence", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const query = db.converted.asNoTracking() as unknown as { plan: unknown; executeDelete(): Promise<unknown> }; const base = { orders: [], noTracking: true, includes: [], ignoreQueryFilters: true, projections: [] };
  converterCalls = 0; query.plan = { ...base, conditions: [{ kind: "null", property: "value", negated: false }] }; await query.executeDelete(); expect(converterCalls).toBe(0); expect(log[0]!.params).toEqual([]);
  converterCalls = 0; query.plan = { ...base, conditions: [{ kind: "compare", property: "value", op: "=", value: null }] }; await query.executeDelete(); expect(converterCalls).toBe(1); expect(log[1]!.params).toEqual([null]);
  converterCalls = 0; query.plan = { ...base, conditions: [{ kind: "in", property: "value", values: [null, null] }] }; await query.executeDelete(); expect(converterCalls).toBe(2); expect(log[2]!.params).toEqual([null, null]);
});
test("requires public asNoTracking for update and delete before any dispatch", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log));
  await expect(db.rows.where(x => x.id.eq(1)).executeUpdate({ name: "x" })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); await expect(db.rows.where(x => x.id.eq(1)).executeDelete()).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(log).toEqual([]);
});
test("nullable undefined root null and Operand bags reject before converter or SQL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); nullableConverterCalls = 0; const query = db.nullable.asNoTracking().where(x => x.id.eq(1));
  for (const values of [null, { value: undefined }, { value: new Operand("value") }]) await expect(query.executeUpdate(values as never)).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(nullableConverterCalls).toBe(0); expect(log).toEqual([]);
});
test("complete insert requires convention columns while physical soft-delete remains DELETE", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; queryLog.length = 0; const db = new Context(provider(log)); const missingCreated = Object.assign(new RulesRow(), { id: 1, plain: "x" }); delete (missingCreated as { createdAt?: unknown }).createdAt; const missingUpdated = Object.assign(new RulesRow(), { id: 2, plain: "x" }); delete (missingUpdated as { updatedAt?: unknown }).updatedAt;
  await expect(db.rules.insertIfAbsent(missingCreated, { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); await expect(db.rules.insertIfAbsent(missingUpdated, { conflictBy: x => [x.id] })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect((await db.filtered.asNoTracking().where(x => x.id.eq(9)).executeDelete()).affectedRows).toBe(2);
  expect(log).toEqual([{ sql: 'DELETE FROM "filtered_rows" WHERE "tenant" = $1 AND "deletedAt" IS NULL AND "id" = $2', params: ["tenant", 9] }]); expect(queryLog).toEqual([]);
});
test("callable Date toJSON and Uint8Array buffer/set hooks are never used", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); const dateToJson = Object.getOwnPropertyDescriptor(Date.prototype, "toJSON")!; const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype); const set = Object.getOwnPropertyDescriptor(typedArrayPrototype, "set")!; const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer"); const constructor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor"); let hooks = 0; converterCalls = 0; bytesConverterCalls = 0;
  try { Object.defineProperty(Date.prototype, "toJSON", { configurable: true, value() { hooks += 1; return "hook"; } }); await expect(db.converted.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ value: new Date(1) })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); Object.defineProperty(Date.prototype, "toJSON", dateToJson); Object.defineProperty(typedArrayPrototype, "set", { configurable: true, get() { hooks += 1; return set.value; } }); Object.defineProperty(typedArrayPrototype, "buffer", { configurable: true, get() { hooks += 1; return new ArrayBuffer(0); } }); Object.defineProperty(Uint8Array.prototype, "constructor", { configurable: true, get() { hooks += 1; return Uint8Array; } }); await db.bytes.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: new Uint8Array([1, 2]) }); } finally { Object.defineProperty(Date.prototype, "toJSON", dateToJson); Object.defineProperty(typedArrayPrototype, "set", set); if (buffer) Object.defineProperty(typedArrayPrototype, "buffer", buffer); else delete (typedArrayPrototype as { buffer?: unknown }).buffer; if (constructor) Object.defineProperty(Uint8Array.prototype, "constructor", constructor); else delete (Uint8Array.prototype as { constructor?: unknown }).constructor; }
  expect(hooks).toBe(0); expect(converterCalls).toBe(0); expect(bytesConverterCalls).toBe(1); expect(log).toHaveLength(1);
});
test("ValueConverters.json rejects own inherited and accessor toJSON before serialization", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new Context(provider(log)); let hooks = 0; const accessor = Object.create(null); Object.defineProperty(accessor, "x", { enumerable: true, get() { hooks += 1; return 1; } }); const inherited = Object.create({ toJSON() { hooks += 1; return {}; } }); inherited.x = 1; const own = { x: 1, toJSON() { hooks += 1; return {}; } };
  for (const payload of [accessor, inherited, own]) await expect(db.jsonText.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ payload: payload as never })).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError);
  expect(hooks).toBe(0); expect(log).toEqual([]);
});
const m12Update = (db: Context) => db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ name: "m12" });
const m12Delete = (db: Context) => db.rows.asNoTracking().where(x => x.id.eq(1)).executeDelete();
const m12Insert = (db: Context) => db.rows.insertIfAbsent(Object.assign(new RowEntity(), { id: 2, name: "m12", note: null }), { conflictBy: x => [x.id] });
const m12ConvertedUpdate = (db: Context) => db.converted.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ value: new Date(1) });
const m12ConvertedDelete = (db: Context) => db.converted.asNoTracking().where(x => x.id.eq(1)).executeDelete();
const m12ConvertedInsert = (db: Context, selectorCalls: { value: number }) => db.converted.insertIfAbsent(Object.assign(new ConvertedRow(), { id: 2, value: new Date(1) }), { conflictBy: x => { selectorCalls.value += 1; return [x.id]; } });
test("awaited public update delete insert commit", async () => {
  const value = m12Provider(); const db = new Context(value);
  await db.transactionScope(async () => { await expect(m12Update(db)).resolves.toEqual({ affectedRows: 1 }); await expect(m12Delete(db)).resolves.toEqual({ affectedRows: 1 }); await expect(m12Insert(db)).resolves.toEqual({ inserted: true }); });
  expect({ calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks() }).toEqual({ calls: 3, commits: 1, rollbacks: 0 });
});
test("fast void and immediate outer return follow accepted public timing", async () => {
  for (const mode of ["turn", "return"] as const) { const value = m12Provider(); const db = new Context(value); let operation!: Promise<unknown>; let assigned!: () => void; const assignedPromise = new Promise<void>(resolve => { assigned = resolve; });
    const scope = db.transactionScope(async () => { operation = m12Update(db); void operation.catch(() => {}); assigned(); if (mode === "turn") await new Promise<void>(resolve => setImmediate(resolve)); }); await assignedPromise;
    const [outer, inner] = await Promise.all([scope.then(() => "resolved", () => "rejected"), operation.then(() => "resolved", () => "rejected")]);
    expect({ mode, outer, inner, calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks() }).toEqual(mode === "turn" ? { mode, outer: "resolved", inner: "resolved", calls: 1, commits: 1, rollbacks: 0 } : { mode, outer: "rejected", inner: "resolved", calls: 1, commits: 0, rollbacks: 1 });
  }
});
test("invalid void immediate poisons its outer scope while preserving the Unsafe operation error", async () => {
  const value = m12Provider(); const db = new Context(value); let operation!: Promise<unknown>; const scope = db.transactionScope(async () => { operation = db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ id: 2 } as never); void operation.catch(() => {}); });
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(operation).rejects.toBeInstanceOf(OrmUnsafeImmediateMutationError); expect({ calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks() }).toEqual({ calls: 0, commits: 0, rollbacks: 1 });
});
test("awaited and caught unsafe immediate calls poison their outer scope without SQL", async () => {
  for (const mode of ["awaited", "caught"] as const) { const value = m12Provider(); const db = new Context(value); let inner: unknown; const scope = db.transactionScope(async () => { const invalid = db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ id: 2 } as never); await Promise.resolve(); if (mode === "awaited") { try { await invalid; } catch (error) { inner = error; throw error; } } else await invalid.catch(error => { inner = error; }); });
    await expect(scope).rejects.toBeDefined(); expect(inner).toBeInstanceOf(OrmUnsafeImmediateMutationError); expect({ calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks() }).toEqual({ calls: 0, commits: 0, rollbacks: 1 }); }
});
test("inherited stale continuation rejects before dispatch while outside call is valid", async () => {
  const value = m12Provider(); const db = new Context(value); let release!: () => void; let late!: Promise<unknown>; const selectorCalls = { value: 0 }; const gate = new Promise<void>(resolve => { release = resolve; }); converterCalls = 0;
  await db.transactionScope(async () => { void (async () => { await gate; late = m12ConvertedInsert(db, selectorCalls); void late.catch(() => {}); })(); }); release(); while (!late!) await Promise.resolve(); await expect(late).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(m12Update(db)).resolves.toEqual({ affectedRows: 1 });
  expect({ calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks(), converterCalls, selectorCalls: selectorCalls.value }).toEqual({ calls: 1, commits: 1, rollbacks: 0, converterCalls: 0, selectorCalls: 0 });
});
test("parent immediate terminals reject before callbacks while a child scope is active", async () => {
  const value = m12Provider(); const db = new Context(value); let release!: () => void; let entered!: () => void; const selectorCalls = { value: 0 }; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; }); converterCalls = 0;
  await db.transactionScope(async () => { const child = db.transactionScope(async () => { entered(); await gate; }); await started;
    try { await expect(m12ConvertedUpdate(db)).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(m12ConvertedDelete(db)).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(m12ConvertedInsert(db, selectorCalls)).rejects.toBeInstanceOf(OrmTransactionScopeError); } finally { release(); await child; }
  });
  expect({ calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks(), converterCalls, selectorCalls: selectorCalls.value }).toEqual({ calls: 0, commits: 1, rollbacks: 0, converterCalls: 0, selectorCalls: 0 });
});
test("held observed dispatch cancels once, resolves operation, and rolls back outer scope", async () => {
  const value = m12Provider(); const db = new Context(value); let release!: () => void; let began!: () => void; let cancels = 0; const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; }); let operation!: Promise<unknown>;
  value.setExecute(async () => { observeProviderDispatch({ settled: held, cancel: () => { cancels += 1; release(); } }); began(); await held; return { changes: 1, lastInsertId: 0 }; });
  const scope = db.transactionScope(async () => { operation = m12Update(db); void operation.catch(() => {}); await started; }); await started;
  const [outer, inner] = await Promise.all([scope.then(() => "resolved", () => "rejected"), operation.then(() => "resolved", () => "rejected")]);
  expect({ outer, inner, cancels, calls: value.calls(), commits: value.commits(), rollbacks: value.rollbacks(), quarantines: value.quarantines() }).toEqual({ outer: "rejected", inner: "resolved", cancels: 1, calls: 1, commits: 0, rollbacks: 1, quarantines: 0 });
  expect(value.rootCloses()).toBe(0);
});
test("retry attempts twice outside a scope and once inside then rolls back", async () => {
  let outsideAttempts = 0; const outside = m12Provider(); outside.setExecute(async () => { outsideAttempts += 1; if (outsideAttempts === 1) throw new Error("transient"); return { changes: 1, lastInsertId: 0 }; }); const outsideDb = new Context(withRetry(outside, { maxRetries: 1, baseDelayMs: 0, isTransient: () => true })); await expect(m12Update(outsideDb)).resolves.toEqual({ affectedRows: 1 }); expect(outsideAttempts).toBe(2);
  let insideAttempts = 0; const inside = m12Provider(); inside.setExecute(async () => { insideAttempts += 1; throw new Error("transient"); }); const insideDb = new Context(withRetry(inside, { maxRetries: 1, baseDelayMs: 0, isTransient: () => true })); await expect(insideDb.transactionScope(async () => { await m12Update(insideDb); })).rejects.toThrow("transient"); expect(insideAttempts).toBe(1); expect({ commits: inside.commits(), rollbacks: inside.rollbacks() }).toEqual({ commits: 0, rollbacks: 1 });
});
test("throwing native cancel quarantines held dispatch and blocks late inherited effects", async () => {
  for (const mode of ["Query.cancel unavailable", "native cancel missing"] as const) {
    const value = m12Provider(); const db = new Context(value); const unrelated = Object.assign(new IdentityRow(), { id: 77, value: "unrelated" }); db.add(unrelated); let rejectHeld!: (error: Error) => void; const held = new Promise<void>((_resolve, reject) => { rejectHeld = reject; }); let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; }); let releaseLate!: () => void; const lateGate = new Promise<void>(resolve => { releaseLate = resolve; }); let lateDone!: () => void; const done = new Promise<void>(resolve => { lateDone = resolve; }); let cancelAttempts = 0; let lateSuccess = 0; let lateError: unknown; let operation!: Promise<unknown>;
    value.setQuarantine(async () => { rejectHeld(new Error("retained session closed")); }); value.setExecute(async () => { observeProviderDispatch({ settled: held, cancel: () => { cancelAttempts += 1; throw new Error(mode); } }); began(); await held; return { changes: 1, lastInsertId: 0 }; });
    const scope = db.transactionScope(async () => { void (async () => { try { await lateGate; await m12Update(db); lateSuccess += 1; } catch (error) { lateError = error; } finally { lateDone(); } })(); operation = m12Update(db); void operation.catch(() => {}); await started; }); await started;
    await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(operation).rejects.toBeInstanceOf(OrmTransactionScopeError); releaseLate(); await done;
    expect(lateError).toBeInstanceOf(OrmTransactionScopeError); expect({ calls: value.calls(), cancelAttempts, quarantines: value.quarantines(), rootCloses: value.rootCloses(), commits: value.commits(), rollbacks: value.rollbacks(), lateSuccess, state: db.stateOf(unrelated), id: unrelated.id, text: unrelated.value }).toEqual({ calls: 1, cancelAttempts: 1, quarantines: 1, rootCloses: 0, commits: 0, rollbacks: 1, lateSuccess: 0, state: EntityState.Added, id: 77, text: "unrelated" });
  }
});

@Entity({ table: "immediate_dx_rows" })
class DxRow {
  @Key() id = 0;
  @Column({ type: "text", nullable: false }) title = "";
  @Index({ unique: true }) @Column({ type: "text" }) slug = "";
  @Column({ type: "integer" }) views = 0;
  @Column({ type: "datetime", nullable: true }) publishedAt: Date | null = null;
  @CreatedAt() createdAt = new Date(0);
}
@Entity({ table: "immediate_dx_v7_rows" })
class DxV7Row { @UUID({ version: "v7" }) id = ""; @Index({ unique: true }) @Column({ type: "text" }) code = ""; }
@Entity({ table: "immediate_dx_v4_rows" })
class DxV4Row { @UUID() id = ""; @Index({ unique: true }) @Column({ type: "text" }) code = ""; }
class DxContext extends DbContext {
  readonly rows = this.set(DxRow); readonly v7 = this.set(DxV7Row); readonly v4 = this.set(DxV4Row);
  constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [DxRow, DxV7Row, DxV4Row] })); }
}

test("immediate mutation errors name the rejected query shape", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new DxContext(provider(log));
  const where = () => db.rows.asNoTracking().where(x => x.id.eq(1));
  await expect(db.rows.where(x => x.id.eq(1)).executeUpdate({ views: 1 })).rejects.toThrow("call .asNoTracking() before executeUpdate()");
  await expect(db.rows.where(x => x.id.eq(1)).executeDelete()).rejects.toThrow("call .asNoTracking() before executeDelete()");
  await expect(db.rows.asNoTracking().executeUpdate({ views: 1 })).rejects.toThrow("add .where(...) before executeUpdate(); changing every row of a table is not allowed");
  await expect(db.rows.asNoTracking().executeDelete()).rejects.toThrow("add .where(...) before executeDelete()");
  await expect(where().take(1).executeUpdate({ views: 1 })).rejects.toThrow("executeUpdate() does not accept take() or skip()");
  await expect(where().orderBy(x => x.id).executeDelete()).rejects.toThrow("executeDelete() does not accept orderBy()");
  await expect(where().forUpdate().executeDelete()).rejects.toThrow("executeDelete() does not accept forUpdate()");
  expect(log).toEqual([]);
});

test("immediate update errors name the rejected value", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new DxContext(provider(log));
  const update = (values: unknown) => db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate(values as never);
  await expect(update({})).rejects.toThrow("pass at least one property to set");
  await expect(update({ nope: 1 })).rejects.toThrow('"nope" is not a mapped property of DxRow');
  await expect(update({ id: 2 })).rejects.toThrow('"id" is the primary key of DxRow and cannot be changed');
  await expect(update({ createdAt: new Date() })).rejects.toThrow('"createdAt" is filled automatically and cannot be set');
  await expect(update({ title: undefined })).rejects.toThrow('"title" is undefined; omit it or pass a value');
  await expect(update({ title: null })).rejects.toThrow('"title" is required (NOT NULL) and cannot be set to null');
  await expect(update({ views: "7" })).rejects.toThrow('"views" expects integer, got string');
  await expect(update({ views: (row: DxRow) => row.views + 1 })).rejects.toThrow('"views" must be a value, got a function; expressions such as views + 1 are not supported');
  await expect(update({ publishedAt: "2026-10-10" })).rejects.toThrow('"publishedAt" expects datetime, got string');
  expect(log).toEqual([]);
  await expect(db.rows.asNoTracking().where(x => x.views.eq("7" as never)).executeDelete()).rejects.toThrow('"views" expects integer, got string');
  await expect(update(new Proxy({ views: "7" }, {}))).rejects.toThrow("pass the new values as a plain object");
});

test("immediate update sets a nullable column to NULL", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new DxContext(provider(log));
  await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ publishedAt: null, views: 0 })).resolves.toEqual({ affectedRows: 2 });
  expect(log).toEqual([{ sql: 'UPDATE "immediate_dx_rows" SET "publishedAt" = $1, "views" = $2 WHERE "id" = $3', params: [null, 0, 1] }]);
});

test("the tracked conflict names the entity and the way out", async () => {
  const db = new DxContext(provider([]));
  db.rows.attach(Object.assign(new DxRow(), { id: 5, title: "t", slug: "s" }));
  await expect(db.rows.asNoTracking().where(x => x.id.eq(1)).executeUpdate({ views: 1 })).rejects.toThrow('this context tracks "DxRow" entities (loaded with tracking or saved through saveChanges()), which the mutation would make stale. Load them with .asNoTracking(), or run the mutation in a separate DbContext.');
});

test("insertIfAbsent leaves an unset generated key to the database or a new UUID v7", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new DxContext(provider(log));
  const row = Object.assign(new DxRow(), { title: "A", slug: "a" });
  await expect(db.rows.insertIfAbsent(row, { conflictBy: x => [x.slug] })).resolves.toEqual({ inserted: true });
  expect(log[0]!.sql).toBe('INSERT INTO "immediate_dx_rows" ("title", "slug", "views", "publishedAt", "createdAt") VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("slug") DO NOTHING');
  expect(row.id).toBe(0); expect(db.stateOf(row)).toBe(EntityState.Detached);
  const v7 = Object.assign(new DxV7Row(), { code: "a" });
  await db.v7.insertIfAbsent(v7, { conflictBy: x => [x.code] });
  expect(log[1]!.sql).toBe('INSERT INTO "immediate_dx_v7_rows" ("id", "code") VALUES ($1, $2) ON CONFLICT ("code") DO NOTHING');
  expect(String(log[1]!.params[0])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(v7.id).toBe("");
  await db.v4.insertIfAbsent(Object.assign(new DxV4Row(), { code: "a" }), { conflictBy: x => [x.code] });
  expect(log[2]!.sql).toBe('INSERT INTO "immediate_dx_v4_rows" ("code") VALUES ($1) ON CONFLICT ("code") DO NOTHING');
  await expect(db.rows.insertIfAbsent({ title: "B", slug: "b" } as DxRow, { conflictBy: x => [x.slug] })).rejects.toThrow('"views" is missing; pass an entity with every mapped property of DxRow');
});

test("an undeclared conflict target lists the unique keys that would work", async () => {
  const log: { sql: string; params: readonly unknown[] }[] = []; const db = new DxContext(provider(log));
  const row = () => Object.assign(new DxRow(), { id: 1, title: "A", slug: "a" });
  await expect(db.rows.insertIfAbsent(row(), { conflictBy: (x) => [x.title] })).rejects.toThrow('conflictBy (title) is not the primary key or a unique index of DxRow. Use one of: (id), (slug); or declare @Index({ unique: true }) on these properties.');
  await expect(db.rows.insertIfAbsent(row(), { conflictBy: (x) => [x.slug, x.slug] })).rejects.toThrow('conflictBy lists "slug" more than once');
  const keys = Object.assign(new KeyRow(), { tenantKey: "t", sequence: 1, externalKey: "e", payload: "p" });
  await expect(new Context(provider(log)).keyRows.insertIfAbsent(keys, { conflictBy: (x) => [x.tenantKey] })).rejects.toThrow("Use one of: (tenantKey, sequence), (externalKey, tenantKey);");
  expect(log).toEqual([]);
});
