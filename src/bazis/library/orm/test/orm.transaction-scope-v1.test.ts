import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Column, ConcurrentTransactionScopeError, DbContext, DbContextOptions, Entity, EntityState, Key, OrmProviderIdentityMismatchError, OrmTransactionScopeError, PostCommitError, withRetry, type DatabaseProvider, type DbExecutor, type ExecuteResult, type Row, type SqlDialect } from "../index";
import { observeProviderDispatch, registerPostgresTransactionCapability } from "../Providers/ormTransactionRuntime";
import { runPostCommitCallbacks, runRollbackCallbacks } from "../Providers/transactionCallbacks";
import { assertTransactionCanCommit, beginChildTransactionScope, createTransactionCallbackScope, endChildTransactionScope, mergeTransactionScopeCallbacks, type TransactionCallbackScope } from "../Providers/transactionScopes";
import { monitorWholeOperation, observedProvider, transactionScope } from "../Transactions/TransactionScopeCoordinator";
import { Validator } from "../../validation";

const dialect: SqlDialect = {
  name: "test", supportsReturning: false, quoteId: (name) => name, qualifyTable: (model) => model.tableName, parameter: () => "?", columnType: () => "text", encode: (value) => value as never, decode: (value) => value, rowLockClause: () => "", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "",
};
function provider(): DatabaseProvider {
  let executorCalls = 0;
  let executeWork: () => Promise<ExecuteResult> = async () => ({ changes: 1, lastInsertId: 0 });
  let queryWork: () => Promise<Row[]> = async () => [];
  let beforeTransaction: (() => void) | undefined;
  const executor: DbExecutor = { query: async (): Promise<Row[]> => { executorCalls += 1; return queryWork(); }, execute: async (): Promise<ExecuteResult> => { executorCalls += 1; return executeWork(); } };
  let active = false;
  let commits = 0; let rollbacks = 0;
  const callbackScopes = new AsyncLocalStorage<TransactionCallbackScope>();
  const transaction = async <T>(work: (value: DbExecutor) => Promise<T>): Promise<T> => {
    const parent = callbackScopes.getStore();
    if (parent) {
      const child = beginChildTransactionScope(parent);
      try {
        const value = await callbackScopes.run(child.callbacks, () => work(executor));
        assertTransactionCanCommit(child.callbacks); mergeTransactionScopeCallbacks(parent, child.callbacks);
        return value;
      } catch (error) { return runRollbackCallbacks(child.callbacks.afterRollback, error); }
      finally { endChildTransactionScope(parent, child.ownership); }
    }
    const callbacks = createTransactionCallbackScope(); active = true;
    let value: T;
    try { value = await callbackScopes.run(callbacks, async () => { const hook = beforeTransaction; beforeTransaction = undefined; hook?.(); return work(executor); }); assertTransactionCanCommit(callbacks); commits += 1; }
    catch (error) { rollbacks += 1; return runRollbackCallbacks(callbacks.afterRollback, error); }
    finally { active = false; }
    await runPostCommitCallbacks(callbacks.afterCommit);
    return value!;
  };
  const result: DatabaseProvider = { name: "test", dialect, query: executor.query, execute: executor.execute, transaction, transactionScope: transaction, isTransactionActive: () => active, afterCommit: (callback) => { const scope = callbackScopes.getStore(); return scope ? void scope.afterCommit.push(callback) : callback(); }, afterRollback: (callback) => { callbackScopes.getStore()?.afterRollback.push(callback); }, ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => {} };
  postgresCapability(result, { close: true, quarantine: async () => {} });
  (result as DatabaseProvider & { __executorCalls?: () => number; __commits?: () => number; __rollbacks?: () => number; __setExecute?: (work: () => Promise<ExecuteResult>) => void; __setQuery?: (work: () => Promise<Row[]>) => void; __beforeTransaction?: (work: () => void) => void }).__executorCalls = () => executorCalls;
  (result as DatabaseProvider & { __commits?: () => number }).__commits = () => commits;
  (result as DatabaseProvider & { __rollbacks?: () => number }).__rollbacks = () => rollbacks;
  (result as DatabaseProvider & { __setExecute?: (work: () => Promise<ExecuteResult>) => void }).__setExecute = (work) => { executeWork = work; };
  (result as DatabaseProvider & { __setQuery?: (work: () => Promise<Row[]>) => void }).__setQuery = (work) => { queryWork = work; };
  (result as DatabaseProvider & { __beforeTransaction?: (work: () => void) => void }).__beforeTransaction = (work) => { beforeTransaction = work; };
  return result;
}
class Context extends DbContext { constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [] })); } }
@Entity({ table: "transaction_scope_records" })
class TransactionScopeRecord { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) name = ""; }
@Entity({ table: "transaction_scope_generated_records" })
class GeneratedScopeRecord { @Key() id = 0; @Column({ type: "text" }) name = ""; }
class RecordContext extends DbContext { constructor(value: DatabaseProvider, executionStrategy?: { readonly maxRetries: number; readonly baseDelayMs: number; readonly isTransient: (error: unknown) => boolean }) { super(new DbContextOptions({ provider: value, entities: [TransactionScopeRecord], validateOnSave: false, executionStrategy })); } }
class GeneratedContext extends DbContext { constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [GeneratedScopeRecord], validateOnSave: false })); } }
let validationGate: Promise<void> | undefined;
let validationStarted: (() => void) | undefined;
@Entity({ table: "transaction_scope_validated_records" })
class ValidatedRecord {
  @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
  @Column({ type: "text" }) @Validator({ custom: async () => { validationStarted?.(); await validationGate; return true; } }) name = "validated";
}
class ValidatedContext extends DbContext { constructor(value: DatabaseProvider) { super(new DbContextOptions({ provider: value, entities: [ValidatedRecord] })); } }

function postgresCapability(value: DatabaseProvider, options: { readonly close?: boolean; readonly quarantine: () => Promise<void> | void; readonly quarantineOnPendingDispatch?: boolean }): void {
  registerPostgresTransactionCapability(value, {
    quarantineOnPendingDispatch: options.quarantineOnPendingDispatch,
    databaseTime: async () => ({ instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" }),
    assertScopedClose: () => { if (options.close !== true) throw new Error("no scoped close"); },
    quarantine: async () => options.quarantine(),
  });
}

test("undefined callback rejections roll back instead of committing", async () => {
  for (const work of [async () => { throw undefined; }, async () => Promise.reject(undefined)] as const) {
    let commits = 0;
    let rollbacks = 0;
    const value = {
      transactionScope: async <T>(callback: (executor: {}) => Promise<T>): Promise<T> => {
        try { const result = await callback({}); commits += 1; return result; }
        catch (error) { rollbacks += 1; throw error; }
      },
    } as unknown as DatabaseProvider;
    registerPostgresTransactionCapability(value, { databaseTime: async () => ({ instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" }), assertScopedClose: () => {}, quarantine: async () => {} });
    const outcome = await transactionScope({} as DbContext, value, work).then(() => "resolved", () => "rejected");
    expect(outcome).toBe("rejected");
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
  }
});

test("opaque scope enrolls its initiating context, nests, and revokes after completion", async () => {
  const db = new Context(provider());
  let retained: import("../index").OrmTransaction | undefined;
  const callbacks: string[] = [];
  await db.transactionScope(async (transaction) => {
    retained = transaction;
    transaction.afterCommit(() => { callbacks.push("committed"); });
  });
  expect(callbacks).toEqual(["committed"]);
  expect(retained).toBeDefined();
  expect(() => retained!.afterCommit(() => {})).toThrow(OrmTransactionScopeError);
});

test("use rejects a context configured with another provider object", async () => {
  const first = new Context(provider());
  const second = new Context(provider());
  await first.transactionScope(async (transaction) => {
    await expect(transaction.use(second, async () => undefined)).rejects.toBeInstanceOf(OrmProviderIdentityMismatchError);
  });
});

test("same-view Promise.all queries are allowed while a same-root context requires use enrollment", async () => {
  const value = provider(); const first = new Context(value); const second = new Context(value);
  await first.transactionScope(async (transaction) => {
    await Promise.all([first.database.querySqlRaw("SELECT 1"), first.database.querySqlRaw("SELECT 2")]);
    await expect(second.database.querySqlRaw("SELECT denied")).rejects.toBeInstanceOf(OrmTransactionScopeError);
    await transaction.use(second, async (enrolled) => { await enrolled.database.querySqlRaw("SELECT enrolled"); });
  });
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(3);
});

test("caught and unawaited use failures poison the owning scope before commit", async () => {
  for (const mode of ["caught", "unawaited"] as const) {
    const value = provider(); const first = new Context(value); const second = new Context(value);
    const result = first.transactionScope(async (transaction) => {
      if (mode === "caught") {
        await transaction.use(second, async () => { throw new Error("use failure"); }).catch(() => {});
      } else {
        let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
        void transaction.use(second, async () => { await pending; }).catch(() => {});
        setTimeout(release, 0);
      }
    });
    await expect(result).rejects.toBeInstanceOf(OrmTransactionScopeError);
    expect((value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number }).__commits()).toBe(0);
    expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(1);
  }
});

test("closing scope cancels an attached unresolved provider dispatch before rollback", async () => {
  const db = new Context(provider());
  let cancelled = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: pending, cancel: () => { cancelled += 1; release(); } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(cancelled).toBe(1);
});

test("cancel throwing quarantines only the scoped session", async () => {
  const value = provider();
  let quarantined = 0;
  let rootClosed = 0;
  value.close = async () => { rootClosed += 1; };
  let rejectHeld!: (error: unknown) => void;
  const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  postgresCapability(value, { close: true, quarantine: async () => { quarantined += 1; rejectHeld(new Error("retained session closed")); } });
  (value as { name: string }).name = "postgres";
  const db = new Context(value);
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: held, cancel: () => { throw new Error("cancel failed"); } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(quarantined).toBe(1);
  expect(rootClosed).toBe(0);
});

test("missing cancel quarantines only the scoped session", async () => {
  const value = provider();
  let quarantined = 0;
  let rootClosed = 0;
  value.close = async () => { rootClosed += 1; };
  let rejectHeld!: (error: unknown) => void;
  const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  postgresCapability(value, { close: true, quarantine: async () => { quarantined += 1; rejectHeld(new Error("retained session closed")); } });
  (value as { name: string }).name = "postgres";
  const db = new Context(value);
  await expect(db.transactionScope(async () => {
    // This is the private observer shape emitted by PostgresProvider when a
    // Bun Query has no callable cancel method.
    observeProviderDispatch({ settled: held, cancel: () => { throw new Error("Query.cancel unavailable"); } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(quarantined).toBe(1);
  expect(rootClosed).toBe(0);
});

test("non-settling dispatch reaches the fixed quarantine deadline", async () => {
  const value = provider();
  let quarantined = 0;
  let rejectHeld!: (error: unknown) => void;
  const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  postgresCapability(value, { close: true, quarantine: async () => { quarantined += 1; rejectHeld(new Error("retained session closed")); } });
  (value as { name: string }).name = "postgres";
  const db = new Context(value);
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: held, cancel: () => undefined });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(quarantined).toBe(1);
}, 7_000);

test("missing private scoped close rejects before callback effects", async () => {
  const value = provider();
  let calls = 0;
  postgresCapability(value, { quarantine: async () => {} });
  (value as { name: string }).name = "postgres";
  const db = new Context(value);
  await expect(db.transactionScope(async () => { calls += 1; })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(calls).toBe(0);
});

test("awaited use does not hide its attached unresolved provider dispatch", async () => {
  const value = provider();
  const first = new Context(value);
  const second = new Context(value);
  let cancelled = 0;
  let release!: () => void;
  await expect(first.transactionScope(async (transaction) => {
    await transaction.use(second, async () => {
      observeProviderDispatch({ settled: new Promise<void>((resolve) => { release = resolve; }), cancel: () => { cancelled += 1; release(); } });
    });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(cancelled).toBe(1);
});

function gateNested(value: DatabaseProvider): { readonly release: () => void; readonly started: Promise<void>; readonly childCalls: () => number } {
  const original = value.transactionScope!;
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let calls = 0;
  let first = true;
  value.transactionScope = async (work) => {
    if (first) { first = false; return original(work); }
    calls += 1; start();
    await new Promise<void>((resolve) => { release = resolve; });
    return original(work);
  };
  return { get release() { return release; }, started, childCalls: () => calls };
}

test("unawaited gated nested scope cannot commit or enter child work after parent closing", async () => {
  const value = provider(); const db = new Context(value); const gate = gateNested(value);
  let childEffects = 0;
  const result = db.transactionScope(async () => { void db.transactionScope(async () => { childEffects += 1; }).catch(() => {}); await gate.started; });
  // Yield an event-loop turn so the parent callback has returned and the
  // coordinator has synchronously entered closing before unblocking SAVEPOINT.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  gate.release();
  await expect(result).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(gate.childCalls()).toBe(1);
  expect(childEffects).toBe(0);
});

test("parent closing cancels an already-running child dispatch without quarantine or late DML", async () => {
  const value = provider(); const db = new Context(value); let cancelled = 0; let quarantined = 0; let started!: () => void; let release!: () => void; let lateDml = 0;
  const began = new Promise<void>((resolve) => { started = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
  postgresCapability(value, { close: true, quarantine: async () => { quarantined += 1; } });
  const outer = db.transactionScope(async () => {
    void db.transactionScope(async () => { observeProviderDispatch({ settled: pending, cancel: () => { cancelled += 1; release(); } }); started(); await pending; await db.database.querySqlRaw("late"); lateDml += 1; }).catch(() => {});
    await began;
  });
  await expect(outer).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(cancelled).toBe(1); expect(quarantined).toBe(0); expect(lateDml).toBe(0);
  const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
  expect(counters.__commits()).toBe(0); expect(counters.__rollbacks()).toBe(1);
});

test("parent closing recursively cancels an already-running grandchild dispatch exactly once", async () => {
  const value = provider(); const db = new Context(value); let cancelled = 0; let quarantined = 0; let started!: () => void; let release!: () => void; let lateDml = 0;
  const began = new Promise<void>((resolve) => { started = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
  postgresCapability(value, { close: true, quarantine: async () => { quarantined += 1; } });
  const outer = db.transactionScope(async () => {
    void db.transactionScope(async () => {
      void db.transactionScope(async () => { observeProviderDispatch({ settled: pending, cancel: () => { cancelled += 1; release(); } }); started(); await pending; await db.database.querySqlRaw("late"); lateDml += 1; }).catch(() => {});
      await began;
    }).catch(() => {});
    await began;
  });
  await expect(outer).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(cancelled).toBe(1); expect(quarantined).toBe(0); expect(lateDml).toBe(0);
  const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
  expect(counters.__commits()).toBe(0); expect(counters.__rollbacks()).toBe(1);
});

test("awaited nested scope releases parent for a subsequent provider query", async () => {
  const value = provider(); const db = new Context(value); const gate = gateNested(value);
  let queries = 0; value.query = async () => { queries += 1; return []; };
  await db.transactionScope(async () => { const child = db.transactionScope(async () => undefined); await gate.started; gate.release(); await child; await db.database.querySqlRaw("SELECT 1"); });
  expect(gate.childCalls()).toBe(1); expect(queries).toBe(1);
});

test("sequential nested children both succeed", async () => {
  const value = provider(); const db = new Context(value); let effects = 0;
  await db.transactionScope(async () => { await db.transactionScope(async () => { effects += 1; }); await db.transactionScope(async () => { effects += 1; }); });
  expect(effects).toBe(2);
});

test("sibling scope and parent query reject before dispatch while child is active", async () => {
  const value = provider(); const db = new Context(value); const gate = gateNested(value); let queries = 0;
  value.query = async () => { queries += 1; return []; };
  await db.transactionScope(async () => {
    const child = db.transactionScope(async () => undefined); await gate.started;
    await expect(db.transactionScope(async () => undefined)).rejects.toBeInstanceOf(ConcurrentTransactionScopeError);
    await expect(db.database.querySqlRaw("SELECT 1")).rejects.toBeInstanceOf(OrmTransactionScopeError);
    gate.release(); await child;
  });
  expect(queries).toBe(0); expect(gate.childCalls()).toBe(1);
});

test("escaped transaction executor rejects after its owning ORM scope", async () => {
  const value = provider(); const db = new Context(value); let calls = 0;
  value.query = async () => { calls += 1; return []; };
  let escaped!: DbExecutor;
  await db.transactionScope(async () => { await db.database.transaction(async (executor) => { escaped = executor; }); });
  await expect(escaped.query("SELECT 1", [])).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
});

test("parent executor rejects before SQL while a child owns the savepoint", async () => {
  const value = provider(); const db = new Context(value); const gate = gateNested(value); let calls = 0;
  value.query = async () => { calls += 1; return []; };
  await db.transactionScope(async () => {
    let executor!: DbExecutor;
    await db.database.transaction(async (captured) => { executor = captured; });
    const child = db.transactionScope(async () => undefined); await gate.started;
    await expect(executor.query("SELECT 1", [])).rejects.toBeInstanceOf(OrmTransactionScopeError);
    gate.release(); await child;
  });
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
});

test("awaited transaction executor dispatches inside its owning scope", async () => {
  const value = provider(); const db = new Context(value); let calls = 0;
  value.query = async () => { calls += 1; return []; };
  await db.transactionScope(async () => { await db.database.transaction(async (executor) => { await executor.query("SELECT 1", []); }); });
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(1);
});

test("schema capability preserves metadata, owner and private trace hook while active", async () => {
  const value = provider(); const db = new Context(value); let calls = 0; let trace = 0;
  (value as { schemaAdmissionCapability?: unknown }).schemaAdmissionCapability = {
    version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true,
    withSchemaAdmission: async (schemas: any, work: any) => {
      if (schemas[0] !== "x") throw new Error("schema owner mismatch");
      return work({ query: async () => { calls += 1; return []; }, execute: async () => ({ changes: 0, lastInsertId: 0 }), introspectExpected: async () => ({}), executeSchemaAdmission: async () => { trace += 1; return { changes: 0, lastInsertId: 0 }; } });
    },
  };
  const proxy = observedProvider(db, value); const cap = proxy.schemaAdmissionCapability!;
  expect([cap.version, cap.provider, cap.distributedLock, cap.transactionalDdl, cap.exactIntrospection]).toEqual([1, "postgres", true, true, true]);
  await db.transactionScope(async () => { await cap.withSchemaAdmission(["x"], async (scope) => { await scope.query("SELECT", []); await (scope as typeof scope & { executeSchemaAdmission: () => Promise<ExecuteResult> }).executeSchemaAdmission(); }); });
  expect(calls).toBe(1); expect(trace).toBe(1);
});

test("escaped schema scope rejects before provider dispatch", async () => {
  const value = provider(); const db = new Context(value); let calls = 0; let escaped!: DbExecutor;
  (value as { schemaAdmissionCapability?: unknown }).schemaAdmissionCapability = { version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true, withSchemaAdmission: async (_: any, work: any) => work({ query: async () => { calls += 1; return []; }, execute: async () => ({ changes: 0, lastInsertId: 0 }), introspectExpected: async () => ({}) }) };
  const cap = observedProvider(db, value).schemaAdmissionCapability!;
  await db.transactionScope(async () => { await cap.withSchemaAdmission(["x"], async (scope) => { escaped = scope; }); });
  await expect(escaped.query("SELECT", [])).rejects.toBeInstanceOf(OrmTransactionScopeError); expect(calls).toBe(0);
});

test("unawaited schema and migration callbacks poison closing scope while awaited callbacks succeed", async () => {
  for (const route of ["schema", "lock"] as const) {
    const value = provider(); const db = new Context(value); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const began = new Promise<void>((resolve) => { started = resolve; });
    (value as { schemaAdmissionCapability?: unknown }).schemaAdmissionCapability = { version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true, withSchemaAdmission: async (_: any, work: any) => { started(); await gate; return work({ query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), introspectExpected: async () => ({}) }); } };
    value.withMigrationLock = async (work) => { started(); await gate; return work(); };
    const proxy = observedProvider(db, value);
    const run = () => route === "schema" ? proxy.schemaAdmissionCapability!.withSchemaAdmission(["x"], async () => undefined) : proxy.withMigrationLock!(async () => undefined);
    const outer = db.transactionScope(async () => { void run().catch(() => {}); await began; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); release();
    await expect(outer).rejects.toBeInstanceOf(OrmTransactionScopeError);
    const awaitedValue = provider(); const awaitedDb = new Context(awaitedValue);
    (awaitedValue as { schemaAdmissionCapability?: unknown }).schemaAdmissionCapability = { version: 1, provider: "postgres", distributedLock: true, transactionalDdl: true, exactIntrospection: true, withSchemaAdmission: async (_: any, work: any) => work({ query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), introspectExpected: async () => ({}) }) };
    awaitedValue.withMigrationLock = async (work) => work(); const awaitedProxy = observedProvider(awaitedDb, awaitedValue);
    await awaitedDb.transactionScope(async () => route === "schema" ? awaitedProxy.schemaAdmissionCapability!.withSchemaAdmission(["x"], async () => undefined) : awaitedProxy.withMigrationLock!(async () => undefined));
  }
});

test("afterCommit runs once outside both private ALS views and can open a same-provider scope", async () => {
  const value = provider(); const db = new Context(value); let calls = 0; let nested = 0;
  await db.transactionScope(async (transaction) => {
    transaction.afterCommit(async () => { calls += 1; await db.transactionScope(async () => { nested += 1; }); });
  });
  const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
  expect(calls).toBe(1); expect(nested).toBe(1); expect(counters.__commits()).toBe(2); expect(counters.__rollbacks()).toBe(0);
});

test("released child callbacks wait for outer commit and failed child callbacks are discarded", async () => {
  const value = provider(); const db = new Context(value); const events: string[] = [];
  await db.transactionScope(async (outer) => {
    outer.afterCommit(() => { events.push("outer"); });
    await db.transactionScope(async (child) => { child.afterCommit(() => { events.push("released-child"); }); expect(events).toEqual([]); });
    await expect(db.transactionScope(async (child) => { child.afterCommit(() => { events.push("discarded-child"); }); throw new Error("child failure"); })).rejects.toThrow("child failure");
    expect(events).toEqual([]);
  });
  expect(events).toEqual(["outer", "released-child"]);
  const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
  expect(counters.__commits()).toBe(1); expect(counters.__rollbacks()).toBe(0);
});

test("afterCommit failure reports committed PostCommitError without rollback or retry", async () => {
  const value = provider(); const db = new Context(value); let callbackCalls = 0;
  await expect(db.transactionScope(async (transaction) => { transaction.afterCommit(() => { callbackCalls += 1; throw new Error("post-commit"); }); })).rejects.toBeInstanceOf(PostCommitError);
  const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
  expect(callbackCalls).toBe(1); expect(counters.__commits()).toBe(1); expect(counters.__rollbacks()).toBe(0);
});

test("PostCommitError retains committed tracker state and a later save is a real no-op", async () => {
  const value = provider(); const db = new RecordContext(value); const record = Object.assign(new TransactionScopeRecord(), { id: 1, name: "committed" });
  db.add(record);
  await expect(db.transactionScope(async (transaction) => {
    transaction.afterCommit(() => { throw new Error("post-commit"); });
    expect(await db.saveChanges()).toBe(1);
    expect(db.stateOf(record)).toBe(EntityState.Unchanged);
  })).rejects.toBeInstanceOf(PostCommitError);
  expect(db.stateOf(record)).toBe(EntityState.Unchanged);
  expect(await db.saveChanges()).toBe(0);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(1);
});

test("afterCommit mutation remains unsaved after the DML snapshot", async () => {
  for (const throws of [false, true]) {
    const value = provider(); const db = new RecordContext(value); const record = Object.assign(new TransactionScopeRecord(), { id: throws ? 8 : 7, name: "before" });
    db.add(record);
    const save = db.transactionScope(async (transaction) => {
      transaction.afterCommit(() => { record.name = "after"; if (throws) throw new Error("post-commit"); });
      expect(await db.saveChanges()).toBe(1);
    });
    if (throws) await expect(save).rejects.toBeInstanceOf(PostCommitError); else await expect(save).resolves.toBeUndefined();
    expect(await db.saveChanges()).toBe(1);
    expect(await db.saveChanges()).toBe(0);
    expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(2);
  }
});

test("top-level callback mutation preserves generated key through committed PostCommitError", async () => {
  for (const throws of [false, true]) {
    const value = provider(); const db = new GeneratedContext(value); const record = Object.assign(new GeneratedScopeRecord(), { name: "inserted" });
    const controls = value as DatabaseProvider & { __setQuery: (work: () => Promise<Row[]>) => void; __beforeTransaction: (work: () => void) => void; __executorCalls: () => number };
    controls.__setQuery(async () => [{ id: 41 }]);
    controls.__beforeTransaction(() => { value.afterCommit!(() => { record.name = "mutated"; if (throws) throw new Error("post-commit"); }); });
    db.add(record);
    if (throws) await expect(db.saveChanges()).rejects.toBeInstanceOf(PostCommitError); else expect(await db.saveChanges()).toBe(1);
    expect(record.id).toBe(41);
    expect(await db.saveChanges()).toBe(1);
    expect(await db.saveChanges()).toBe(0);
    expect(controls.__executorCalls()).toBe(2);
  }
});

test("accepted save snapshot is stable within its outer scope and preserves a later mutation", async () => {
  const value = provider(); const db = new RecordContext(value); const record = Object.assign(new TransactionScopeRecord(), { id: 9, name: "first" });
  db.add(record);
  await db.transactionScope(async () => {
    expect(await db.saveChanges()).toBe(1);
    expect(db.stateOf(record)).toBe(EntityState.Unchanged);
    expect(await db.saveChanges()).toBe(0);
    record.name = "second";
    expect(await db.saveChanges()).toBe(1);
    expect(await db.saveChanges()).toBe(0);
  });
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(2);
});

test("mutation after an awaited save remains unsaved until after outer commit", async () => {
  const value = provider(); const db = new RecordContext(value); const record = Object.assign(new TransactionScopeRecord(), { id: 10, name: "first" });
  db.add(record);
  await db.transactionScope(async () => { expect(await db.saveChanges()).toBe(1); record.name = "after-save"; });
  expect(await db.saveChanges()).toBe(1);
  expect(await db.saveChanges()).toBe(0);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(2);
});

test("configured SaveExecutor retries outside a new ORM scope but never inside one", async () => {
  for (const inside of [false, true]) {
    const value = provider(); let attempts = 0;
    (value as DatabaseProvider & { __setExecute: (work: () => Promise<ExecuteResult>) => void }).__setExecute(async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); return { changes: 1, lastInsertId: 0 }; });
    const db = new RecordContext(value, { maxRetries: 1, baseDelayMs: 0, isTransient: () => true }); db.add(Object.assign(new TransactionScopeRecord(), { id: inside ? 2 : 3, name: "retry" }));
    if (inside) await expect(db.transactionScope(async () => db.saveChanges())).rejects.toThrow("transient");
    else expect(await db.saveChanges()).toBe(1);
    expect(attempts).toBe(inside ? 1 : 2);
  }
});

test("SaveExecutor preserves top-level retry for a custom provider without an activity probe", async () => {
  const value = provider(); let attempts = 0;
  delete (value as { isTransactionActive?: unknown }).isTransactionActive;
  (value as DatabaseProvider & { __setExecute: (work: () => Promise<ExecuteResult>) => void }).__setExecute(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return { changes: 1, lastInsertId: 0 };
  });
  const db = new RecordContext(value, { maxRetries: 1, baseDelayMs: 0, isTransient: () => true });
  db.add(Object.assign(new TransactionScopeRecord(), { id: 4, name: "custom-no-probe" }));
  expect(await db.saveChanges()).toBe(1);
  expect(attempts).toBe(2);
});

test("withRetry remains conservative for a provider without an activity probe", async () => {
  const value = provider(); let attempts = 0;
  delete (value as { isTransactionActive?: unknown }).isTransactionActive;
  value.query = async () => { attempts += 1; throw new Error("transient"); };
  await expect(withRetry(value, { maxRetries: 1, baseDelayMs: 0, isTransient: () => true }).query("SELECT", [])).rejects.toThrow("transient");
  expect(attempts).toBe(1);
});

test("same base provider retains authority through retry wrappers while another provider rejects", async () => {
  const base = provider(); const first = new Context(withRetry(base)); const second = new Context(withRetry(withRetry(base)));
  await first.transactionScope(async (transaction) => {
    await transaction.use(second, async (used) => { await used.database.querySqlRaw("SELECT inherited"); });
  });
  const different = new Context(withRetry(provider()));
  await first.transactionScope(async (transaction) => {
    await expect(transaction.use(different, async (used) => used.database.querySqlRaw("SELECT denied"))).rejects.toBeInstanceOf(OrmProviderIdentityMismatchError);
  });
});

test("void async validation save is registered before validation and cannot dispatch after closing", async () => {
  const value = provider(); const db = new ValidatedContext(value); let release!: () => void;
  validationGate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { validationStarted = resolve; });
  db.add(Object.assign(new ValidatedRecord(), { id: 5 }));
  const scope = db.transactionScope(async () => { void db.saveChanges().catch(() => {}); await began; });
  await Promise.resolve();
  release();
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect((value as DatabaseProvider & { __executorCalls: () => number; __commits: () => number; __rollbacks: () => number }).__executorCalls()).toBe(0);
  expect((value as DatabaseProvider & { __commits: () => number }).__commits()).toBe(0);
  expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(1);
  validationGate = undefined; validationStarted = undefined;
});

test("awaited async validation save dispatches once and commits", async () => {
  const value = provider(); const db = new ValidatedContext(value); let release!: () => void;
  validationGate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { validationStarted = resolve; });
  db.add(Object.assign(new ValidatedRecord(), { id: 6 }));
  const scope = db.transactionScope(async () => { const save = db.saveChanges(); await began; release(); expect(await save).toBe(1); });
  await expect(scope).resolves.toBeUndefined();
  expect((value as DatabaseProvider & { __executorCalls: () => number; __commits: () => number; __rollbacks: () => number }).__executorCalls()).toBe(1);
  expect((value as DatabaseProvider & { __commits: () => number }).__commits()).toBe(1);
  expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(0);
  validationGate = undefined; validationStarted = undefined;
});

test("forever validator save is force-rejected after quarantine and late resume reaches no SQL", async () => {
  const value = provider(); const db = new ValidatedContext(value); let release!: () => void; let started!: () => void;
  validationGate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; }); validationStarted = started;
  db.add(Object.assign(new ValidatedRecord(), { id: 71 })); let save!: Promise<number>;
  const scope = db.transactionScope(async () => { save = db.saveChanges(); void save.then(() => {}, () => {}); await began; }); void scope.catch(() => {});
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(save!).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
  release(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
  validationGate = undefined; validationStarted = undefined;
}, 7_000);

test("detached forever child without dispatch aborts child and outer while late child SQL is fenced", async () => {
  const value = provider(); const db = new Context(value); let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void; const forever = new Promise<void>((resolve) => { release = resolve; }); let callbacks = 0; let lateSql = 0; let child!: Promise<void>;
  const outer = db.transactionScope(async () => {
    child = db.transactionScope(async () => { started(); await forever; await db.database.querySqlRaw("late").then(() => { lateSql += 1; }, () => {}); });
    void child.then(() => {}, () => {}); value.afterRollback?.(() => { callbacks += 1; }); await began;
  }); void outer.catch(() => {});
  await expect(outer).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(child!).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(callbacks).toBe(1); release(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(lateSql).toBe(0);
});

test("forever unawaited use without dispatch is force-rejected and fences late SQL after quarantine", async () => {
  const value = provider(); const outer = new Context(value); const used = new Context(value); let release!: () => void; const forever = new Promise<void>((resolve) => { release = resolve; }); let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; }); let callbacks = 0; let lateSql = 0; let use!: Promise<unknown>;
  const scope = outer.transactionScope(async (tx) => { value.afterRollback?.(() => { callbacks += 1; }); use = tx.use(used, async (context) => { started(); await forever; await context.database.querySqlRaw("late").then(() => { lateSql += 1; }, () => {}); }); void use.then(() => {}, () => {}); await began; }); void scope.catch(() => {});
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(use!).rejects.toBeInstanceOf(OrmTransactionScopeError); expect(callbacks).toBe(1);
  release(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(lateSql).toBe(0);
}, 7_000);

test("successful use query is preserved while a later forever JS tail is force-rejected and fenced", async () => {
  const value = provider(); const outer = new Context(value); const used = new Context(value); let release!: () => void; const forever = new Promise<void>((resolve) => { release = resolve; }); let queried!: () => void; const queryDone = new Promise<void>((resolve) => { queried = resolve; }); let callbacks = 0; let lateSql = 0; let use!: Promise<unknown>;
  const scope = outer.transactionScope(async (tx) => { value.afterRollback?.(() => { callbacks += 1; }); use = tx.use(used, async (context) => { expect(await context.database.querySqlRaw("successful")).toEqual([]); queried(); await forever; await context.database.querySqlRaw("late").then(() => { lateSql += 1; }, () => {}); }); void use.then(() => {}, () => {}); await queryDone; }); void scope.catch(() => {});
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError); await expect(use!).rejects.toBeInstanceOf(OrmTransactionScopeError); expect(callbacks).toBe(1);
  release(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(lateSql).toBe(0);
}, 7_000);

test("marked save inside forever use unwinds before a pre-registered rollback callback", async () => {
  const value = provider(); Object.defineProperty(value, "limits", { value: { ...value.limits, maxRowsPerInsert: 1 } });
  const outer = new Context(value); const used = new GeneratedContext(value); const first = Object.assign(new GeneratedScopeRecord(), { name: "first" }); const second = Object.assign(new GeneratedScopeRecord(), { name: "second" });
  used.add(first); used.add(second); let rejectHeld!: (error: unknown) => void; const held = new Promise<Row[]>((_, reject) => { rejectHeld = reject; });
  let saveStarted!: () => void; const began = new Promise<void>((resolve) => { saveStarted = resolve; }); let callbackState: readonly EntityState[] | undefined; let callbacks = 0; let queries = 0;
  (value as DatabaseProvider & { __setQuery: (work: () => Promise<Row[]>) => void }).__setQuery(async () => { queries += 1; if (queries === 1) return [{ id: 41 }]; observeProviderDispatch({ settled: held, cancel: () => { throw new Error("cancel unavailable"); } }); saveStarted(); return held; });
  postgresCapability(value, { close: true, quarantine: async () => { rejectHeld(new Error("retained reservation closed")); } });
  let save!: Promise<number>; let use!: Promise<unknown>; const forever = new Promise<void>(() => {});
  const scope = outer.transactionScope(async (tx) => {
    value.afterRollback?.(() => { callbacks += 1; callbackState = [used.stateOf(first), used.stateOf(second)]; expect(first.id).toBe(0); });
    use = tx.use(used, async (context) => { save = context.saveChanges(); void save.then(() => {}, () => {}); await forever; }); void use.then(() => {}, () => {}); await began;
    expect(first.id).toBe(41);
  }); void scope.catch(() => {});
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(save!).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(use!).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(callbacks).toBe(1); expect(callbackState).toEqual([EntityState.Added, EntityState.Added]); expect(first.id).toBe(0); expect(used.stateOf(first)).toBe(EntityState.Added); expect(used.stateOf(second)).toBe(EntityState.Added);
}, 7_000);

test("late descendants after awaited root tasks form a new cancellable record", async () => {
  for (const route of ["monitor", "use"] as const) {
    const value = provider(); let queries = 0; let cancellations = 0; let release!: () => void; let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    value.query = async () => { queries += 1; observeProviderDispatch({ settled: pending, cancel: () => { cancellations += 1; release(); } }); started(); await pending; return []; };
    if (route === "monitor") {
      const context = {}; const proxy = observedProvider(context, value);
      await expect(transactionScope(context as DbContext, value, async () => {
        await monitorWholeOperation(context, async () => { await Promise.resolve(); setImmediate(() => { void proxy.query("late", []).catch(() => {}); }); });
        await began;
      })).rejects.toBeInstanceOf(OrmTransactionScopeError);
    } else {
      const first = new Context(value); const second = new Context(value);
      await expect(first.transactionScope(async (transaction) => {
        await transaction.use(second, async (used) => { await Promise.resolve(); setImmediate(() => { void used.database.querySqlRaw("late").catch(() => {}); }); });
        await began;
      })).rejects.toBeInstanceOf(OrmTransactionScopeError);
    }
    const counters = value as DatabaseProvider & { __commits: () => number; __rollbacks: () => number };
    expect(queries).toBe(1); expect(cancellations).toBe(1); expect(counters.__commits()).toBe(0); expect(counters.__rollbacks()).toBe(1);
  }
});

test("parent databaseTime rejects before provider dispatch while child owns the savepoint", async () => {
  const value = provider(); const db = new Context(value); let databaseTimeCalls = 0;
  registerPostgresTransactionCapability(value, { databaseTime: async () => { databaseTimeCalls += 1; return { instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" as const }; }, assertScopedClose: () => {}, quarantine: async () => {} });
  await db.transactionScope(async (outer) => {
    await db.transactionScope(async () => {
      await expect(outer.databaseTime()).rejects.toBeInstanceOf(OrmTransactionScopeError);
    });
  });
  expect(databaseTimeCalls).toBe(0);
});

test("parent-view databaseTime rejects before provider dispatch while a child is pending", async () => {
  const value = provider(); const db = new Context(value); let databaseTimeCalls = 0; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const began = new Promise<void>((resolve) => { started = resolve; });
  registerPostgresTransactionCapability(value, { databaseTime: async () => { databaseTimeCalls += 1; return { instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" as const }; }, assertScopedClose: () => {}, quarantine: async () => {} });
  await db.transactionScope(async (outer) => {
    const child = db.transactionScope(async () => { started(); await gate; }); await began;
    await expect(outer.databaseTime()).rejects.toBeInstanceOf(OrmTransactionScopeError);
    release(); await child;
  });
  expect(databaseTimeCalls).toBe(0);
});

test("transaction capability has no discoverable runtime frame authority", async () => {
  const db = new Context(provider()); let retained: object | undefined;
  await db.transactionScope(async (transaction) => { retained = transaction; });
  expect(Object.getOwnPropertyNames(retained!)).toEqual([]);
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(retained!))).not.toContain("requireCurrentFrame");
});

test("physical quarantine rejects a detached use projection and fences late SQL", async () => {
  const value = provider(); const outer = new Context(value); const child = new Context(value);
  let rejectHeld!: (error: unknown) => void;
  const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  let callbacks = 0; let lateSql = 0;
  postgresCapability(value, { close: true, quarantine: async () => { rejectHeld(new Error("retained owner closed")); } });
  const outerOutcome = outer.transactionScope(async (tx) => {
    const childOutcome = tx.use(child, async (used) => {
      observeProviderDispatch({ settled: held, cancel: () => { throw new Error("cancel unavailable"); } });
      try { await held; } catch {
        await used.database.querySqlRaw("late").then(() => { lateSql += 1; }, () => {});
      }
    });
    // Attach the external consumer before the callback returns: it observes
    // the forced projection while the underlying user tail keeps its sink.
    void childOutcome.then(() => {}, () => {});
    value.afterRollback?.(() => { callbacks += 1; });
  });
  await expect(outerOutcome).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(callbacks).toBe(1);
  expect(lateSql).toBe(0);
});

test("an awaited top-level callback is not assigned an artificial timeout", async () => {
  const db = new Context(provider()); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const scope = db.transactionScope(async () => { await gate; });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(await Promise.race([scope.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
  release();
  await expect(scope).resolves.toBeUndefined();
});

test("an already aborted signal rejects before provider admission or callback effects", async () => {
  const value = provider(); const db = new Context(value);
  let entered = 0; let callbacks = 0;
  const original = value.transactionScope!;
  value.transactionScope = (work) => { entered += 1; return original(work); };
  await expect(db.transactionScope(async () => { callbacks += 1; }, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(entered).toBe(0); expect(callbacks).toBe(0);
});

test("invalid signals reject before provider admission", async () => {
  const value = provider(); const db = new Context(value);
  let entered = 0;
  const original = value.transactionScope!;
  value.transactionScope = (work) => { entered += 1; return original(work); };
  for (const signal of [null, {}, { aborted: false, addEventListener() {}, removeEventListener() {} }]) {
    await expect(db.transactionScope(async () => {}, { signal: signal as unknown as AbortSignal })).rejects.toBeInstanceOf(TypeError);
  }
  expect(entered).toBe(0);
});

test("abort during reservation admission never enters the callback", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let callbacks = 0;
  (value as DatabaseProvider & { __beforeTransaction: (work: () => void) => void }).__beforeTransaction(() => controller.abort());
  await expect(db.transactionScope(async () => { callbacks += 1; }, { signal: controller.signal })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(callbacks).toBe(0);
  expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(1);
});

test("abort during scoped close admission never enters the callback", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let callbacks = 0;
  registerPostgresTransactionCapability(value, {
    databaseTime: async () => ({ instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" }),
    assertScopedClose: async () => { await Promise.resolve(); controller.abort(); }, quarantine: async () => {},
  });
  await expect(db.transactionScope(async () => { callbacks += 1; }, { signal: controller.signal })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(callbacks).toBe(0);
});

test("abort releases an awaited JS callback and fences its late SQL", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
  let late!: Promise<unknown>; let afterCommit = 0;
  const scope = db.transactionScope(async (tx) => {
    tx.afterCommit(() => { afterCommit += 1; }); entered(); await gate;
    late = db.database.querySqlRaw("late SQL"); await late;
  }, { signal: controller.signal });
  void scope.catch(() => {});
  await started; controller.abort();
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  resume(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(late!).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(afterCommit).toBe(0);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
});

test("abort fences both queued and newly attempted SQL synchronously", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let queued!: Promise<unknown>; let after!: Promise<unknown>;
  await expect(db.transactionScope(async () => {
    queued = db.database.querySqlRaw("queued"); void queued.catch(() => {});
    controller.abort();
    after = db.database.querySqlRaw("after abort"); void after.catch(() => {});
    await queued;
  }, { signal: controller.signal })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(queued).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(after).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
});

test("unqualified native cancellation closes the owner immediately without calling cancel", async () => {
  const value = provider(); const db = new Context(value); let cancelled = 0; let quarantined = 0;
  let rejectHeld!: (error: unknown) => void; const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  postgresCapability(value, { close: true, quarantineOnPendingDispatch: true, quarantine: () => { quarantined += 1; rejectHeld(new Error("closed")); } });
  const start = performance.now();
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: held, cancel: () => { cancelled += 1; } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(performance.now() - start).toBeLessThan(1_000);
  expect(cancelled).toBe(0); expect(quarantined).toBe(1);
});

test("an asynchronous cancel rejection promptly reaches quarantine with a rejection sink", async () => {
  const value = provider(); const db = new Context(value); let quarantined = 0;
  let rejectHeld!: (error: unknown) => void; const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  postgresCapability(value, { close: true, quarantine: () => { quarantined += 1; rejectHeld(new Error("closed")); } });
  const start = performance.now();
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: held, cancel: async () => { throw new Error("async cancel failed"); } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(performance.now() - start).toBeLessThan(1_000); expect(quarantined).toBe(1);
});

test("abort interrupts a pending JS drain instead of waiting five seconds", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let use!: Promise<unknown>; let quarantined = 0;
  postgresCapability(value, { close: true, quarantine: () => { quarantined += 1; } });
  const scope = db.transactionScope(async (tx) => {
    use = tx.use(db, async () => { entered(); await new Promise(() => {}); });
    void use.catch(() => {}); await started;
  }, { signal: controller.signal });
  void scope.catch(() => {});
  await started; await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const start = performance.now(); controller.abort();
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(use).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(performance.now() - start).toBeLessThan(1_000); expect(quarantined).toBe(1);
});

test("abort after successful COMMIT preserves the returned value and callback effects", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController(); let callbacks = 0;
  const result = await db.transactionScope(async (tx) => {
    tx.afterCommit(async () => { controller.abort(); await db.database.querySqlRaw("after commit"); callbacks += 1; });
    return 42;
  }, { signal: controller.signal });
  expect(result).toBe(42); expect(callbacks).toBe(1);
  expect((value as DatabaseProvider & { __commits: () => number }).__commits()).toBe(1);
  expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(0);
});

test("an already aborted child does not poison its still healthy parent", async () => {
  const value = provider(); const db = new Context(value);
  await db.transactionScope(async () => {
    await expect(db.transactionScope(async () => {}, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OrmTransactionScopeError);
    await db.database.querySqlRaw("parent continues");
  });
  expect((value as DatabaseProvider & { __commits: () => number }).__commits()).toBe(1);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(1);
});

test("abort after logical scope handoff does not interrupt provider COMMIT", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let handedOff!: () => void; const ready = new Promise<void>((resolve) => { handedOff = resolve; });
  let commit!: () => void; const gate = new Promise<void>((resolve) => { commit = resolve; });
  const original = value.transactionScope!;
  value.transactionScope = (work) => original(async (executor) => {
    const result = await work(executor); handedOff(); await gate; return result;
  });
  let callbacks = 0;
  const operation = db.transactionScope(async (tx) => { tx.afterCommit(() => { callbacks++; }); return 42; }, { signal: controller.signal });
  await ready; controller.abort(); commit();
  expect(await operation).toBe(42); expect(callbacks).toBe(1);
  expect((value as DatabaseProvider & { __commits: () => number }).__commits()).toBe(1);
  expect((value as DatabaseProvider & { __rollbacks: () => number }).__rollbacks()).toBe(0);
});

test("parent abort interrupts an already-closing child's JS drain and fences its late continuation", async () => {
  const value = provider(); const db = new Context(value); const controller = new AbortController();
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
  let late!: Promise<unknown>; let use!: Promise<unknown>;
  const outer = db.transactionScope(async () => db.transactionScope(async (tx) => {
    use = tx.use(db, async () => { started(); await gate; late = db.database.querySqlRaw("late child"); await late; });
    void use.catch(() => {}); await ready;
  }), { signal: controller.signal }); void outer.catch(() => {});
  await ready; await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const start = performance.now(); controller.abort();
  await expect(outer).rejects.toBeInstanceOf(OrmTransactionScopeError);
  await expect(use).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(performance.now() - start).toBeLessThan(1_000);
  resume(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(late).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect((value as DatabaseProvider & { __executorCalls: () => number }).__executorCalls()).toBe(0);
});
