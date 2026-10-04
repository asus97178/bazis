import { expect, test } from "bun:test";
import { DbContext, DbContextOptions, PostgresProvider, type Row } from "../index";
import { postgresTransactionCapability, withProviderDispatchObserver, type CancellableProviderDispatch } from "../Providers/ormTransactionRuntime";

class Context extends DbContext {}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const identity = { pid: "42", datid: "7", backend_start: "1.000000", postmaster_start: "2.000000", address: "127.0.0.1", port: "5432" };

function fixture(options: { originalHeld?: boolean; replyHeld?: boolean; rollbackHeld?: boolean; admissionHeld?: boolean; changedBackend?: boolean; invalidQueryIdentity?: boolean; closeHeld?: boolean } = {}) {
  const events: string[] = [];
  const original = deferred<Row[]>(), reply = deferred<Row[]>(), rollback = deferred<Row[]>();
  const started = deferred<void>(), signaled = deferred<void>(), rollingBack = deferred<void>(), reserving = deferred<void>();
  let identityReads = 0, callbacks = 0, commits = 0;
  const provider = new PostgresProvider({ operationTimeoutMs: 2000, cancellationTimeoutMs: 100 });
  const controller = new AbortController();
  const session = {
    async unsafe(sql: string): Promise<Row[]> {
      events.push(sql);
      if (sql === "held") { started.resolve(); return original.promise; }
      if (sql === "ROLLBACK") { rollingBack.resolve(); return options.rollbackHeld ? rollback.promise : []; }
      if (sql.startsWith("SELECT current_setting")) return [{ interval: "250ms" }];
      if (sql.startsWith("SELECT pg_backend_pid")) { identityReads++; return [{ ...identity, ...(options.changedBackend && identityReads > 1 ? { backend_start: "9.000000" } : {}) }]; }
      return [{ value: 42 }];
    },
    async close() { events.push("worker close"); if (options.closeHeld) return new Promise<void>(() => {}); original.reject(new Error("worker closed")); },
    async release() { events.push("worker release"); },
  };
  const control = {
    async unsafe(sql: string): Promise<Row[]> {
      if (sql.includes("cancel-inspect")) { events.push("inspect"); return [{ query_start: options.invalidQueryIdentity ? null : "3.000000" }]; }
      if (!sql.includes("cancel-signal")) throw new Error("Unexpected control command");
      events.push("signal"); signaled.resolve();
      if (!options.originalHeld) original.reject(Object.assign(new Error("cancelled on server"), { errno: "57014" }));
      return options.replyHeld ? reply.promise : [{ signaled: true }];
    },
    async close() { events.push("control close"); reply.reject(new Error("control closed")); },
    async release() { events.push("control release"); },
  };
  const admission = deferred<typeof control>();
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    async reserve() { events.push("worker reserve"); return session; },
    async unsafe() { throw new Error("Cancellation must not use the worker pool"); },
    async close() { events.push("worker pool close"); await session.close(); },
  } });
  Object.defineProperty(provider, "controlSql", { configurable: true, value: {
    async reserve() { events.push("control reserve"); reserving.resolve(); return options.admissionHeld ? admission.promise : control; },
    async close() { events.push("control pool close"); await control.close(); },
  } });
  const db = new Context(new DbContextOptions({ provider, entities: [] }));
  const run = () => db.transactionScope(async tx => { tx.afterCommit(() => { commits++; }); provider.afterRollback(() => { callbacks++; }); await db.database.querySqlRaw("held"); }, { signal: controller.signal });
  return { provider, db, controller, events, original, reply, rollback, started, signaled, rollingBack, reserving, admission, control, run, counts: () => ({ callbacks, commits }) };
}

test("server cancellation fences reuse until the original native SQL, control response and rollback all settle", async () => {
  const f = fixture({ originalHeld: true, replyHeld: true, rollbackHeld: true });
  const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort(); await f.signaled.promise;
  f.reply.resolve([{ signaled: true }]); await delay(10);
  expect(f.events).not.toContain("ROLLBACK"); expect(f.events).not.toContain("worker release");
  f.original.reject(Object.assign(new Error("server cancel"), { errno: "57014" }));
  await f.rollingBack.promise;
  expect(f.counts()).toEqual({ callbacks: 0, commits: 0 }); expect(f.events).not.toContain("worker release");
  f.rollback.resolve([]); await expect(operation).rejects.toThrow();
  expect(f.events.filter(x => x === "signal")).toHaveLength(1);
  expect(f.events.filter(x => x === "ROLLBACK")).toHaveLength(1);
  expect(f.events.indexOf("control release")).toBeLessThan(f.events.indexOf("worker release"));
  expect(f.events).not.toContain("worker close"); expect(f.counts()).toEqual({ callbacks: 1, commits: 0 });
  expect(f.provider.statistics()).toMatchObject({ unconfirmedCancellations: 0, activeCancellations: 0, pendingNativeOperations: 0 });
  expect(await f.db.database.querySqlRaw("next")).toEqual([{ value: 42 }]); await f.provider.close();
});

test("a lost control reply cannot publish a successful rollback after native query rejection", async () => {
  const f = fixture({ replyHeld: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort(); await f.signaled.promise;
  await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "cancellation" });
  expect(f.events).not.toContain("ROLLBACK"); expect(f.counts()).toEqual({ callbacks: 0, commits: 0 });
  expect(f.events.indexOf("control close")).toBeLessThan(f.events.indexOf("control release"));
  await expect(f.db.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(f.provider.statistics().unconfirmedCancellations).toBe(1); await f.provider.close();
});

test("natural completion during queued control admission sends no stale signal and still rolls back", async () => {
  const f = fixture({ admissionHeld: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort(); await f.reserving.promise;
  f.original.resolve([]); await delay(10); expect(f.events).not.toContain("worker release");
  f.admission.resolve(f.control); await expect(operation).rejects.toThrow();
  expect(f.events).not.toContain("signal"); expect(f.events).not.toContain("inspect");
  expect(f.events).toContain("ROLLBACK"); expect(f.counts().callbacks).toBe(1); await f.provider.close();
});

test("late control reservation is closed without sending cancellation to a later query", async () => {
  const f = fixture({ admissionHeld: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort();
  await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  f.admission.resolve(f.control); await delay(10);
  expect(f.events).not.toContain("signal"); expect(f.events).toContain("control close"); expect(f.events).toContain("control release");
  expect(f.provider.statistics().pendingNativeOperations).toBe(0); await f.provider.close();
});

for (const mode of ["changedBackend", "invalidQueryIdentity"] as const) test(`${mode} cannot acknowledge cancellation or invoke rollback callbacks`, async () => {
  const f = fixture({ [mode]: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort();
  await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  if (mode === "invalidQueryIdentity") expect(f.events).not.toContain("signal");
  expect(f.counts()).toEqual({ callbacks: 0, commits: 0 }); expect(f.events).toContain("worker close"); await f.provider.close();
});

test("provider close interrupts pending cancellation admission and closes both pools once", async () => {
  const f = fixture({ admissionHeld: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort(); await f.reserving.promise;
  await Promise.all([f.provider.close(), f.provider.close()]);
  await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(f.events.filter(x => x === "worker pool close")).toHaveLength(1);
  expect(f.events.filter(x => x === "control pool close")).toHaveLength(1);
  expect(f.events).not.toContain("signal");
  f.admission.resolve(f.control); await delay(5);
  await expect(f.provider.query("late", [])).rejects.toThrow();
});

test("unconfirmed cancellation cannot release a worker whose native close never settles", async () => {
  const f = fixture({ originalHeld: true, closeHeld: true }); const operation = f.run(); void operation.catch(() => {});
  await f.started.promise; f.controller.abort();
  await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
  expect(f.events).not.toContain("worker release"); expect(f.events).not.toContain("ROLLBACK");
  expect(f.provider.statistics().pendingNativeOperations).toBeGreaterThan(0);
  await expect(f.provider.close()).rejects.toThrow();
});

test("completed dispatch cancellation cannot touch a later physical borrower", async () => {
  const f = fixture(); let dispatch!: CancellableProviderDispatch;
  const first = f.provider.transaction(async () => {
    await postgresTransactionCapability(f.provider)!.assertScopedClose();
    await withProviderDispatchObserver(d => { dispatch = d; }, () => f.provider.query("first", []));
  });
  await first; const before = f.events.length;
  await dispatch.cancel(); expect(f.events.length).toBe(before);
  expect(await f.provider.query("next", [])).toEqual([{ value: 42 }]); await f.provider.close();
});

test("invalid cancellation mode is rejected before creating a pool", () => {
  for (const value of [null, "", "native", 1, {}]) expect(() => new PostgresProvider({ cancellationMode: value as never })).toThrow(TypeError);
});

test("a synchronous worker close failure still closes the control pool", async () => {
  const f = fixture(); let closed = false;
  Object.defineProperty(f.provider, "sql", { value: { close() { throw new Error("worker close failed"); } } });
  Object.defineProperty(f.provider, "controlSql", { value: { async close() { closed = true; } } });
  await expect(f.provider.close()).rejects.toThrow("worker close failed"); expect(closed).toBe(true);
});

test("one failed reconnection can retry admission without repeating BEGIN or user work", async () => {
  const f = fixture(); const root = (f.provider as unknown as { sql: { reserve(): Promise<unknown> } }).sql, reserve = root.reserve.bind(root);
  let attempts = 0, calls = 0;
  root.reserve = async () => { if (++attempts === 1) throw Object.assign(new Error("connection timeout"), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }); return reserve(); };
  await f.db.transactionScope(async () => { calls++; });
  expect(attempts).toBe(2); expect(calls).toBe(1); expect(f.events.filter(x => x === "BEGIN")).toHaveLength(1); await f.provider.close();
});

test("after retirement a failing SQL health probe is retried before any business SQL", async () => {
  const f = fixture(); let probes = 0, calls = 0, grants = 0;
  Object.defineProperty(f.provider, "validateWorkerAdmissions", { value: true, writable: true });
  const root = (f.provider as unknown as { sql: { reserve(): Promise<{ unsafe: (sql: string) => Promise<Row[]> }> } }).sql, reserve = root.reserve.bind(root);
  root.reserve = async () => {
    const session = await reserve(); grants++;
    return { ...session, unsafe: async (sql: string) => {
      if (sql.includes("admission-check") && ++probes === 1) throw Object.assign(new Error("stale TLS slot"), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" });
      return session.unsafe(sql);
    } };
  };
  await f.db.transactionScope(async () => { calls++; });
  expect([grants, probes, calls]).toEqual([2, 2, 1]); expect(f.events.filter(x => x === "BEGIN")).toHaveLength(1); await f.provider.close();
});

test("admission recovery is limited to one retry and never retries a dispatched SQL", async () => {
  const f = fixture(); let attempts = 0, calls = 0;
  Object.defineProperty(f.provider, "sql", { value: { reserve: async () => { attempts++; throw Object.assign(new Error("connection timeout"), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }); }, close: async () => {} } });
  await expect(f.db.transactionScope(async () => { calls++; })).rejects.toThrow("connection timeout");
  expect(attempts).toBe(2); expect(calls).toBe(0); expect(f.events).not.toContain("BEGIN"); await f.provider.close();
  const g = fixture(); let dispatches = 0;
  const root = (g.provider as unknown as { sql: { reserve(): Promise<{ unsafe: (sql: string) => Promise<Row[]> }> } }).sql, reserve = root.reserve.bind(root);
  root.reserve = async () => { const session = await reserve(), unsafe = session.unsafe.bind(session); session.unsafe = async sql => { if (sql === "sent") { dispatches++; throw Object.assign(new Error("connection timeout"), { code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }); } return unsafe(sql); }; return session; };
  await expect(g.provider.query("sent", [])).rejects.toThrow(); expect(dispatches).toBe(1); await g.provider.close();
});
