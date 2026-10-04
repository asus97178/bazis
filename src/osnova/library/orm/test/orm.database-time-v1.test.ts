import { expect, test } from "bun:test";
import { DbContext, DbContextOptions, OrmDatabaseTimeError, OrmTransactionScopeError, PostgresProvider, type DatabaseProvider, type DbExecutor, type ExecuteResult, type Row, type SqlDialect } from "../index";
import { observeProviderDispatch, postgresTransactionCapability, registerPostgresTransactionCapability } from "../Providers/ormTransactionRuntime";

const dialect: SqlDialect = { name: "postgres", supportsReturning: false, quoteId: (name) => name, qualifyTable: (model) => model.tableName, parameter: () => "$1", columnType: () => "text", encode: (value) => value as never, decode: (value) => value, rowLockClause: () => " FOR UPDATE", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "" };
function provider(epoch: unknown): DatabaseProvider {
  const executor: DbExecutor = { query: async (): Promise<Row[]> => [{ epoch_ms: epoch }], execute: async (): Promise<ExecuteResult> => ({ changes: 0, lastInsertId: 0 }) };
  let active = false;
  const transaction = async <T>(work: (value: DbExecutor) => Promise<T>): Promise<T> => { active = true; try { return await work(executor); } finally { active = false; } };
  const result: DatabaseProvider = { name: "test", dialect, query: executor.query, execute: executor.execute, transaction, transactionScope: transaction, isTransactionActive: () => active, ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {} };
  registerPostgresTransactionCapability(result, { databaseTime: async () => {
    const milliseconds = Number(epoch);
    if (!Number.isSafeInteger(milliseconds) || Number.isNaN(new Date(milliseconds).getTime())) throw new OrmDatabaseTimeError();
    return Object.freeze({ instant: Object.freeze(new Date(milliseconds)), epochMilliseconds: milliseconds, precision: "millisecond" as const });
  }, assertScopedClose: () => {}, quarantine: async () => {} });
  return result;
}
class Context extends DbContext { constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [] })); } }

test("databaseTime returns one immutable exact millisecond projection", async () => {
  const db = new Context(provider("1700000000123"));
  await db.transactionScope(async (transaction) => {
    const value = await transaction.databaseTime();
    expect(value.epochMilliseconds).toBe(1700000000123);
    expect(value.instant.getTime()).toBe(value.epochMilliseconds);
    expect(value.precision).toBe("millisecond");
    expect(Object.isFrozen(value)).toBe(true);
  });
});

test("databaseTime fails closed for fractional provider values", async () => {
  const db = new Context(provider("1.5"));
  await expect(db.transactionScope(async (transaction) => transaction.databaseTime())).rejects.toBeInstanceOf(OrmDatabaseTimeError);
});

test("registered PostgreSQL capability issues one exact statement, parses safely, and has no clock fallback", async () => {
  const postgres = new PostgresProvider({ options: {} });
  const rows: unknown[] = [0, "1700000000123", 1700000000123n, undefined, null, "", "01", "1.5", Number.NaN, Number.POSITIVE_INFINITY, "9007199254740992", {}];
  const statements: string[] = [];
  Object.defineProperty(postgres, "query", { value: async (sql: string): Promise<Row[]> => {
    statements.push(sql);
    return [{ epoch_ms: rows.shift() }];
  } });
  const capability = postgresTransactionCapability(postgres);
  if (!capability) throw new Error("PostgreSQL capability was not registered.");
  for (const expected of [0, 1700000000123, 1700000000123]) expect((await capability.databaseTime()).epochMilliseconds).toBe(expected);
  for (let index = 0; index < 9; index += 1) await expect(capability.databaseTime()).rejects.toBeInstanceOf(OrmDatabaseTimeError);
  expect(statements).toHaveLength(12);
  expect(new Set(statements)).toEqual(new Set(["SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS epoch_ms"]));
});

test("PostgreSQL capability returns fresh frozen projections and redacts native query failures", async () => {
  const postgres = new PostgresProvider({ options: {} });
  const rows: unknown[] = [1, 2]; let queryFails = false;
  Object.defineProperty(postgres, "query", { value: async (): Promise<Row[]> => {
    if (queryFails) throw new Error("SELECT secret_value FROM secrets");
    return [{ epoch_ms: rows.shift() }];
  } });
  const capability = postgresTransactionCapability(postgres);
  if (!capability) throw new Error("PostgreSQL capability was not registered.");
  const first = await capability.databaseTime();
  expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.instant)).toBe(true);
  first.instant.setTime(42);
  expect((await capability.databaseTime()).epochMilliseconds).toBe(2);
  queryFails = true;
  await expect(capability.databaseTime()).rejects.toBeInstanceOf(OrmDatabaseTimeError);
});

test("unawaited databaseTime is synchronously tracked, cancels its dispatch, and rolls back", async () => {
  let commits = 0; let rollbacks = 0; let cancellations = 0;
  const executor: DbExecutor = { query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }) };
  const value: DatabaseProvider = {
    name: "test", dialect, query: executor.query, execute: executor.execute,
    transaction: async (work) => work(executor),
    transactionScope: async (work) => {
      try { const result = await work(executor); commits += 1; return result; }
      catch (error) { rollbacks += 1; throw error; }
    },
    isTransactionActive: () => true, ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {},
  };
  registerPostgresTransactionCapability(value, {
    databaseTime: () => {
      let reject!: (reason: unknown) => void;
      const pending = new Promise<never>((_, rejectPending) => { reject = rejectPending; });
      // The registered capability uses the same private dispatch bridge as PostgreSQL runQuery.
      observeProviderDispatch({ cancel: () => { cancellations += 1; reject(new Error("cancelled")); }, settled: pending });
      return pending;
    },
    assertScopedClose: () => {}, quarantine: async () => {},
  });
  const db = new Context(value);
  await expect(db.transactionScope(async (transaction) => { void transaction.databaseTime().catch(() => {}); })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(commits).toBe(0); expect(rollbacks).toBe(1); expect(cancellations).toBe(1);
});
