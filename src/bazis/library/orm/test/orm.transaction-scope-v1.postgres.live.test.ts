import { afterAll, describe, expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, Entity, Key, postgres, type PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const prefix = `ormtx_${run}_`;
const owned = new Set<string>();
const ownedName = /^ormtx_[a-f0-9]{16}_[a-z0-9_]+$/;
const table = (suffix: string) => { const name = `${prefix}${suffix}`; if (!ownedName.test(name) || owned.has(name)) throw new Error("invalid run-owned table"); owned.add(name); return name; };
const quote = (name: string) => { if (!owned.has(name) || !ownedName.test(name)) throw new Error("foreign cleanup rejected"); return `"${name}"`; };
const live = url === undefined ? test.skip : test;
// These legacy disappearance oracles explicitly qualify the connection-close fallback.
async function provider(max?: number): Promise<PostgresProvider> { return max === undefined ? postgres({ url: url!, cancellationMode: "close" }) : postgres({ options: { url: url!, max }, cancellationMode: "close" }); }
async function create(p: PostgresProvider, name: string): Promise<void> { await p.execute(`CREATE TABLE ${quote(name)} (id bigint PRIMARY KEY, value text NOT NULL)`, []); }
class Context extends DbContext { constructor(p: PostgresProvider) { super(new DbContextOptions({ provider: p, entities: [], validateOnSave: false })); } }
const commitTable = table("commit");
const topLevelTable = table("top_level");
const claimsTable = table("claims");
@Entity({ table: commitTable })
class CommitRecord { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) value = ""; }
@Entity({ table: topLevelTable })
class TopLevelRecord { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) value = ""; }
@Entity({ table: claimsTable })
class ClaimRecord { @Key({ generated: false }) @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) value = ""; }
class CommitContext extends DbContext { readonly records = this.set(CommitRecord); constructor(p: PostgresProvider) { super(new DbContextOptions({ provider: p, entities: [CommitRecord], validateOnSave: false })); } }
class TopLevelContext extends DbContext { readonly records = this.set(TopLevelRecord); constructor(p: PostgresProvider) { super(new DbContextOptions({ provider: p, entities: [TopLevelRecord], validateOnSave: false })); } }
class ClaimContext extends DbContext { readonly claims = this.set(ClaimRecord); constructor(p: PostgresProvider) { super(new DbContextOptions({ provider: p, entities: [ClaimRecord], validateOnSave: false })); } }

afterAll(async () => { if (!url) return; const p = await provider(); try { for (const name of [...owned].reverse()) await p.execute(`DROP TABLE IF EXISTS ${quote(name)}`, []); } finally { await p.close(); } });

test.skipIf(Boolean(url))("without the opt-in env, never creates a connection and keeps only run-owned cleanup", () => { expect(url).toBeUndefined(); expect(run).toMatch(/^[a-f0-9]{16}$/); expect(() => quote("foreign_table")).toThrow("foreign cleanup"); });
test.skipIf(!url)("with the opt-in env, admits the authorized runner without exposing its DSN", () => { expect(typeof url).toBe("string"); expect(url!.length).toBeGreaterThan(0); expect(run).toMatch(/^[a-f0-9]{16}$/); });

describe("transaction scopes against a separately authorized disposable PostgreSQL database", () => {
  live("keeps outer and nested work on one backend session", async () => {
    const p = await provider(); const name = table("pid");
    try { await create(p, name); const pids: number[] = []; await p.transactionScope!(async () => { pids.push(Number((await p.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid)); await p.transactionScope!(async () => { pids.push(Number((await p.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid)); }); }); expect(new Set(pids).size).toBe(1); } finally { await p.close(); }
  });
  live("keeps same-root use work on the outer backend session", async () => {
    const p = await provider(); const first = new Context(p); const second = new Context(p);
    try { const pids: number[] = []; await first.transactionScope(async (tx) => { pids.push(Number((await first.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid)); await tx.use(second, async (used) => { pids.push(Number((await used.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid)); }); }); expect(new Set(pids).size).toBe(1); } finally { await p.close(); }
  });
  live("reads fresh database time statements within one transaction", async () => {
    const p = await provider(); const db = new Context(p);
    try { await db.transactionScope(async (tx) => { const before = await tx.databaseTime(); await db.database.querySqlRaw("SELECT pg_sleep(0.02)"); const after = await tx.databaseTime(); expect(after.epochMilliseconds).toBeGreaterThan(before.epochMilliseconds); expect(after.instant.getTime()).toBe(after.epochMilliseconds); }); } finally { await p.close(); }
  }, 10_000);
  live("rolls back nested and outer writes observed by a fresh provider", async () => {
    const p = await provider(); const name = table("rollback");
    try { await create(p, name); await expect(p.transactionScope!(async () => { await p.execute(`INSERT INTO ${quote(name)} VALUES (1,'outer')`, []); await expect(p.transactionScope!(async () => { await p.execute(`INSERT INTO ${quote(name)} VALUES (2,'child')`, []); throw new Error("child"); })).rejects.toThrow("child"); throw new Error("outer"); })).rejects.toThrow("outer"); const fresh = await provider(); try { expect(await fresh.query(`SELECT id FROM ${quote(name)}`, [])).toEqual([]); } finally { await fresh.close(); } } finally { await p.close(); }
  });
  live("afterCommit waits for physical commit and discards failed child callbacks", async () => {
    const p = await provider(); const db = new CommitContext(p); const events: string[] = [];
    try {
      await create(p, commitTable);
      await db.transactionScope(async () => {
        db.records.add(Object.assign(new CommitRecord(), { id: 1, value: "committed" }));
        expect(await db.saveChanges()).toBe(1);
        expect(await db.saveChanges()).toBe(0);
        p.afterCommit(async () => {
          const fresh = await provider();
          try {
            const read = new CommitContext(fresh);
            expect((await read.records.where(x => x.id.eq(1)).toList()).map(x => x.value)).toEqual(["committed"]);
            expect((await read.records.where(x => x.id.eq(2)).toList())).toEqual([]);
            events.push("outer");
          } finally { await fresh.close(); }
        });
        await db.transactionScope(async () => { p.afterCommit(() => { events.push("child"); }); });
        await expect(db.transactionScope(async () => {
          db.records.add(Object.assign(new CommitRecord(), { id: 2, value: "discarded" }));
          await db.saveChanges();
          p.afterCommit(() => { events.push("discarded"); });
          throw new Error("child");
        })).rejects.toThrow("child");
        expect(events).toEqual([]);
      });
      expect(events).toEqual(["outer", "child"]);
    } finally { await p.close(); }
  });
  live("owned max=1 release lets afterCommit open another transaction on the same provider", async () => {
    const p = await provider(1); const db = new Context(p); let callbackActive: boolean | undefined; let callbackRead = 0;
    try {
      await db.transactionScope(async () => {
        p.afterCommit(async () => { callbackActive = p.isTransactionActive(); await p.transaction(async () => { callbackRead = (await p.query("SELECT 1 AS alive", [])).length; }); });
      });
      expect(callbackActive).toBe(false); expect(callbackRead).toBe(1);
    } finally { await p.close(); }
  }, 15_000);
  live("SET LOCAL polling restores after savepoint rollback and re-admits each sibling ORM frame", async () => {
    const p = await provider(1); const db = new Context(p);
    const setting = async () => String((await p.query("SELECT current_setting('client_connection_check_interval') AS value", []))[0]!.value);
    try {
      const baseline = await setting();
      await p.transaction(async () => {
        await expect(db.transactionScope(async () => {
          expect(await db.database.querySqlRaw("SELECT current_setting('client_connection_check_interval') AS value")).toEqual([{ value: "250ms" }]);
          throw new Error("undo polling savepoint");
        })).rejects.toThrow("undo polling savepoint");
        expect(await setting()).toBe(baseline);
        await db.transactionScope(async () => { expect(await db.database.querySqlRaw("SELECT current_setting('client_connection_check_interval') AS value")).toEqual([{ value: "250ms" }]); });
      });
      expect(await setting()).toBe(baseline);
      await expect(p.transaction(async () => { await db.transactionScope(async () => { expect(await db.database.querySqlRaw("SELECT current_setting('client_connection_check_interval') AS value")).toEqual([{ value: "250ms" }]); }); throw new Error("root rollback"); })).rejects.toThrow("root rollback");
      expect(await setting()).toBe(baseline);
    } finally { await p.close(); }
  }, 15_000);
  live("top-level save preserves afterCommit mutation for one later physical update", async () => {
    const p = await provider(); const db = new TopLevelContext(p);
    try {
      await create(p, topLevelTable);
      const originalTransaction = p.transaction.bind(p);
      for (const throws of [false, true]) {
        const id = throws ? 12 : 11;
        const record = Object.assign(new TopLevelRecord(), { id, value: "original" });
        let injectAfterCommit = true;
        Object.defineProperty(p, "transaction", { configurable: true, value: async <T>(work: Parameters<typeof p.transaction>[0]): Promise<T> => originalTransaction(async (executor) => {
          if (injectAfterCommit) {
            injectAfterCommit = false;
            p.afterCommit(() => { record.value = "mutated"; if (throws) throw new Error("post-commit"); });
          }
          return work(executor) as Promise<T>;
        }) });
        db.records.add(record);
        if (throws) await expect(db.saveChanges()).rejects.toThrow(); else expect(await db.saveChanges()).toBe(1);
        const freshBefore = await provider();
        try { expect((await freshBefore.query(`SELECT value FROM ${quote(topLevelTable)} WHERE id = $1`, [id]))[0]!.value).toBe("original"); } finally { await freshBefore.close(); }
        expect(await db.saveChanges()).toBe(1);
        expect(await db.saveChanges()).toBe(0);
        const freshAfter = await provider();
        try { expect((await freshAfter.query(`SELECT value FROM ${quote(topLevelTable)} WHERE id = $1`, [id]))[0]!.value).toBe("mutated"); } finally { await freshAfter.close(); }
      }
    } finally { await p.close(); }
  });
  live("claims skip-locked rows with independent providers", async () => {
    const first = await provider(); const second = await provider(); const firstDb = new ClaimContext(first); const secondDb = new ClaimContext(second);
    let releaseFirst!: () => void; const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalFirst!: () => void; const firstClaimed = new Promise<void>((resolve) => { signalFirst = resolve; });
    let firstScope: Promise<void> | undefined; let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await create(first, claimsTable);
      await first.execute(`INSERT INTO ${quote(claimsTable)} VALUES (1,'a'),(2,'b')`, []);
      firstScope = firstDb.transactionScope(async () => {
        expect((await firstDb.claims.where(x => x.id.gt(0)).orderBy(x => x.id).take(1).forUpdate({ skipLocked: true }).toList()).map(x => x.id)).toEqual([1]);
        signalFirst();
        await firstHeld;
      });
      await Promise.race([firstClaimed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("first claim did not start")), 5_000); })]);
      clearTimeout(timeout); timeout = undefined;
      await secondDb.transactionScope(async () => {
        expect((await secondDb.claims.where(x => x.id.gt(0)).orderBy(x => x.id).take(1).forUpdate({ skipLocked: true }).toList()).map(x => x.id)).toEqual([2]);
      });
      releaseFirst();
      await firstScope;
    } finally { clearTimeout(timeout); releaseFirst?.(); await firstScope?.catch(() => {}); await first.close(); await second.close(); }
  });
  live("cancels an acknowledged pg_sleep, rolls back freshly, and keeps the root pool usable", async () => {
    const p = await provider(1); const observer = await provider(); const db = new Context(p); const name = table("cancel");
    let release!: () => void; const closing = new Promise<void>((resolve) => { release = resolve; });
    let scopedPid!: number; let scopedDatid!: string; let scopedBackendStart!: string; let exposePid!: () => void; const pidReady = new Promise<void>((resolve) => { exposePid = resolve; });
    let sleepOutcome: Promise<"resolved" | "rejected"> = Promise.resolve("resolved");
    let scope: Promise<void> | undefined;
    try {
      await create(p, name);
      scope = db.transactionScope(async () => {
        await db.database.querySqlRaw(`INSERT INTO ${quote(name)} VALUES (1,'pending')`);
        const identity = (await db.database.querySqlRaw("SELECT pg_backend_pid()::text AS pid, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()"))[0]!;
        scopedPid = Number(identity.pid); scopedDatid = String(identity.datid); scopedBackendStart = String(identity.backend_start);
        sleepOutcome = db.database.querySqlRaw("SELECT pg_sleep(30)").then(() => "resolved" as const, () => "rejected" as const);
        exposePid();
        await closing;
      });
      await pidReady;
      const deadline = Date.now() + 5_000;
      let active = false;
      while (!active && Date.now() < deadline) {
        const rows = await observer.query("SELECT pid FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query = 'SELECT pg_sleep(30)'", [scopedPid]);
        active = rows.length === 1;
        if (!active) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(active).toBe(true);
      release();
      await expect(scope).rejects.toThrow();
      expect(await sleepOutcome).toBe("rejected");
      const gone = await observer.query("SELECT pid::text AS pid, datid::text AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = $1", [scopedPid]);
      expect(gone.length === 0 || String(gone[0]!.pid) !== String(scopedPid) || String(gone[0]!.datid) !== scopedDatid || String(gone[0]!.backend_start) !== scopedBackendStart).toBe(true);
      const fresh = await provider();
      try { expect(await fresh.query(`SELECT id FROM ${quote(name)}`, [])).toEqual([]); } finally { await fresh.close(); }
      expect(await p.query("SELECT 1 AS alive", [])).toHaveLength(1);
    } finally {
      release?.();
      await scope?.catch(() => {});
      await observer.close();
      await p.close();
    }
  }, 15_000);
  live("caught nested physical quarantine poisons a raw outer transaction and rolls back both writes", async () => {
    const p = await provider(1); const observer = await provider(); const db = new Context(p); const name = table("nested_quarantine");
    let release!: () => void; const closing = new Promise<void>((resolve) => { release = resolve; }); let pid = ""; let datid = ""; let backendStart = ""; let inner: Promise<void> | undefined; let outer: Promise<void> | undefined; let caughtInner = false;
    try {
      await create(p, name);
      outer = p.transaction(async () => {
        await p.execute(`INSERT INTO ${quote(name)} VALUES (1,'outer')`, []);
        inner = db.transactionScope(async () => {
          await db.database.querySqlRaw(`INSERT INTO ${quote(name)} VALUES (2,'inner')`);
          const identity = (await db.database.querySqlRaw("SELECT pg_backend_pid()::text AS pid, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()"))[0]!;
          pid = String(identity.pid); datid = String(identity.datid); backendStart = String(identity.backend_start);
          const sleep = db.database.querySqlRaw("SELECT pg_sleep(30)"); void sleep.then(() => {}, () => {}); await closing;
        });
        void inner.then(() => {}, () => {});
        try { await inner; } catch { caughtInner = true; }
      }); void outer.catch(() => {});
      const ackDeadline = Date.now() + 5_000; let active = false;
      while (!active && Date.now() < ackDeadline) { active = (await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query = 'SELECT pg_sleep(30)'", [pid || "0"])).length === 1; if (!active) await new Promise<void>((resolve) => setTimeout(resolve, 25)); }
      expect(active).toBe(true); release();
      await expect(outer).rejects.toThrow();
      expect(caughtInner).toBe(true);
      const gone = await observer.query("SELECT pid::text AS pid, datid::text AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = $1", [pid]);
      expect(gone.length === 0 || String(gone[0]!.pid) !== pid || String(gone[0]!.datid) !== datid || String(gone[0]!.backend_start) !== backendStart).toBe(true);
      const fresh = await provider(); try { expect(await fresh.query(`SELECT id FROM ${quote(name)} ORDER BY id`, [])).toEqual([]); } finally { await fresh.close(); }
      expect(await p.query("SELECT 1 AS alive", [])).toHaveLength(1);
    } finally { release?.(); await inner?.catch(() => {}); await outer?.catch(() => {}); await observer.close(); await p.close(); }
  }, 15_000);
  live("healthy borrowed migration reservation retains advisory lock across inner ORM scope", async () => {
    const p = await provider(1); const observer = await provider(); const db = new Context(p); let pid = 0;
    try {
      await p.withMigrationLock!(async () => {
        await db.transactionScope(async () => { pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid); });
        expect((await observer.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [pid])).length).toBeGreaterThan(0);
      });
      expect((await observer.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [pid])).length).toBe(0);
      expect(await p.query("SELECT 1 AS alive", [])).toHaveLength(1);
    } finally { await observer.close(); await p.close(); }
  }, 15_000);
  live("borrowed migration reservation quarantine drops advisory locks and preserves the scope failure", async () => {
    const p = await provider(1); const observer = await provider(); const db = new Context(p); const name = table("borrowed_quarantine");
    let release!: () => void; const closing = new Promise<void>((resolve) => { release = resolve; }); let pid = ""; let datid = ""; let backendStart = ""; let operation: Promise<void> | undefined;
    try {
      await create(p, name);
      operation = p.withMigrationLock!(async () => db.transactionScope(async () => {
        await db.database.querySqlRaw(`INSERT INTO ${quote(name)} VALUES (1,'pending')`);
        const identity = (await db.database.querySqlRaw("SELECT pg_backend_pid()::text AS pid, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()"))[0]!;
        pid = String(identity.pid); datid = String(identity.datid); backendStart = String(identity.backend_start);
        const sleep = db.database.querySqlRaw("SELECT pg_sleep(30)"); void sleep.then(() => {}, () => {}); await closing;
      })); void operation.catch(() => {});
      const deadline = Date.now() + 5_000; let active = false;
      while (!active && Date.now() < deadline) { active = (await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query = 'SELECT pg_sleep(30)'", [pid || "0"])).length === 1; if (!active) await new Promise<void>((resolve) => setTimeout(resolve, 25)); }
      expect(active).toBe(true); release(); await expect(operation).rejects.toThrow();
      const gone = await observer.query("SELECT pid::text AS pid, datid::text AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start FROM pg_stat_activity WHERE pid = $1", [pid]);
      expect(gone.length === 0 || String(gone[0]!.pid) !== pid || String(gone[0]!.datid) !== datid || String(gone[0]!.backend_start) !== backendStart).toBe(true);
      expect((await observer.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [pid])).length).toBe(0);
      const fresh = await provider(); try { expect(await fresh.query(`SELECT id FROM ${quote(name)}`, [])).toEqual([]); } finally { await fresh.close(); }
      expect(await p.query("SELECT 1 AS alive", [])).toHaveLength(1);
    } finally { release?.(); await operation?.catch(() => {}); await observer.close(); await p.close(); }
  }, 15_000);
});
