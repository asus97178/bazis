import { expect, test } from "bun:test";
import { DbContext, DbContextOptions, PostgresProvider, type PostgresOperationEvent, type Row } from "../index";

class Context extends DbContext {}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture(options: { hang?: string; epochChanged?: boolean; probeHangs?: boolean; closeHangs?: boolean; deadline?: number; limit?: number } = {}) {
  const events: string[] = [], telemetry: PostgresOperationEvent[] = [];
  const held = deferred<Row[]>(), started = deferred<void>();
  const identity = { pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" };
  const provider = new PostgresProvider({ cancellationMode: "close", operationTimeoutMs: options.deadline ?? 80, cancellationTimeoutMs: 60, maxPendingOperations: options.limit ?? 16, onOperation: event => telemetry.push(event) });
  const session = {
    async unsafe(sql: string): Promise<Row[]> {
      events.push(sql);
      if (sql === (options.hang ?? "held")) { started.resolve(); return held.promise; }
      if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }];
      if (sql.startsWith("SELECT pg_backend_pid")) return [identity];
      return [];
    },
    async close() { events.push("close"); if (options.closeHangs) return new Promise<void>(() => {}); held.reject(new Error("connection closed")); },
    async release() { events.push("release"); },
  };
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    async reserve({ signal }: { signal?: AbortSignal } = {}) { signal?.throwIfAborted(); return session; },
    async unsafe() { events.push("probe"); if (options.probeHangs) return new Promise<Row[]>(() => {}); return [{ ...identity, pid: null, datid: null, backend_start: null, postmaster_start: options.epochChanged ? "3.000000" : identity.postmaster_start }]; },
    async close() { events.push("pool close"); },
  } });
  void held.promise.catch(() => {});
  const db = new Context(new DbContextOptions({ provider, entities: [] }));
  return { provider, db, events, telemetry, held, started, session };
}

test("operation deadline cancels active SQL with confirmed rollback and leaves a reusable context", async () => {
  const f = fixture(); let rolledBack = 0;
  await expect(f.db.transactionScope(async () => { f.provider.afterRollback(() => { rolledBack++; }); await f.db.database.querySqlRaw("held"); })).rejects.toThrow();
  expect(f.events).toContain("close"); expect(f.events).not.toContain("COMMIT"); expect(rolledBack).toBe(1);
  expect(f.provider.statistics().unconfirmedCancellations).toBe(0);
  await f.db.transactionScope(async () => {});
  expect(f.events).toContain("COMMIT");
});

for (const mode of ["epochChanged", "probeHangs", "closeHangs"] as const) {
  test(`${mode}: cancellation terminates as unknown, suppresses callbacks and fences every enrolled context`, async () => {
    const f = fixture({ [mode]: true }); const second = new Context(new DbContextOptions({ provider: f.provider, entities: [] }));
    let callbacks = 0, escaped!: Promise<unknown>;
    const start = performance.now();
    await expect(f.db.transactionScope(async tx => {
      tx.afterCommit(() => { callbacks++; }); f.provider.afterRollback(() => { callbacks++; });
      escaped = tx.use(second, async () => { await second.database.querySqlRaw("held"); });
      void escaped.catch(() => {}); await escaped;
    })).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "cancellation" });
    expect(performance.now() - start).toBeLessThan(800);
    await expect(escaped).rejects.toThrow();
    await expect(f.db.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
    await expect(second.database.querySqlRaw("late")).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
    expect(callbacks).toBe(0); expect(f.events).not.toContain("COMMIT"); expect(f.events).not.toContain("late");
    expect(f.provider.statistics().unconfirmedCancellations).toBe(1);
    if (mode === "closeHangs") expect(f.events).not.toContain("release");
  });
}

test("stalled BEGIN is bounded and never enters user code", async () => {
  const f = fixture({ hang: "BEGIN" }); let calls = 0;
  await expect(f.db.transactionScope(async () => { calls++; })).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(calls).toBe(0); expect(f.events).not.toContain("COMMIT");
});

test("stalled COMMIT reports unknown commit without rollback callbacks or replay", async () => {
  const f = fixture({ hang: "COMMIT" }); let calls = 0, callbacks = 0;
  await expect(f.db.transactionScope(async tx => { calls++; tx.afterCommit(() => { callbacks++; }); f.provider.afterRollback(() => { callbacks++; }); })).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "commit" });
  expect(calls).toBe(1); expect(callbacks).toBe(0); expect(f.events).not.toContain("ROLLBACK");
});

test("native admission receives signal and a late grant is closed without BEGIN", async () => {
  const f = fixture(); const admission = deferred<typeof f.session>(); let signal: AbortSignal | undefined;
  Object.defineProperty(f.provider, "sql", { value: { reserve(options: { signal: AbortSignal }) { signal = options.signal; return admission.promise; }, close: async () => {} }, configurable: true });
  let calls = 0;
  await expect(f.db.transactionScope(async () => { calls++; }, { timeoutMs: 20 })).rejects.toThrow();
  expect(signal?.aborted).toBe(true); expect(calls).toBe(0);
  admission.resolve(f.session); await delay(10);
  expect(f.events).toEqual(["close", "release"]);
});

test("unsettled native operations retain capacity and prevent unbounded accumulation", async () => {
  const f = fixture({ limit: 1, deadline: 20 });
  Object.defineProperty(f.provider, "sql", { value: { reserve: () => new Promise(() => {}), close: async () => {} }, configurable: true });
  await expect(f.db.transactionScope(async () => {})).rejects.toThrow();
  for (let i = 0; i < 10; i++) await expect(f.db.transactionScope(async () => {})).rejects.toThrow("limit");
  expect(f.provider.statistics().pendingNativeOperations).toBe(1);
});

test("invalid budgets fail before admission; telemetry cannot change a successful result", async () => {
  for (const value of [null as never, 0, -1, NaN, Infinity, 2.5, 2_147_483_648]) expect(() => new PostgresProvider({ operationTimeoutMs: value })).toThrow(TypeError);
  const f = fixture(); await expect(f.db.transactionScope(async () => {}, { timeoutMs: 0 })).rejects.toBeInstanceOf(TypeError); expect(f.events).toEqual([]);
  Object.defineProperty(f.provider, "onOperation", { value: () => { throw new Error("telemetry failure"); } });
  expect(await f.db.transactionScope(async () => 42)).toBe(42);
});
