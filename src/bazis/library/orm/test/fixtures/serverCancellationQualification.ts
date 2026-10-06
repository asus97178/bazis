import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { Column, DbContext, DbContextOptions, Entity, EntityState, Key, PostgresProvider, Schema } from "../../index";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; }
async function bounded<T>(work: PromiseLike<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Qualification deadline exceeded")), ms); })]); }
  finally { clearTimeout(timer); }
}
const outcome = (work: Promise<unknown>) => work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
class Context extends DbContext {}

/** Shared by bun:test and the compiled qualification executable. */
export function serverCancellationCases() {
  if (process.env.BAZIS_ORM_SERVER_CANCELLATION_LIVE !== "owned-disposable-v1") throw new Error("Owned disposable qualification is required.");
  const url = new URL(process.env.BAZIS_PG_URL!);
  if (url.hostname !== "127.0.0.1" || !/^\/cancel_[a-f0-9]+$/.test(url.pathname)) throw new Error("Only the owned loopback database is allowed.");
  const ca = readFileSync(process.env.BAZIS_SERVER_CANCEL_CA!, "utf8");
  let assertions = 0;
  function check(value: unknown, message: string): asserts value { assertions++; if (!value) throw new Error(message); }
  const eq = (a: unknown, b: unknown, message: string) => check(JSON.stringify(a) === JSON.stringify(b), message);
  const options = (tls = true, max = 1, connectionUrl = url.toString()) => ({ url: connectionUrl, max, connectionTimeout: 2,
    tls: tls ? { ca, serverName: "localhost", rejectUnauthorized: true } : false,
    connection: { statement_timeout: "5000", idle_in_transaction_session_timeout: "10000" } });
  async function fixture(tls = true, max = 1, extra: { url?: string; cancellationTimeoutMs?: number } = {}) {
    const schema = `sci_${crypto.randomUUID().replaceAll("-", "")}`;
    const provider = new PostgresProvider({ options: options(tls, max, extra.url), operationTimeoutMs: 10000, cancellationTimeoutMs: extra.cancellationTimeoutMs ?? 1000 });
    const observer = new SQL(options(tls, 2));
    @Schema(schema) @Entity({ table: "records" }) class Record { @Key() id = 0; @Column({ type: "text" }) value = "pending"; }
    const context = () => new Context(new DbContextOptions({ provider, entities: [Record], validateOnSave: false }));
    await context().database.ensureCreated();
    return { provider, observer, schema, Record, context, tls,
      async close() { await provider.close(); try { await observer.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await observer.close({ timeout: 0 }); } } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function acknowledge(f: Fixture, pid: () => number, sql: string) {
    const end = performance.now() + 2000;
    while (performance.now() < end) {
      const rows = await f.observer.unsafe("SELECT a.pid, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.pid=$1 AND a.state='active' AND a.query=$2", [pid(), sql]);
      if (rows.length === 1) { eq(rows[0].ssl, f.tls, "Actual TLS mode does not match"); return; }
      await sleep(5);
    }
    throw new Error("Exact active SQL was not acknowledged");
  }
  async function verify(f: Fixture, pid: number) {
    const rows = await f.observer.unsafe("SELECT state, xact_start FROM pg_stat_activity WHERE pid=$1", [pid]);
    eq(rows.length, 1, "Physical connection was unnecessarily discarded");
    eq([rows[0].state, rows[0].xact_start], ["idle", null], "Physical transaction did not end");
    eq((await f.observer.unsafe(`SELECT count(*)::int AS n FROM "${f.schema}".records`))[0].n, 0, "Rolled-back rows persisted");
    eq(Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid), pid, "Next borrower did not reuse the same connection");
    eq(f.provider.statistics().unconfirmedCancellations, 0, "Cancellation was unconfirmed");
  }
  const cases: { name: string; run(): Promise<Record<string, unknown>> }[] = [];
  const add = (name: string, run: () => Promise<Record<string, unknown> | void>) => cases.push({ name, async run() {
    const before = assertions, start = performance.now(); const details = await bounded(run(), 25000);
    return { name, assertions: assertions - before, ms: performance.now() - start, ...details };
  } });

  for (const tls of [false, true]) for (const scope of ["root", "nested", "raw-outer", "borrowed", "schema-owner"] as const) for (const method of ["querySqlRaw", "executeSqlRaw"] as const) {
    add(`${tls ? "TLS" : "TCP"} / ${scope} / ${method}: AbortSignal restores tracking and reuses the backend`, async () => {
      const f = await fixture(tls), db = f.context(), controller = new AbortController();
      const record = new f.Record(); db.add(record);
      let pid = 0, calls = 0, commits = 0, rollbacks = 0, caught = false;
      const sql = `SELECT pg_sleep($1) /* ${f.schema} */`;
      const work = () => db.transactionScope(async tx => {
        calls++; tx.afterCommit(() => { commits++; }); f.provider.afterRollback(() => { rollbacks++; });
        await db.saveChanges(); check(record.id > 0, "Generated key not assigned");
        pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
        await db.database[method](sql.replace("$1", "{0}"), 20);
      }, { signal: controller.signal });
      const outer = async () => { await f.provider.execute(`INSERT INTO "${f.schema}".records(value) VALUES ('outer')`, []); try { await work(); } catch { caught = true; } };
      const operation = scope === "root" ? work() : scope === "nested" ? db.transactionScope(outer) : scope === "raw-outer" ? f.provider.transaction(outer) : scope === "borrowed" ? f.provider.withMigrationLock(work) : f.provider.schemaAdmissionCapability.withSchemaAdmission([f.schema], work);
      const settled = outcome(operation);
      try {
        await acknowledge(f, () => pid, sql); const start = performance.now(); controller.abort();
        const result = await bounded(settled); const cancellationMs = performance.now() - start;
        check(!result.ok && result.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Abort was not a confirmed failure");
        eq([calls, commits, rollbacks, record.id, db.stateOf(record)], [1, 0, 1, 0, EntityState.Added], "Callbacks or tracking did not restore");
        if (scope === "nested" || scope === "raw-outer") check(caught, "Outer did not catch child error");
        await verify(f, pid);
        if (scope === "borrowed" || scope === "schema-owner") eq((await f.observer.unsafe("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [pid])).length, 0, "Borrowed advisory lock leaked");
        eq(await db.saveChanges(), 1, "Same context could not recover after rollback"); eq(await db.saveChanges(), 0, "Save was duplicated");
        eq((await f.observer.unsafe(`SELECT count(*)::int AS n FROM "${f.schema}".records`))[0].n, 1, "Recovery did not persist exactly once");
        return { cancellationMs, trackerRestored: true, backendReused: true };
      } finally { controller.abort(); await settled; await f.close(); }
    });
  }

  add("TLS / ordinary role requires neither superuser nor pg_signal_backend", async () => {
    const f = await fixture();
    try { const role = (await f.observer.unsafe("SELECT rolsuper, pg_has_role(current_user,'pg_signal_backend','MEMBER') AS member FROM pg_roles WHERE rolname=current_user"))[0]; eq([role.rolsuper, role.member], [false, false], "Unexpected cancellation privileges"); }
    finally { await f.close(); }
  });

  add("TLS / callback exit cancels detached SQL and fences late callback work", async () => {
    const f = await fixture(), db = f.context(), exit = gate(); let pid = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`; let detached!: Promise<unknown>;
    const operation = outcome(db.transactionScope(async () => { pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); detached = db.database.querySqlRaw(sql); void detached.catch(() => {}); await exit.wait; }));
    try { await acknowledge(f, () => pid, sql); exit.open(); check(!(await bounded(operation)).ok, "Scope with detached SQL committed"); check(!(await outcome(detached)).ok, "Detached SQL resolved"); await verify(f, pid); }
    finally { exit.open(); await operation; await f.close(); }
  });

  add("TLS / parent AbortSignal cancels the active nested scope", async () => {
    const f = await fixture(), db = f.context(), controller = new AbortController(); let pid = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`;
    const operation = outcome(db.transactionScope(async () => db.transactionScope(async () => { pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await db.database.querySqlRaw(sql); }), { signal: controller.signal }));
    try { await acknowledge(f, () => pid, sql); controller.abort(); check(!(await bounded(operation)).ok, "Parent abort committed"); await verify(f, pid); }
    finally { controller.abort(); await operation; await f.close(); }
  });

  add("TLS / full worker pool progresses through an independent control connection", async () => {
    const f = await fixture(), controller = new AbortController(); let pid = 0, granted = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`;
    const operation = outcome(f.context().transactionScope(async () => { pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await f.provider.query(sql, []); }, { signal: controller.signal }));
    let queue: Promise<unknown>[] = [];
    try {
      await acknowledge(f, () => pid, sql);
      queue = Array.from({ length: 8 }, async () => { const rows = await f.provider.query("SELECT 43 AS n", []); granted++; return rows[0]!.n; });
      await sleep(10); eq(granted, 0, "Worker pool was not occupied");
      const start = performance.now(); controller.abort(); check(!(await bounded(operation)).ok, "Occupied-pool abort committed");
      const cancellationMs = performance.now() - start; eq(await Promise.all(queue), Array(8).fill(43), "Queued borrowers did not progress"); await verify(f, pid);
      return { cancellationMs, queuedBorrowers: 8 };
    } finally { controller.abort(); await operation; await Promise.allSettled(queue); await f.close(); }
  });

  add("TLS / cancellation preserves a simultaneously active neighbor in the same pool", async () => {
    const f = await fixture(true, 2), controller = new AbortController(); let pid = 0, neighborPid = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`, healthySql = `SELECT 77 AS n, pg_sleep(0.3) /* ${f.schema}_neighbor */`;
    const operation = outcome(f.context().transactionScope(async () => { pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await f.provider.query(sql, []); }, { signal: controller.signal }));
    const neighbor = f.context().transactionScope(async () => { neighborPid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); return f.provider.query(healthySql, []); });
    try { await acknowledge(f, () => pid, sql); await acknowledge(f, () => neighborPid, healthySql); check(pid !== neighborPid, "Neighbor shares a backend"); controller.abort(); check(!(await bounded(operation)).ok, "Abort committed"); eq((await neighbor)[0]!.n, 77, "Neighbor was cancelled"); eq(f.provider.statistics().unconfirmedCancellations, 0, "Cancellation unknown"); }
    finally { controller.abort(); await operation; await neighbor.catch(() => {}); await f.close(); }
  });

  add("TLS / native requests already queued on one owner settle before rollback", async () => {
    const f = await fixture(), controller = new AbortController(); let pid = 0, callbacks = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`; let queries: Promise<unknown>[] = [];
    const operation = outcome(f.context().transactionScope(async () => { f.provider.afterRollback(() => { callbacks++; }); pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); queries = [f.provider.query(sql, []), f.provider.query("SELECT pg_sleep(20) /* second */", []), f.provider.execute("SELECT pg_sleep(20) /* third */", [])]; await Promise.all(queries); }, { signal: controller.signal }));
    try { await acknowledge(f, () => pid, sql); controller.abort(); check(!(await bounded(operation)).ok, "Queued operations committed"); const results = await Promise.allSettled(queries); check(results.every(r => r.status === "rejected"), "Queued operations survived cancellation"); await verify(f, pid); eq(callbacks, 1, "Rollback callback duplicated"); eq(f.provider.statistics().pendingNativeOperations, 0, "Raw native query remained pending"); }
    finally { controller.abort(); await operation; await Promise.allSettled(queries); await f.close(); }
  });

  add("TLS / 16 completion-boundary races preserve rollback and the next borrower", async () => {
    const f = await fixture(); let naturallyCompleted = 0, interrupted = 0;
    try {
      for (let round = 0; round < 16; round++) {
        const db = f.context(), controller = new AbortController(), tail = gate(); let pid = 0, done = false;
        const sql = `SELECT pg_sleep(0.12) /* ${f.schema}_${round} */`;
        const operation = outcome(db.transactionScope(async () => { db.add(new f.Record()); await db.saveChanges(); pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await db.database.querySqlRaw(sql); done = true; await tail.wait; }, { signal: controller.signal }));
        try { await acknowledge(f, () => pid, sql); await sleep([0, 85, 115, 150][round % 4]!); if (done) naturallyCompleted++; else interrupted++; controller.abort(); const result = await bounded(operation); check(!result.ok && result.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Completion race was not rolled back"); await verify(f, pid); eq((await f.provider.query("SELECT pg_sleep(0.005), 46 AS n", []))[0]!.n, 46, "Next query was cancelled"); }
        finally { controller.abort(); tail.open(); await operation; }
      }
      check(naturallyCompleted > 0 && interrupted > 0, "Both sides of the completion boundary were not exercised");
      return { rounds: 16, naturallyCompleted, interrupted, nextBorrowersPreserved: 16 };
    } finally { await f.close(); }
  });

  add("TLS / 32 concurrent cancellations keep one control connection and bounded progress", async () => {
    const f = await fixture(true, 4); const timings: number[] = [];
    try {
      for (let round = 0; round < 8; round++) {
        const controllers = Array.from({ length: 4 }, () => new AbortController()); const pids = Array(4).fill(0) as number[];
        const queries = controllers.map((_, i) => `SELECT pg_sleep(20) /* ${f.schema}_${round}_${i} */`);
        const work = controllers.map((controller, i) => outcome(f.context().transactionScope(async () => { pids[i] = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await f.provider.query(queries[i]!, []); }, { signal: controller.signal })));
        try { await Promise.all(queries.map((sql, i) => acknowledge(f, () => pids[i]!, sql))); const start = performance.now(); controllers.forEach(c => c.abort()); await Promise.all(work.map(async pending => { const result = await bounded(pending); check(!result.ok && result.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Concurrent cancellation unconfirmed"); timings.push(performance.now() - start); })); }
        finally { controllers.forEach(c => c.abort()); await Promise.all(work); }
      }
      eq((await f.provider.query("SELECT 49 AS n", []))[0]!.n, 49, "Pool stalled after cancellations");
      eq(f.provider.statistics(), { pendingNativeOperations: 0, activeCancellations: 0, unconfirmedCancellations: 0, closed: false }, "Native work leaked");
      const control = (f.provider as unknown as { controlSql: SQL }).controlSql;
      eq(control.options.max, 1, "Control pool exceeded configured size");
      timings.sort((a, b) => a - b); return { cancellations: 32, workerMax: 4, controlMax: 1, p95Ms: timings[Math.ceil(timings.length * .95) - 1], maxMs: timings.at(-1) };
    } finally { await f.close(); }
  });

  add("TLS / exhausted control pool returns unknown and never sends a late cancellation", async () => {
    const f = await fixture(true, 1, { cancellationTimeoutMs: 200 }), controller = new AbortController(), db = f.context();
    const control = new SQL(options()); Object.defineProperty(f.provider, "controlSql", { value: control });
    const blocker = await control.reserve().catch(cause => { throw new Error("Control blocker reservation failed", { cause }); }); let pid = 0, callbacks = 0, released = false;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`;
    const operation = outcome(db.transactionScope(async () => { f.provider.afterRollback(() => { callbacks++; }); pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await f.provider.query(sql, []); }, { signal: controller.signal }));
    try {
      await acknowledge(f, () => pid, sql); const start = performance.now(); controller.abort();
      const result = await bounded(operation); check(!result.ok && result.error?.code === "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Control starvation was falsely acknowledged");
      eq(callbacks, 0, "Control starvation published a rollback callback");
      const cancellationMs = performance.now() - start;
      blocker.release(); released = true; const recoveryStart = performance.now();
      eq((await f.provider.query("SELECT pg_sleep(0.15), 53 AS n", []))[0]!.n, 53, "Late cancellation reached the next borrower");
      check(!(await outcome(db.saveChanges())).ok, "Unknown context recovered without reconciliation");
      return { cancellationMs, recoveryMs: performance.now() - recoveryStart, result: "unknown", callbacks };
    } finally { controller.abort(); if (!released) blocker.release(); await operation; await f.close(); }
  });

  add("TLS / ORM timeout uses server cancellation and afterCommit abort preserves committed data", async () => {
    const f = await fixture(), db = f.context(); let pid = 0, callbacks = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`;
    const operation = outcome(db.transactionScope(async () => { f.provider.afterRollback(() => { callbacks++; }); pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await db.database.querySqlRaw(sql); }, { timeoutMs: 250 }));
    try {
      await acknowledge(f, () => pid, sql); const result = await bounded(operation);
      check(!result.ok && result.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Scope deadline did not confirm rollback"); eq(callbacks, 1, "Deadline rollback callback missing"); await verify(f, pid);
      const controller = new AbortController(); let committed = 0;
      eq(await db.transactionScope(async tx => { db.add(new f.Record()); await db.saveChanges(); tx.afterCommit(() => { controller.abort(); committed++; }); return 42; }, { signal: controller.signal }), 42, "Abort after commit changed the result");
      eq(committed, 1, "Commit callback missing"); eq((await f.observer.unsafe(`SELECT count(*)::int AS n FROM "${f.schema}".records`))[0].n, 1, "Commit was rolled back by a late signal");
    } finally { await operation; await f.close(); }
  });

  add("TLS / SQL exceeding pg_stat_activity text limit remains cancellable", async () => {
    const f = await fixture(), controller = new AbortController(); let pid = 0;
    const sql = `/* ${f.schema} */ SELECT pg_sleep(20) /* ${"x".repeat(6000)} */`;
    const operation = outcome(f.context().transactionScope(async () => { pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await f.provider.query(sql, []); }, { signal: controller.signal }));
    try {
      let seen = false; const end = performance.now() + 2000;
      while (!seen && performance.now() < end) { const rows = await f.observer.unsafe("SELECT a.query, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.pid=$1 AND a.state='active' AND left(a.query,80)=left($2,80)", [pid, sql]); if (rows[0]) { eq(rows[0].ssl, true, "Long query was not TLS"); check(rows[0].query.length < sql.length, "Query was not truncated in server statistics"); seen = true; } else await sleep(5); }
      check(seen, "Long active SQL not observed"); controller.abort(); const result = await bounded(operation); check(!result.ok && result.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Long SQL cancellation failed"); await verify(f, pid);
    } finally { controller.abort(); await operation; await f.close(); }
  });

  for (const lost of ["control", "rollback"] as const) add(`TLS / lost ${lost} response remains unknown without rollback callbacks`, async () => {
    const fault = await replyRelay(url);
    const f = await fixture(true, 1, { url: lost === "rollback" ? fault.url : undefined, cancellationTimeoutMs: 300 });
    const controller = new AbortController(), db = f.context(); let pid = 0, callbacks = 0;
    const sql = `SELECT pg_sleep(20) /* ${f.schema} */`;
    const rawError = gate(); let errno: unknown;
    const worker = (f.provider as unknown as { sql: SQL }).sql;
    const workerReserve = worker.reserve.bind(worker);
    Object.defineProperty(worker, "reserve", { value: async (args: { signal?: AbortSignal }) => {
      const session = await workerReserve(args);
      const unsafe = session.unsafe.bind(session);
      // Prepare ROLLBACK before the real transaction so fault injection cannot
      // stop Describe rather than the actual command's response.
      if (lost === "rollback") { await unsafe("BEGIN"); await unsafe("ROLLBACK"); }
      return {
        unsafe(text: string, values?: readonly unknown[]) {
          if (lost === "rollback" && text === "ROLLBACK") fault.freeze();
          return Promise.resolve(unsafe(text, values as unknown[])).catch(error => { if (text === sql) { errno = error.errno ?? error.code; rawError.open(); } throw error; });
        },
        release: session.release.bind(session), close: session.close.bind(session),
      };
    } });
    const control = new SQL(options(true, 1, lost === "control" ? fault.url : undefined));
    Object.defineProperty(f.provider, "controlSql", { value: control });
    if (lost === "control") {
      const reserve = control.reserve.bind(control);
      Object.defineProperty(control, "reserve", { value: async (args: { signal?: AbortSignal }) => {
        const session = await reserve(args), unsafe = session.unsafe.bind(session);
        return {
          async unsafe(text: string, values?: readonly unknown[]) {
            if (text.includes("cancel-signal")) {
              const invalid = [...values!]; invalid[2] = "0.000001";
              await unsafe(text, invalid); fault.freeze();
            }
            return unsafe(text, values as unknown[]);
          }, release: session.release.bind(session), close: session.close.bind(session),
        };
      } });
    }
    const operation = outcome(db.transactionScope(async tx => { tx.afterCommit(() => { callbacks++; }); f.provider.afterRollback(() => { callbacks++; }); db.add(new f.Record()); await db.saveChanges(); pid = Number((await f.provider.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await db.database.querySqlRaw(sql); }, { signal: controller.signal }));
    try {
      await acknowledge(f, () => pid, sql); const start = performance.now(); controller.abort();
      await bounded(rawError.wait); eq(errno, "57014", "Real native SQL cancellation was not observed");
      const result = await bounded(operation); check(!result.ok && result.error?.code === "ORM_TRANSACTION_OUTCOME_UNKNOWN" && result.error.phase === "cancellation", "Lost response was falsely acknowledged");
      eq(callbacks, 0, "Unknown cancellation published a callback"); eq(f.provider.statistics().unconfirmedCancellations, 1, "Unknown outcome was not recorded");
      check(!(await outcome(db.saveChanges())).ok, "Unknown context allowed another save");
      if (lost === "rollback") eq((await f.observer.unsafe(`SELECT count(*)::int AS n FROM "${f.schema}".records`))[0].n, 0, "ROLLBACK was not actually delivered before losing its response");
      return { originalSqlstate: errno, elapsedMs: performance.now() - start, result: "unknown", callbacks: 0 };
    } finally { controller.abort(); fault.close(); await operation; await f.close(); }
  });
  return cases;
}

/** Opaque TLS relay; only server-to-client delivery is faulted, no payload logs. */
async function replyRelay(target: URL) {
  let frozen = false; const sockets = new Set<Socket>();
  const server = createServer(front => {
    const back = connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(front); sockets.add(back);
    front.on("data", bytes => back.write(bytes)); back.on("data", bytes => { if (!frozen) front.write(bytes); });
    front.on("error", () => {}); back.on("error", () => {});
    front.on("close", () => { sockets.delete(front); if (!frozen) back.destroy(); });
    back.on("close", () => { sockets.delete(back); if (!frozen) front.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Relay address unavailable");
  const url = new URL(target); url.port = String(address.port);
  return { url: url.toString(), freeze() { frozen = true; }, close() { frozen = false; for (const socket of sockets) socket.destroy(); sockets.clear(); server.close(); } };
}
