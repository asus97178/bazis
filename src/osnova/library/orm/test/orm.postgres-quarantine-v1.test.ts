import { expect, test } from "bun:test";
import { DbContext, DbContextOptions, OrmTransactionScopeError, PostCommitError, type DatabaseProvider, type DbExecutor, type ExecuteResult, type Row, type SqlDialect } from "../index";
import { observeProviderDispatch, postgresTransactionCapability, registerPostgresTransactionCapability } from "../Providers/ormTransactionRuntime";
import { PostgresProvider } from "../Providers/PostgresProvider";

const dialect: SqlDialect = { name: "test", supportsReturning: false, quoteId: (v) => v, qualifyTable: (m) => m.tableName, parameter: () => "?", columnType: () => "text", encode: (v) => v as never, decode: (v) => v, rowLockClause: () => "", createTableSql: () => "", createIndexSql: () => [], createIndexSqlOne: () => "", addColumnSql: () => "", dropColumnSql: () => "" };
class Context extends DbContext { constructor(provider: DatabaseProvider) { super(new DbContextOptions({ provider, entities: [] })); } }

test("quarantine closes the private owner, not the root provider, after a real held dispatch rejects", async () => {
  let closeRoot = 0; let closeOwner = 0; let rejectDispatch!: (error: unknown) => void;
  const held = new Promise<void>((_, reject) => { rejectDispatch = reject; });
  const executor: DbExecutor = { query: async (): Promise<Row[]> => [], execute: async (): Promise<ExecuteResult> => ({ changes: 0, lastInsertId: 0 }) };
  const provider: DatabaseProvider = {
    name: "postgres", dialect, query: executor.query, execute: executor.execute,
    transaction: async (work) => work(executor), transactionScope: async (work) => work(executor),
    ping: async () => true, introspect: async () => ({ tables: new Map() }), close: async () => { closeRoot += 1; },
  };
  registerPostgresTransactionCapability(provider, {
    databaseTime: async () => ({ instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" }),
    assertScopedClose: async () => {},
    quarantine: async () => { closeOwner += 1; rejectDispatch(new Error("closed retained reservation")); },
  });
  const db = new Context(provider);
  await expect(db.transactionScope(async () => {
    observeProviderDispatch({ settled: held, cancel: () => { throw new Error("native cancel unavailable"); } });
  })).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(closeOwner).toBe(1);
  expect(closeRoot).toBe(0);
});

test("actual PostgresProvider owned reserve manually commits and releases before afterCommit", async () => {
  const events: string[] = []; let active = 0; let maxActive = 0; let rootClosed = 0;
  const root = {
    unsafe: async (sql: string): Promise<Row[]> => { events.push(`root:${sql}`); return []; },
    close: async (): Promise<void> => { rootClosed += 1; },
    reserve: async () => {
      active += 1; maxActive = Math.max(maxActive, active); events.push("reserve");
      return {
        unsafe: async (sql: string): Promise<Row[]> => {
          events.push(sql);
          if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }];
          if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }];
          return [];
        },
        close: async (): Promise<void> => {},
        release: async (): Promise<void> => { events.push("release"); active -= 1; },
      };
    },
  };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" });
  Object.defineProperty(provider, "sql", { value: root, configurable: true });
  const db = new Context(provider);
  await db.transactionScope(async () => {
    provider.afterCommit(async () => {
      events.push("afterCommit");
      await provider.transaction(async () => { events.push("callback transaction"); });
    });
  });
  expect(events).toContain("BEGIN");
  expect(events).toContain("COMMIT");
  expect(events.indexOf("release")).toBeLessThan(events.indexOf("afterCommit"));
  expect(events).toContain("callback transaction");
  expect(maxActive).toBe(1);
  expect(rootClosed).toBe(0);
  await provider.close();
  expect(rootClosed).toBe(1);
});

test("actual owner close rejects held SQL and waits for an exact root absence proof", async () => {
  let rejectHeld!: (error: unknown) => void; const held = new Promise<Row[]>((_, reject) => { rejectHeld = reject; });
  let prove!: (rows: Row[]) => void; const proof = new Promise<Row[]>((resolve) => { prove = resolve; });
  let rootProbe!: () => void; const rootProbed = new Promise<void>((resolve) => { rootProbe = resolve; });
  let released = 0; let callbacks = 0; let rootClosed = 0;
  let probes = 0; const badProofs: readonly Row[][] = [[], [{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000001", address: "127.0.0.1", port: "5432" }], [{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: "127.0.0.2", port: "5432" }], [{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: "127.0.0.1", port: "5433" }]];
  const root = {
    unsafe: async (): Promise<Row[]> => { rootProbe(); probes += 1; return probes <= badProofs.length ? badProofs[probes - 1]! : proof; }, close: async () => { rootClosed += 1; },
    reserve: async () => ({
      unsafe: async (sql: string): Promise<Row[]> => {
        if (sql === "held") return held;
        if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }];
        if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }];
        return [];
      },
      close: async (): Promise<void> => { rejectHeld(new Error("closed exact reservation")); },
      release: async (): Promise<void> => { released += 1; },
    }),
  };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true });
  const db = new Context(provider);
  const scope = db.transactionScope(async () => { void db.database.querySqlRaw("held").then(() => {}, () => {}); provider.afterRollback(() => { callbacks += 1; }); });
  void scope.then(() => {}, () => {});
  await rootProbed;
  await new Promise<void>((resolve) => setTimeout(resolve, 140));
  // A returned microsecond-only server mismatch is unconfirmed, not absence.
  expect(released).toBe(0); expect(callbacks).toBe(0); expect(rootClosed).toBe(0);
  prove([{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]);
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(released).toBe(1); expect(callbacks).toBe(1); expect(rootClosed).toBe(0);
});

test("actual close rejection still waits for root proof", async () => {
  let prove!: (rows: Row[]) => void; const proof = new Promise<Row[]>((resolve) => { prove = resolve; });
  let rejectHeld!: (error: unknown) => void; const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  let probed!: () => void; const started = new Promise<void>((resolve) => { probed = resolve; }); let callbacks = 0;
  const root = { unsafe: async (): Promise<Row[]> => { probed(); return proof; }, close: async (): Promise<void> => {}, reserve: async () => ({
    unsafe: async (sql: string): Promise<Row[]> => sql.startsWith("SELECT current_setting") ? [{ interval: "250ms" }] : sql.startsWith("SELECT pg_backend_pid") ? [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }] : [],
    close: async (): Promise<void> => { rejectHeld(new Error("native close rejected")); throw new Error("native close rejected"); }, release: async (): Promise<void> => {},
  }) };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
  const scope = db.transactionScope(async () => { observeProviderDispatch({ settled: held, cancel: () => { throw new Error("no cancel"); } }); provider.afterRollback(() => { callbacks += 1; }); }); void scope.catch(() => {});
  await started; expect(callbacks).toBe(0);
  prove([{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]);
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError); expect(callbacks).toBe(1);
});

test("actual malformed identity fields reject before callback or SQL effects", async () => {
  const valid = { pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" };
  const cases: readonly [string, Row][] = [
    ["pid syntax", { ...valid, pid: "42x" }], ["pid bound", { ...valid, pid: "2147483648" }], ["pid type", { ...valid, pid: 42 }],
    ["datid bound", { ...valid, datid: "4294967296" }], ["datid type", { ...valid, datid: 7 }],
    ["epoch precision", { ...valid, backend_start: "1.1" }], ["epoch type", { ...valid, postmaster_start: 2 }],
    ["port zero", { ...valid, port: "0" }], ["port range", { ...valid, port: "65536" }],
    ["invalid address", { ...valid, address: "not-an-ip" }], ["legacy ipv4 cidr", { ...valid, address: "127.0.0.1/32" }], ["legacy ipv6 cidr", { ...valid, address: "::1/128" }], ["invalid ipv6 word", { ...valid, address: "deadbeef" }], ["invalid ipv6 colon", { ...valid, address: ":" }], ["missing field", { ...valid, address: undefined }],
    ["object coercion", { ...valid, pid: { toString: () => "42" } }],
  ];
  for (const [, identity] of cases) {
    let effects = 0; let sqlEffects = 0;
    const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => ({
      unsafe: async (sql: string): Promise<Row[]> => { if (sql === "effect") sqlEffects += 1; if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (sql.startsWith("SELECT pg_backend_pid")) return [identity]; return []; }, close: async (): Promise<void> => {}, release: async (): Promise<void> => {},
    }) };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    const error = await db.transactionScope(async () => { effects += 1; await db.database.querySqlRaw("effect"); }).then(() => undefined, (reason) => reason);
    expect(error).toBeInstanceOf(OrmTransactionScopeError); expect(String((error as Error).message)).not.toContain("42"); expect(effects).toBe(0); expect(sqlEffects).toBe(0);
  }
});

test("actual falsey release failures remain committed PostCommitError after callbacks", async () => {
  for (const falsey of [undefined, null, false] as const) {
    let callbacks = 0;
    const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => ({
      unsafe: async (sql: string): Promise<Row[]> => sql.startsWith("SELECT current_setting") ? [{ interval: "250ms" }] : sql.startsWith("SELECT pg_backend_pid") ? [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }] : [],
      close: async (): Promise<void> => {}, release: async (): Promise<void> => Promise.reject(falsey),
    }) };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    const error = await db.transactionScope(async () => { provider.afterCommit(() => { callbacks += 1; }); }).then(() => undefined, (reason) => reason);
    expect(error).toBeInstanceOf(PostCommitError); expect((error as PostCommitError).errors).toEqual([falsey]); expect(callbacks).toBe(1);
  }
});

test("actual rollback aggregates original error and falsey release failure after callback", async () => {
  for (const falsey of [undefined, null, false] as const) {
    const original = new Error("original rollback"); let callbacks = 0;
    const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => ({
      unsafe: async (sql: string): Promise<Row[]> => sql.startsWith("SELECT current_setting") ? [{ interval: "250ms" }] : sql.startsWith("SELECT pg_backend_pid") ? [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }] : [],
      close: async (): Promise<void> => {}, release: async (): Promise<void> => Promise.reject(falsey),
    }) };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    const error = await db.transactionScope(async () => { provider.afterRollback(() => { callbacks += 1; }); throw original; }).then(() => undefined, (reason) => reason);
    expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([original, falsey]); expect(callbacks).toBe(1);
  }
});

test("captured owner executor is fenced while release waits and after falsey release rejection", async () => {
  let releaseStarted!: () => void; const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  let releaseGate!: () => void; const gate = new Promise<void>((resolve) => { releaseGate = resolve; }); let unsafeCalls = 0; let captured!: DbExecutor;
  const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => ({
    unsafe: async (sql: string): Promise<Row[]> => { unsafeCalls += 1; if (sql === "BEGIN" || sql === "COMMIT") return []; return []; }, close: async (): Promise<void> => {},
    release: async (): Promise<void> => { releaseStarted(); await gate; return Promise.reject(undefined); },
  }) };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true });
  const transaction = provider.transaction(async (tx) => { captured = tx; }); void transaction.catch(() => {});
  await started;
  await expect(captured.query("captured during release", [])).rejects.toThrow("no longer active"); expect(unsafeCalls).toBe(2);
  releaseGate();
  await expect(transaction).rejects.toBeInstanceOf(PostCommitError);
  await expect(captured.execute("captured after release", [])).rejects.toThrow("no longer active"); expect(unsafeCalls).toBe(2);
});

test("inherited stale owned and borrowed ALS cannot issue schema advisory SQL after release", async () => {
  for (const borrowed of [false, true]) {
    let xactLocks = 0; let effects = 0; let late!: () => void; const done = new Promise<void>((resolve) => { late = resolve; });
    const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => ({
      unsafe: async (sql: string): Promise<Row[]> => { if (sql.includes("pg_advisory_xact_lock")) xactLocks += 1; return []; }, close: async (): Promise<void> => {}, release: async (): Promise<void> => {},
    }) };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true });
    const work = async () => provider.transaction(async () => {
      setTimeout(async () => {
        try { await provider.schemaAdmissionCapability!.withSchemaAdmission(["public"], async () => { effects += 1; }); } catch { /* expected stale-owner fence */ }
        finally { late(); }
      }, 0);
    });
    if (borrowed) await provider.withMigrationLock!(work); else await work();
    await done;
    expect(xactLocks).toBe(0); expect(effects).toBe(0);
  }
});

test("actual missing reserve or admission close/SET/readback rejects before effects while raw begin fallback remains usable", async () => {
  const cases: readonly [string, { reserve?: () => Promise<unknown>; begin?: (work: (session: unknown) => Promise<unknown>) => Promise<unknown> }][] = [
    ["missing reserve", { begin: async (work) => work({ unsafe: async () => [] }) }],
    ["missing close", { reserve: async () => ({ unsafe: async () => [], release: async () => {} }) }],
    ["SET failure", { reserve: async () => ({ unsafe: async (sql: string) => { if (sql.startsWith("SET LOCAL")) throw new Error("set failed"); return []; }, close: async () => {}, release: async () => {} }) }],
    ["readback failure", { reserve: async () => ({ unsafe: async (sql: string) => sql.startsWith("SELECT current_setting") ? [{ interval: "1s" }] : [], close: async () => {}, release: async () => {} }) }],
  ];
  for (const [name, shape] of cases) {
    let effects = 0; const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, ...shape };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    await expect(db.transactionScope(async () => { effects += 1; })).rejects.toBeInstanceOf(OrmTransactionScopeError); expect(effects, name).toBe(0);
    if (name === "missing reserve") await expect(provider.transaction(async () => "raw fallback")).resolves.toBe("raw fallback");
  }
});

test("actual healthy borrowed migration reservation is retained through inner scope and unlock failures remain visible", async () => {
  for (const unlockFails of [false, true]) {
    let reserves = 0; let releases = 0; let locks = 0; let unlocks = 0;
    const root = { unsafe: async (): Promise<Row[]> => [], close: async (): Promise<void> => {}, reserve: async () => {
      reserves += 1; return { unsafe: async (sql: string): Promise<Row[]> => { if (sql.includes("pg_advisory_lock")) locks += 1; if (sql.includes("pg_advisory_unlock")) { unlocks += 1; if (unlockFails) throw new Error("unlock failed"); } if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]; return []; }, close: async (): Promise<void> => {}, release: async (): Promise<void> => { releases += 1; } };
    } };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    const operation = provider.withMigrationLock!(async () => { await db.transactionScope(async () => {}); expect(reserves).toBe(1); expect(releases).toBe(0); expect(locks).toBe(1); expect(unlocks).toBe(0); });
    if (unlockFails) await expect(operation).rejects.toThrow("unlock failed"); else await expect(operation).resolves.toBeUndefined();
    expect(reserves).toBe(1); expect(releases).toBe(1); expect(unlocks).toBe(1);
  }
});

test("normal failed child rollback callback retains parent ambient and revokes its transaction", async () => {
  let reserves = 0; let rootUnsafe = 0; let commits = 0; let childCallbacks = 0; let activeInChildCallback: boolean | undefined;
  const root = { unsafe: async (): Promise<Row[]> => { rootUnsafe += 1; return []; }, close: async (): Promise<void> => {}, reserve: async () => { reserves += 1; return {
    unsafe: async (sql: string): Promise<Row[]> => { if (sql === "COMMIT") commits += 1; if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]; return []; }, close: async (): Promise<void> => {}, release: async (): Promise<void> => {},
  }; } };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider); let retained: import("../index").OrmTransaction | undefined;
  await db.transactionScope(async () => {
    await expect(db.transactionScope(async (child) => { retained = child; provider.afterRollback(() => { childCallbacks += 1; activeInChildCallback = provider.isTransactionActive(); }); throw new Error("child failed"); })).rejects.toThrow("child failed");
    expect(() => retained!.afterCommit(() => {})).toThrow(OrmTransactionScopeError); await expect(retained!.databaseTime()).rejects.toBeInstanceOf(OrmTransactionScopeError);
    expect(await db.database.querySqlRaw("parent continues")).toEqual([]);
  });
  expect(reserves).toBe(1); expect(rootUnsafe).toBe(0); expect(childCallbacks).toBe(1); expect(activeInChildCallback).toBe(true); expect(commits).toBe(1);
});

test("concurrent constructor quarantine in an inner scope closes once and poisons raw outer callbacks", async () => {
  let rejectHeld!: (error: unknown) => void; const held = new Promise<void>((_, reject) => { rejectHeld = reject; });
  let closeCalls = 0; let releases = 0; let rootClosed = 0; let childRollback = 0; let rootRollback = 0; let afterCommit = 0; let commits = 0; let lateCallbackDispatch = 0;
  const root = { unsafe: async (): Promise<Row[]> => [{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }], close: async (): Promise<void> => { rootClosed += 1; }, reserve: async () => ({
    unsafe: async (sql: string): Promise<Row[]> => { if (sql === "COMMIT") commits += 1; if (sql === "late-child-callback") lateCallbackDispatch += 1; if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]; return []; },
    close: async (): Promise<void> => { closeCalls += 1; rejectHeld(new Error("closed retained reservation")); }, release: async (): Promise<void> => { releases += 1; },
  }) };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
  const outer = provider.transaction(async () => {
    provider.afterRollback(() => { rootRollback += 1; }); provider.afterCommit(() => { afterCommit += 1; });
    await db.transactionScope(async () => {
      provider.afterRollback(async () => { childRollback += 1; await provider.query("late-child-callback", []).then(() => {}, () => {}); }); observeProviderDispatch({ settled: held, cancel: () => { throw new Error("cancel unavailable"); } });
      const capability = postgresTransactionCapability(provider)!; await Promise.all([capability.quarantine(), capability.quarantine()]); throw new Error("inner quarantine");
    }).catch(() => {});
  }); void outer.catch(() => {});
  await expect(outer).rejects.toThrow();
  expect(closeCalls).toBe(1); expect(releases).toBe(1); expect(rootClosed).toBe(0); expect(childRollback).toBe(1); expect(rootRollback).toBe(1); expect(afterCommit).toBe(0); expect(commits).toBe(0); expect(lateCallbackDispatch).toBe(0);
});

for (const [label, reuse] of [["changed backend_start", { datid: "7", backend_start: "1.000001" }], ["changed datid", { datid: "8", backend_start: "1.000000" }]] as const) test(`root probe throw stays pending until same-server PID reuse with ${label} proves the original backend gone`, async () => {
  let rejectHeld!: (error: unknown) => void; const held = new Promise<Row[]>((_, reject) => { rejectHeld = reject; });
  let probes = 0; let closeCalls = 0; let releases = 0; let callbacks = 0; let rootClosed = 0;
  const root = { unsafe: async (): Promise<Row[]> => { probes += 1; if (probes === 1) throw new Error("probe unavailable"); return [{ pid: "42", ...reuse, postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]; }, close: async (): Promise<void> => { rootClosed += 1; }, reserve: async () => ({
    unsafe: async (sql: string): Promise<Row[]> => { if (sql === "held") return held; if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (sql.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" }]; return []; },
    close: async (): Promise<void> => { closeCalls += 1; rejectHeld(new Error("closed exact reservation")); }, release: async (): Promise<void> => { releases += 1; },
  }) };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
  const scope = db.transactionScope(async () => { void db.database.querySqlRaw("held").then(() => {}, () => {}); provider.afterRollback(() => { callbacks += 1; }); }); void scope.catch(() => {});
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(probes).toBe(1); expect(releases).toBe(0); expect(callbacks).toBe(0);
  await expect(scope).rejects.toBeInstanceOf(OrmTransactionScopeError);
  expect(probes).toBeGreaterThanOrEqual(2); expect(closeCalls).toBe(1); expect(releases).toBe(1); expect(callbacks).toBe(1); expect(rootClosed).toBe(0);
});

test("actual proof table rejects malformed, foreign and still-present rows until explicit all-null absence", async () => {
  const server = { postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" };
  const present = { pid: "42", datid: "7", backend_start: "1.000000", ...server };
  const variants: readonly Row[][] = [[], [{ pid: null, datid: null, backend_start: "1.000000", ...server }], [{ pid: undefined, datid: undefined, backend_start: undefined, ...server }], [{ pid: { toString: () => "42" }, datid: "7", backend_start: "1.000000", ...server }], [{ pid: "42x", datid: "7", backend_start: "1.000000", ...server }], [{ pid: "2147483648", datid: "7", backend_start: "1.000000", ...server }], [{ pid: "43", datid: "7", backend_start: "1.000000", ...server }], [present]];
  let prove!: (rows: Row[]) => void; const proof = new Promise<Row[]>((resolve) => { prove = resolve; }); let ready!: () => void; const proofGated = new Promise<void>((resolve) => { ready = resolve; }); let probes = 0; let releases = 0; let callbacks = 0;
  const root = { unsafe: async (): Promise<Row[]> => { probes += 1; if (probes <= variants.length) return variants[probes - 1]!; ready(); return proof; }, close: async (): Promise<void> => {}, reserve: async () => ({
    unsafe: async (sql: string): Promise<Row[]> => sql.startsWith("SELECT current_setting") ? [{ interval: "250ms" }] : sql.startsWith("SELECT pg_backend_pid") ? [{ pid: "42", datid: "7", backend_start: "1.000000", ...server }] : [], close: async (): Promise<void> => {}, release: async (): Promise<void> => { releases += 1; },
  }) };
  const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
  const scope = db.transactionScope(async () => { provider.afterRollback(() => { callbacks += 1; }); const q = postgresTransactionCapability(provider)!.quarantine(); void q.catch(() => {}); await new Promise<void>((resolve) => setTimeout(resolve, 0)); await q; throw new Error("quarantined"); }); void scope.catch(() => {});
  await proofGated;
  expect(probes).toBe(variants.length + 1); expect(releases).toBe(0); expect(callbacks).toBe(0);
  prove([{ pid: null, datid: null, backend_start: null, ...server }]);
  await expect(scope).rejects.toThrow("quarantined"); expect(releases).toBe(1); expect(callbacks).toBe(1);
});

test("actual identity capture and root proof use host-normalized IPv4 and IPv6 addresses", async () => {
  for (const address of ["127.0.0.1", "::1"]) {
    let rejectHeld!: (error: unknown) => void; const held = new Promise<Row[]>((_, reject) => { rejectHeld = reject; }); const sql: string[] = [];
    const addressFor = (query: string) => query.includes("host(inet_server_addr())") ? address : query.includes("inet_server_addr()::text") ? `${address}${address.includes(":") ? "/128" : "/32"}` : (() => { throw new Error("identity SQL did not select server address"); })();
    const root = { unsafe: async (query: string): Promise<Row[]> => { sql.push(query); return [{ pid: null, datid: null, backend_start: null, postmaster_start: "2.000000", address: addressFor(query), port: "5432" }]; }, close: async (): Promise<void> => {}, reserve: async () => ({ unsafe: async (query: string): Promise<Row[]> => { sql.push(query); if (query === "held") return held; if (query.startsWith("SELECT current_setting")) return [{ interval: "250ms" }]; if (query.startsWith("SELECT pg_backend_pid")) return [{ pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: addressFor(query), port: "5432" }]; return []; }, close: async (): Promise<void> => { rejectHeld(new Error("closed")); }, release: async (): Promise<void> => {} }) };
    const provider = new PostgresProvider({ options: {}, cancellationMode: "close" }); Object.defineProperty(provider, "sql", { value: root, configurable: true }); const db = new Context(provider);
    await expect(db.transactionScope(async () => { void db.database.querySqlRaw("held").then(() => {}, () => {}); })).rejects.toBeInstanceOf(OrmTransactionScopeError);
    expect(sql.filter((query) => query.includes("host(inet_server_addr())")).length).toBe(2);
  }
});
