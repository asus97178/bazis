import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { Column, DbContext, DbContextOptions, Entity, EntityState, Key, PostgresProvider, Repository, Schema, withRetry } from "../../src/osnova/library/orm";
import { serverCancellationCases } from "../../src/osnova/library/orm/test/fixtures/serverCancellationQualification";
import { dbConfig } from "../../src/app/config/db.config";
import { Configuration } from "../../src/osnova/core/kernel";
import { User } from "../../src/app/modules/actor_modules/users/User";
import { UserService } from "../../src/app/modules/actor_modules/users/UserService";
import { UsersDbContext } from "../../src/app/modules/actor_modules/users/UsersDbContext";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const emit = (value: unknown) => console.log(JSON.stringify(value));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const outcome = <T>(work: Promise<T>) => work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
const fingerprint = () => ({ version: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch });
class Context extends DbContext {}
class PlannedRollback extends Error {}

function environment() {
  check(process.env.OSNV_ORM_ENTERPRISE_LIVE === "owned-disposable-v1", "Explicit owned disposable qualification is required");
  const url = new URL(process.env.OSNV_PG_URL!);
  check(url.hostname === "127.0.0.1" && /^\/cancel_[a-f0-9]+$/.test(url.pathname), "Only the owned loopback database is allowed");
  const ca = readFileSync(process.env.OSNV_SERVER_CANCEL_CA!, "utf8");
  const config = dbConfig.resolve("test", Configuration.empty());
  const options = (max: number, value = url.toString()) => ({ url: value, max,
    tls: { ca, serverName: "localhost", rejectUnauthorized: true },
    connectionTimeout: config.get("connectionTimeout"), idleTimeout: config.get("idleTimeout"), maxLifetime: config.get("maxLifetime"),
    connection: { statement_timeout: "10000", idle_in_transaction_session_timeout: "10000", application_name: "orm_enterprise_qualification" } });
  return { url, options, policy: { operationTimeoutMs: config.get("operationTimeoutMs"), cancellationTimeoutMs: config.get("cancellationTimeoutMs"),
    cancellationMode: config.get("cancellationMode"), maxPendingOperations: config.get("maxPendingOperations") } };
}

class Histogram {
  private readonly counts = new Uint32Array(60_001);
  count = 0;
  max = 0;
  add(ms: number) { this.count++; this.max = Math.max(this.max, ms); this.counts[Math.min(60_000, Math.ceil(Math.max(0, ms)))]!++; }
  percentile(fraction: number) { let total = 0; const at = Math.ceil(this.count * fraction); for (let i = 0; i < this.counts.length; i++) { total += this.counts[i]!; if (total >= at) return i === 60_000 ? this.max : i; } return 0; }
  snapshot() { return { count: this.count, p50Ms: this.percentile(.5), p95Ms: this.percentile(.95), p99Ms: this.percentile(.99), maxMs: this.max }; }
  reset() { this.counts.fill(0); this.count = 0; this.max = 0; }
}

async function acknowledge(observer: SQL, pid: () => number, sql: string) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    const rows = await observer.unsafe("SELECT s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.pid=$1 AND a.state='active' AND a.query=$2", [pid(), sql]);
    if (rows.length) { check(rows[0].ssl === true, "Worker is not using TLS"); return; }
    await sleep(3);
  }
  throw new Error("Exact active SQL was not independently acknowledged");
}

async function soak() {
  const { options, policy } = environment();
  const seconds = Number(process.env.OSNV_ORM_SOAK_SECONDS ?? 900), rate = Number(process.env.OSNV_ORM_SOAK_RATE ?? 50);
  check(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600 && Number.isInteger(rate) && rate >= 1 && rate <= 500, "Invalid soak profile");
  const schema = `ent_${crypto.randomUUID().replaceAll("-", "")}`;
  @Schema(schema) @Entity({ table: "ledger" }) class Ledger {
    @Key({ generated: false }) @Column({ type: "integer" }) id = 0;
    @Column({ type: "text" }) payload = "";
  }
  const provider = new PostgresProvider({ options: options(8), ...policy });
  const observer = new SQL(options(2));
  const context = () => new Context(new DbContextOptions({ provider, entities: [Ledger], validateOnSave: false }));
  const hist = { read: new Histogram(), write: new Histogram(), cancel: new Histogram(), rollback: new Histogram(), loop: new Histogram() };
  const window = new Histogram(), inFlight = new Set<Promise<void>>();
  let sequence = 0, commits = 0, committedSum = 0, confirmedCancels = 0, plannedRollbacks = 0, rollbackCallbacks = 0, commitCallbacks = 0;
  let maxSessions = 0, maxRss = 0, maxFd = 0, overload = 0;
  const failures: { name: string; code?: string; operation: number }[] = [];
  const fail = (error: unknown, operation: number) => { if (failures.length < 20) failures.push({ name: error instanceof Error ? error.name : typeof error, code: (error as { code?: string })?.code, operation }); };
  let lagTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await context().database.ensureCreated();
    const actual = await observer.unsafe("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"); check(actual[0].ssl === true, "Observer is not using TLS");
    await Promise.all(Array.from({ length: 8 }, () => context().transactionScope(async () => provider.query("SELECT 1", []))));
    Bun.gc(true); const initial = process.memoryUsage();
    const start = performance.now(), end = start + seconds * 1000;
    let previousTick = start, nextReport = start + 10_000, previousReport = start, previousCount = 0;
    let warm: ReturnType<typeof process.memoryUsage> | undefined;
    lagTimer = setInterval(() => { const now = performance.now(); hist.loop.add(Math.max(0, now - previousTick - 20)); previousTick = now; }, 20);
    emit({ event: "soak-start", ...fingerprint(), seconds, rate, workerMax: 8, controlMax: 1, maxInFlight: 64, policy, nativeTimeouts: { connection: options(8).connectionTimeout, idle: options(8).idleTimeout, lifetime: options(8).maxLifetime } });

    async function operation(id: number) {
      const db = context(), kind = id % 20 < 10 ? "read" : id % 20 < 17 ? "write" : id % 20 < 19 ? "cancel" : "rollback";
      const started = performance.now();
      let controller: AbortController | undefined;
      try {
        if (kind === "read") {
          await db.transactionScope(async () => { const rows = await db.database.querySqlRaw("SELECT {0}::int AS value", id); check(rows[0]!.value === id, "Readback mismatch"); });
        } else {
          const entity = Object.assign(new Ledger(), { id, payload: `value:${id}` }); db.add(entity);
          controller = new AbortController(); let pid = 0, cb = 0;
          const sql = `SELECT pg_sleep(20) /* ${schema}_${id} */`;
          const result = outcome(db.transactionScope(async tx => {
            tx.afterCommit(() => { commitCallbacks++; cb++; }); provider.afterRollback(() => { rollbackCallbacks++; cb++; });
            await db.saveChanges();
            if (kind === "cancel") { pid = Number((await db.database.querySqlRaw("SELECT pg_backend_pid() AS pid"))[0]!.pid); await db.database.querySqlRaw(sql); }
            if (kind === "rollback") throw new PlannedRollback();
          }, { signal: controller.signal }));
          if (kind === "cancel") { await acknowledge(observer, () => pid, sql); controller.abort(); }
          const settled = await result;
          if (kind === "write") { check(settled.ok, "Expected write failed"); commits++; committedSum += id; }
          else { check(!settled.ok && settled.error?.code !== "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Rollback was not confirmed");
            check(db.stateOf(entity) === EntityState.Added, "Tracking was not restored");
            if (kind === "cancel") confirmedCancels++; else { check(settled.error instanceof PlannedRollback, "Wrong rollback error"); plannedRollbacks++; }
          }
          check(cb === 1, "Outcome callback count mismatch");
        }
        const elapsed = performance.now() - started; hist[kind].add(elapsed); window.add(elapsed);
      } catch (error) { fail(error, id); }
      finally { controller?.abort(); }
    }

    while (performance.now() < end && !failures.length) {
      const due = start + sequence * 1000 / rate;
      if (due > performance.now()) await sleep(Math.min(due - performance.now(), 20));
      if (performance.now() >= end) break;
      if (inFlight.size >= 64) { overload++; await Promise.race(inFlight); continue; }
      const id = ++sequence, work = operation(id); inFlight.add(work); void work.finally(() => inFlight.delete(work));
      const now = performance.now();
      if (now >= nextReport) {
        const sessions = await observer.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user");
        maxSessions = Math.max(maxSessions, sessions[0].n);
        const memory = process.memoryUsage(); maxRss = Math.max(maxRss, memory.rss);
        const fd = process.platform === "linux" ? readdirSync("/proc/self/fd").length : null; if (fd !== null) maxFd = Math.max(maxFd, fd);
        if (!warm && now - start >= Math.min(60, seconds / 3) * 1000) { Bun.gc(true); warm = process.memoryUsage(); }
        const completed = Object.entries(hist).filter(([k]) => k !== "loop").reduce((n, [, v]) => n + v.count, 0);
        emit({ event: "window", elapsedSeconds: (now - start) / 1000, completed, rate: (completed - previousCount) * 1000 / (now - previousReport), inFlight: inFlight.size, latency: window.snapshot(), memory, fd, sessions: sessions[0].n, native: provider.statistics() });
        window.reset(); previousCount = completed; previousReport = now; nextReport = now + 10_000;
      }
    }
    await Promise.all(inFlight); clearInterval(lagTimer); lagTimer = undefined;
    const rows = await observer.unsafe(`SELECT count(*)::int AS n, coalesce(sum(id),0)::text AS total, count(*) FILTER (WHERE id % 20 NOT BETWEEN 10 AND 16 OR payload <> 'value:' || id)::int AS invalid FROM "${schema}".ledger`);
    const idle = await observer.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND state LIKE 'idle in transaction%'");
    const native = provider.statistics(); Bun.gc(true); const final = process.memoryUsage();
    const invariant = { noUnexpectedErrors: failures.length === 0, noOverload: overload === 0, exactWrites: rows[0].n === commits && rows[0].total === String(committedSum) && rows[0].invalid === 0,
      callbacks: commitCallbacks === commits && rollbackCallbacks === confirmedCancels + plannedRollbacks,
      nativeDrained: native.pendingNativeOperations === 0 && native.activeCancellations === 0 && native.unconfirmedCancellations === 0,
      transactionsDrained: idle[0].n === 0, sessionsBounded: maxSessions <= 11, completedDuration: performance.now() - start >= seconds * 1000,
      boundedRssGrowth: final.rss - (warm ?? initial).rss <= 64 * 1024 * 1024, boundedHeapGrowth: final.heapUsed - (warm ?? initial).heapUsed <= 16 * 1024 * 1024 };
    emit({ event: "soak-result", status: Object.values(invariant).every(Boolean) ? "PASS" : "FAIL", ...fingerprint(), seconds: (performance.now() - start) / 1000,
      attempted: sequence, commits, confirmedCancels, plannedRollbacks, overload, failures, invariant, native, memory: { initial, warm, final, maxRss, maxFd }, maxSessions,
      metrics: Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, v.snapshot()])) });
    check(Object.values(invariant).every(Boolean), "Soak invariants failed");
  } finally { clearInterval(lagTimer); await Promise.allSettled(inFlight); await provider.close();
    try { await observer.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await observer.close({ timeout: 0 }); }
  }
}

async function replyRelay(target: URL) {
  let frozen = false; const sockets = new Set<Socket>();
  const server = createServer(front => {
    const back = connect({ host: target.hostname, port: Number(target.port) }); sockets.add(front); sockets.add(back);
    front.on("data", bytes => back.write(bytes)); back.on("data", bytes => { if (!frozen) front.write(bytes); });
    front.on("error", () => {}); back.on("error", () => {});
    front.on("close", () => { sockets.delete(front); if (!frozen) back.destroy(); }); back.on("close", () => { sockets.delete(back); if (!frozen) front.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); check(address && typeof address !== "string", "Relay address missing"); const url = new URL(target); url.port = String(address.port);
  const disconnect = () => { frozen = false; for (const socket of sockets) socket.destroy(); };
  return { url: url.toString(), freeze() { frozen = true; }, disconnect, close() { disconnect(); server.close(); } };
}

async function autocommit() {
  const { options, url } = environment(), observer = new SQL(options(1));
  const schema = `autocommit_${crypto.randomUUID().replaceAll("-", "")}`;
  let passed = true;
  await observer.unsafe(`CREATE SCHEMA "${schema}"`);
  try {
    for (const kind of ["query", "execute"] as const) {
      const table = `"${schema}"."${kind}"`;
      await observer.unsafe(`CREATE TABLE ${table} (value integer NOT NULL)`);
      const text = `INSERT INTO ${table} VALUES (42)${kind === "query" ? " RETURNING value" : ""}`;
      const relay = await replyRelay(url);
      const provider = new PostgresProvider({ options: options(1, relay.url), operationTimeoutMs: 3000, cancellationTimeoutMs: 500 });
      const root = (provider as unknown as { sql: SQL }).sql, reserve = root.reserve.bind(root);
      let dispatched = 0, observed = false, fault: Promise<void> | undefined;
      root.reserve = (async (...args: Parameters<typeof reserve>) => {
        const session = await reserve(...args), unsafe = session.unsafe.bind(session);
        // Cache the exact statement before dropping encrypted replies. The
        // independent observer must see the real autocommitted row first.
        await unsafe("BEGIN"); await unsafe(text); await unsafe("ROLLBACK");
        return { ...session, unsafe(sql: string, params?: readonly unknown[]) {
          if (sql === text && ++dispatched === 1) {
            relay.freeze();
            fault = (async () => {
              const until = performance.now() + 2000;
              while (performance.now() < until) {
                const rows = await observer.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
                if (rows[0].n === 1) { observed = true; break; }
                await sleep(2);
              }
              relay.disconnect();
            })();
          }
          return unsafe(sql, params as never);
        }, release: session.release.bind(session), close: session.close.bind(session) } as never;
      }) as typeof root.reserve;
      try {
        const result = await outcome<unknown>(withRetry(provider, { maxRetries: 2, baseDelayMs: 1 })[kind](text, []));
        await fault;
        const rows = await observer.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
        const error = result.ok ? undefined : result.error;
        const safe = observed && !result.ok && error?.code === "ORM_TRANSACTION_OUTCOME_UNKNOWN" && error.phase === "commit" && dispatched === 1 && rows[0].n === 1;
        passed &&= safe;
        emit({ event: "autocommit-case", status: safe ? "PASS" : "FAIL", ...fingerprint(), kind, serverCommitObservedBeforeDisconnect: observed,
          dispatched, persistedRows: rows[0].n, returnedSuccess: result.ok, code: error?.code, phase: error?.phase, nativeCode: error?.cause?.code });
      } finally { relay.close(); await provider.close(); }
    }
  } finally { await observer.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await observer.close({ timeout: 0 }); }
  check(passed, "Ambiguous autocommit was replayed or not identified as unknown");
  emit({ event: "autocommit-result", status: "PASS", ...fingerprint() });
}

async function business() {
  const { options, url } = environment(), clean = new PostgresProvider({ options: options(2) });
  const context = (provider: PostgresProvider) => new UsersDbContext(new DbContextOptions({ provider, entities: [User], executionStrategy: { maxRetries: 3, baseDelayMs: 1, isTransient: () => true } }));
  await context(clean).database.ensureCreated();
  const relay = await replyRelay(url), provider = new PostgresProvider({ options: options(1, relay.url), operationTimeoutMs: 800, cancellationTimeoutMs: 300 });
  const root = (provider as unknown as { sql: SQL }).sql, reserve = root.reserve.bind(root);
  let commitDispatched = 0, callbacks = 0, saved = 0;
  root.reserve = (async (...args: Parameters<typeof reserve>) => {
    const session = await reserve(...args), unsafe = session.unsafe.bind(session);
    // Prepare the exact COMMIT text before dropping replies; the real COMMIT
    // must be executed, not merely parsed before the response is lost.
    await unsafe("BEGIN"); await unsafe("COMMIT");
    return { ...session, unsafe(text: string, params?: readonly unknown[]) {
      if (text === "COMMIT") { commitDispatched++; relay.freeze(); }
      return unsafe(text, params as never);
    }, release: session.release.bind(session), close: session.close.bind(session) } as never;
  }) as typeof root.reserve;
  const db = context(provider), email = `unknown-${crypto.randomUUID()}@example.test`, repo = new Repository(db, User), service = new UserService(repo);
  try {
    const original = repo.saveChanges.bind(repo); repo.saveChanges = () => { saved++; return original(); };
    const result = await outcome(db.transactionScope(async tx => { tx.afterCommit(() => { callbacks++; }); provider.afterRollback(() => { callbacks++; }); return service.create({ name: "Qualified User", email, age: 30 }); }));
    check(!result.ok && result.error?.code === "ORM_TRANSACTION_OUTCOME_UNKNOWN" && result.error.phase === "commit", "Lost COMMIT response was not unknown");
    check(commitDispatched === 1 && saved === 1 && callbacks === 0, "Business work or callbacks were replayed");
    const retry = await outcome(db.saveChanges()); check(!retry.ok && retry.error?.code === "ORM_TRANSACTION_OUTCOME_UNKNOWN", "Uncertain DbContext allowed another save");
    const matches = await context(clean).users.asNoTracking().where(user => user.email.eq(email)).toList();
    check(matches.length === 1 && matches[0]!.name === "Qualified User", "Fresh reconciliation did not find the committed User");
    const duplicate = await outcome(new UserService(new Repository(context(clean), User)).create({ name: "Qualified User", email, age: 30 }));
    check(!duplicate.ok, "Duplicate business request unexpectedly succeeded");
    check(await context(clean).users.asNoTracking().where(user => user.email.eq(email)).count() === 1, "Duplicate row survived reconciliation");
    emit({ event: "business-result", status: "PASS", ...fingerprint(), operation: "UserService.create", lostTlsCommitResponse: true, commitDispatched, saveCalls: saved, callbacks,
      unknownPhase: result.error.phase, freshReconciliationRows: matches.length, duplicateRows: 0, key: "normalized unique email", generalApiIdempotency: false });
  } finally { relay.close(); await provider.close(); await clean.execute('DELETE FROM "Users" WHERE email=$1', [email]); await clean.close(); }
}

const mode = Bun.argv[2];
try {
  check(Bun.version === "1.4.0" && Bun.revision === "34cbb9a40b4bd1bd767d134a7065e66c2432a676", "Runtime fingerprint mismatch");
  if (mode === "fingerprint") emit({ event: "fingerprint", ...fingerprint() });
  else if (mode === "soak") await soak();
  else if (mode === "business") await business();
  else if (mode === "autocommit") await autocommit();
  else if (mode === "matrix") {
    environment(); let pass = 0, fail = 0, assertions = 0;
    for (const scenario of serverCancellationCases()) { try { const row = await scenario.run(); pass++; assertions += row.assertions as number; emit({ ...row, status: "PASS" }); }
      catch (error) { fail++; emit({ name: scenario.name, status: "FAIL", error: error instanceof Error ? error.message : String(error) }); } }
    emit({ event: "matrix-result", pass, fail, assertions, ...fingerprint() }); check(fail === 0 && pass === 33, "Physical matrix failed");
  } else throw new Error("Expected fingerprint, matrix, business, autocommit or soak");
} catch (error) { emit({ event: "failure", name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : "Qualification failed" }); process.exitCode = 1; }
