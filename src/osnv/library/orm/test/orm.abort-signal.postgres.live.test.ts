import { describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, EntityState, Key, OrmTransactionScopeError, PostgresProvider, Schema } from "../index";

// Opt in only on the explicitly authorized disposable runner. Without the opt-in env it runs no SQL.
const url = process.env.OSNV_PG_URL;
const enabled = !!url && process.env.OSNV_ORM_CANCELLATION_LIVE === "1";
class Context extends DbContext {}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const outcome = (promise: Promise<unknown>) => promise.then(() => "resolved" as const, () => "rejected" as const);
async function withinBudget(promise: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([outcome(promise), new Promise<"pending">((resolve) => { timer = setTimeout(() => resolve("pending"), 1_500); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(max = 1) {
  if (!enabled) throw new Error("Cancellation qualification requires an explicitly enabled disposable database.");
  const schema = `orm_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
  // Retain explicit close-policy regressions; server mode has its own shared TLS/binary matrix.
  const provider = new PostgresProvider({ options: { url, max }, cancellationMode: "close" });
  const observer = new PostgresProvider({ options: { url, max: 2 } });
  @Schema(schema) @Entity({ table: "records" })
  class Record { @Key() id = 0; @Column({ type: "text" }) value = "pending"; }
  const context = (p = provider) => new Context(new DbContextOptions({ provider: p, entities: [Record], validateOnSave: false }));
  const quoted = provider.dialect.quoteId(schema);
  const close = async () => {
    try { await observer.execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`, []); }
    finally { await observer.close(); await provider.close(); }
  };
  try { await context().database.ensureCreated(); } catch (error) { await close(); throw error; }
  return { provider, observer, Record, context, schema, quoted, close };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function acknowledge(f: Fixture, pid: () => number, sql: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  let active = false;
  while (!active && performance.now() < deadline) {
    active = (await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query = $2", [pid(), sql])).length === 1;
    if (!active) await delay(10);
  }
  expect(active).toBe(true);
}

describe.skipIf(!enabled)("ORM AbortSignal and immediate PostgreSQL cancellation", () => {
  for (const scope of ["root", "nested", "raw-outer", "borrowed"] as const) {
    for (const method of ["querySqlRaw", "executeSqlRaw"] as const) {
      test(`${scope} / ${method}: active SQL rejects and rolls back within 1.5 seconds`, async () => {
        const f = await fixture(); const db = f.context(); const controller = new AbortController();
        const record = new f.Record(); db.add(record);
        let pid = 0; let callbackCalls = 0; let commits = 0; let rollbacks = 0; let caughtChild = false;
        let sqlOutcome: Promise<string> | undefined; let operation: Promise<unknown> | undefined;
        const rawSql = `SELECT pg_sleep({0}) /* ${f.schema} */`;
        const emittedSql = rawSql.replace("{0}", "$1");
        const work = () => db.transactionScope(async (tx) => {
          callbackCalls++; tx.afterCommit(() => { commits++; }); f.provider.afterRollback(() => { rollbacks++; });
          await db.saveChanges(); expect(record.id).toBeGreaterThan(0);
          pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
          const pending = db.database[method](rawSql, 5); sqlOutcome = outcome(pending); await pending;
        }, { signal: controller.signal });
        const outer = async () => {
          await f.provider.execute(`INSERT INTO ${f.quoted}.records (value) VALUES ('outer')`, []);
          try { await work(); } catch { caughtChild = true; }
        };
        try {
          operation = scope === "root" ? work() : scope === "nested" ? db.transactionScope(outer)
            : scope === "raw-outer" ? f.provider.transaction(outer) : f.provider.withMigrationLock!(work);
          void operation.catch(() => {});
          await acknowledge(f, () => pid, emittedSql);
          const start = performance.now(); controller.abort();
          const bounded = await withinBudget(operation); const elapsedMs = Math.round(performance.now() - start);
          await outcome(operation);
          const remaining = await f.observer.query("SELECT pid FROM pg_stat_activity WHERE pid = $1", [pid]);
          const rows = await f.context(f.observer).setOf(f.Record).asNoTracking().toList();
          console.log(JSON.stringify({ qualification: "orm-cancellation", scope, method, bounded, elapsedMs,
            sqlOutcome: await sqlOutcome, backendGone: remaining.length === 0, rowsAfterRollback: rows.length }));
          expect(bounded).toBe("rejected"); expect(elapsedMs).toBeLessThan(1_500);
          expect(await sqlOutcome).toBe("rejected"); expect(remaining).toEqual([]); expect(rows).toEqual([]);
          expect(callbackCalls).toBe(1); expect(commits).toBe(0); expect(rollbacks).toBe(1);
          expect(record.id).toBe(0); expect(db.stateOf(record)).toBe(EntityState.Added);
          if (scope === "nested" || scope === "raw-outer") expect(caughtChild).toBe(true);
          if (scope === "borrowed") expect(await f.observer.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [pid])).toEqual([]);
          // Recovery is explicit, after proven rollback; the callback was not retried.
          expect(await db.saveChanges()).toBe(1); expect(await db.saveChanges()).toBe(0);
          expect((await f.context(f.observer).setOf(f.Record).asNoTracking().toList()).map(row => row.value)).toEqual(["pending"]);
          expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
        } finally { controller.abort(); await operation?.catch(() => {}); await f.close(); }
      }, 15_000);
    }
  }

  test("callback exit with active SQL closes immediately without an external signal", async () => {
    const f = await fixture(); const db = f.context(); let pid = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); let operation: Promise<void> | undefined;
    let query: Promise<unknown> | undefined;
    try {
      operation = db.transactionScope(async () => {
        pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
        query = db.database.querySqlRaw("SELECT pg_sleep(5)"); void query.catch(() => {}); await gate;
      }); void operation.catch(() => {});
      await acknowledge(f, () => pid, "SELECT pg_sleep(5)");
      const start = performance.now(); release();
      expect(await withinBudget(operation)).toBe("rejected");
      const elapsedMs = Math.round(performance.now() - start);
      expect(await outcome(query!)).toBe("rejected");
      expect(await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).toEqual([]);
      console.log(JSON.stringify({ qualification: "orm-callback-exit", elapsedMs }));
    } finally { release(); await operation?.catch(() => {}); await f.close(); }
  }, 15_000);

  test("parent signal interrupts a child active SQL without a five-second drain", async () => {
    const f = await fixture(); const db = f.context(); const controller = new AbortController(); let pid = 0;
    let operation: Promise<unknown> | undefined;
    try {
      operation = db.transactionScope(async () => db.transactionScope(async () => {
        pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
        await db.database.querySqlRaw("SELECT pg_sleep(5)");
      }), { signal: controller.signal }); void operation.catch(() => {});
      await acknowledge(f, () => pid, "SELECT pg_sleep(5)"); controller.abort();
      expect(await withinBudget(operation)).toBe("rejected");
      expect(await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).toEqual([]);
      expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
    } finally { controller.abort(); await operation?.catch(() => {}); await f.close(); }
  }, 15_000);

  test("closing one reservation preserves a simultaneous active query in the same pool", async () => {
    const f = await fixture(2); const first = f.context(); const second = f.context(); const controller = new AbortController();
    let cancelledPid = 0; let healthyPid = 0; let cancelled: Promise<unknown> | undefined; let healthy: Promise<unknown> | undefined;
    try {
      cancelled = first.transactionScope(async () => {
        cancelledPid = Number((await first.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
        await first.database.querySqlRaw("SELECT pg_sleep(5)");
      }, { signal: controller.signal }); void cancelled.catch(() => {});
      healthy = second.transactionScope(async () => {
        healthyPid = Number((await second.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid);
        return second.database.querySqlRaw("SELECT 42 AS value, pg_sleep(0.75)");
      }); void healthy.catch(() => {});
      await acknowledge(f, () => cancelledPid, "SELECT pg_sleep(5)");
      await acknowledge(f, () => healthyPid, "SELECT 42 AS value, pg_sleep(0.75)");
      expect(healthyPid).not.toBe(cancelledPid); controller.abort();
      expect(await withinBudget(cancelled)).toBe("rejected");
      expect((await healthy as { value: number }[])[0]!.value).toBe(42);
      expect(await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [cancelledPid])).toEqual([]);
      expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
    } finally { controller.abort(); await cancelled?.catch(() => {}); await healthy?.catch(() => {}); await f.close(); }
  }, 15_000);

  test("pre-aborted signal performs no user SQL and leaves the pool reusable", async () => {
    const f = await fixture(); let effects = 0;
    try {
      await expect(f.context().transactionScope(async () => { effects++; }, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OrmTransactionScopeError);
      expect(effects).toBe(0); expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
    } finally { await f.close(); }
  });

  test("abort while queued for a max=1 reservation prevents callback effects on admission", async () => {
    const f = await fixture(); const controller = new AbortController(); let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const began = new Promise<void>((resolve) => { started = resolve; });
    let effects = 0; let owner: Promise<unknown> | undefined; let queued: Promise<unknown> | undefined;
    try {
      owner = f.context().transactionScope(async () => { started(); await gate; }); await began;
      queued = f.context().transactionScope(async () => { effects++; }, { signal: controller.signal }); void queued.catch(() => {});
      controller.abort(); release(); await owner;
      await expect(queued).rejects.toBeInstanceOf(OrmTransactionScopeError);
      expect(effects).toBe(0); expect(await f.provider.query("SELECT 1 AS alive", [])).toEqual([{ alive: 1 }]);
    } finally { release(); controller.abort(); await owner?.catch(() => {}); await queued?.catch(() => {}); await f.close(); }
  }, 15_000);

  test("AbortSignal.timeout cancels active SQL but an afterCommit abort preserves committed data", async () => {
    const f = await fixture(); const db = f.context(); const controller = new AbortController(); let callbacks = 0;
    try {
      const result = await db.transactionScope(async (tx) => {
        db.add(new f.Record()); await db.saveChanges();
        tx.afterCommit(() => { controller.abort(); callbacks++; }); return 42;
      }, { signal: controller.signal });
      expect(result).toBe(42); expect(callbacks).toBe(1);
      expect(await f.context(f.observer).setOf(f.Record).asNoTracking().toList()).toHaveLength(1);
      const start = performance.now();
      const cancelled = db.transactionScope(async () => { await db.database.querySqlRaw("SELECT pg_sleep(5)"); }, { signal: AbortSignal.timeout(100) });
      expect(await withinBudget(cancelled)).toBe("rejected");
      expect(performance.now() - start).toBeLessThan(1_500);
      expect(await f.context(f.observer).setOf(f.Record).asNoTracking().toList()).toHaveLength(1);
    } finally { await f.close(); }
  }, 15_000);
});
