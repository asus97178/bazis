import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { DbContext, DbContextOptions, PostgresProvider } from "../index";

const url = process.env.BAZIS_PG_URL;
const enabled = !!url && process.env.BAZIS_ORM_HARDENING_LIVE === "1";
class Context extends DbContext {}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const context = (provider: PostgresProvider) => new Context(new DbContextOptions({ provider, entities: [] }));
async function eventually(work: () => Promise<boolean>, ms = 3000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await work()) return; await delay(15); }
  throw new Error("Physical condition did not become true within its budget.");
}

/** Loopback fault relay. Only byte counts may be inspected; packet contents are never logged. */
async function relay() {
  const target = new URL(url!); const upstreamHost = target.hostname, upstreamPort = Number(target.port); let frozen = false, loseCommitReply = false, commitSeen = false;
  const sockets = new Set<Socket>();
  const server = createServer(front => {
    const back = connect({ host: upstreamHost, port: upstreamPort });
    sockets.add(front); sockets.add(back);
    front.on("data", bytes => {
      if (frozen) return;
      if (loseCommitReply && Buffer.from(bytes).includes(Buffer.from("COMMIT"))) commitSeen = true;
      back.write(bytes);
    });
    back.on("data", bytes => { if (!frozen && !commitSeen) front.write(bytes); });
    front.on("error", () => {}); back.on("error", () => { if (!frozen) front.destroy(); });
    front.on("close", () => { sockets.delete(front); if (!frozen) back.destroy(); });
    back.on("close", () => { sockets.delete(back); if (!frozen) front.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback address unavailable.");
  target.hostname = "127.0.0.1"; target.port = String(address.port);
  return { url: target.toString(), freeze() { frozen = true; }, loseCommitReply() { loseCommitReply = true; }, get commitSeen() { return commitSeen; }, close() { frozen = false; for (const socket of sockets) socket.destroy(); sockets.clear(); server.close(); } };
}

describe.skipIf(!enabled)("Bun.SQL bounded fault qualification", () => {
  test("native reserve aborts while max=1 stays occupied", async () => {
    const sql = new SQL({ url, max: 1 }); const held = await sql.reserve();
    try {
      const start = performance.now();
      await expect(sql.reserve({ signal: AbortSignal.timeout(80) })).rejects.toThrow();
      expect(performance.now() - start).toBeLessThan(800);
      expect(Number((await held.unsafe("SELECT 41 AS n"))[0].n)).toBe(41);
    } finally { held.release(); await sql.close({ timeout: 0 }); }
  });

  test("ORM queued cancellation returns before the owner releases its slot", async () => {
    const p = new PostgresProvider({ options: { url, max: 1 } }); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { started = r; }); let calls = 0;
    const owner = context(p).transactionScope(async () => { started(); await gate; }); await began;
    try {
      const start = performance.now();
      await expect(context(p).transactionScope(async () => { calls++; }, { timeoutMs: 80 })).rejects.toThrow();
      expect(performance.now() - start).toBeLessThan(800); expect(calls).toBe(0);
    } finally { release(); await owner; await p.close(); }
  });

  test("configured server limits are read back and statement timeout rolls back", async () => {
    const p = new PostgresProvider({ options: { url, max: 1 }, serverTimeouts: { statementTimeoutMs: 80, lockTimeoutMs: 40, idleInTransactionTimeoutMs: 1000, transactionTimeoutMs: 2000 } });
    try {
      await expect(context(p).transactionScope(async () => { await p.query("SELECT pg_sleep(2)", []); })).rejects.toThrow();
      expect(await p.ping()).toBe(true);
      // SET LOCAL cannot contaminate a later borrower outside the transaction.
      expect((await p.query("SELECT current_setting('statement_timeout') AS value", []))[0]!.value).toBe("0");
    } finally { await p.close(); }
  });

  test("simultaneous cancellation and repeated reuse preserve bounded pool progress", async () => {
    const p = new PostgresProvider({ options: { url, max: 4 }, operationTimeoutMs: 5000 });
    try {
      for (let round = 0; round < 12; round++) {
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => context(p).transactionScope(async () => { await p.query("SELECT pg_sleep(3)", []); }, { timeoutMs: 120 })));
        expect(results.every(x => x.status === "rejected")).toBe(true);
        expect((await p.query("SELECT 42 AS value", []))[0]!.value).toBe(42);
      }
      await eventually(async () => p.statistics().pendingNativeOperations === 0);
      expect(p.statistics().activeCancellations).toBe(0);
      expect(p.statistics().unconfirmedCancellations).toBe(0);
    } finally { await p.close(); }
  }, 20000);

  test("server closing every idle connection does not stall queued transactions", async () => {
    const p = new PostgresProvider({ options: { url, max: 4, connection: { application_name: "bazis-hardening-idle" } } }); const observer = new SQL({ url });
    try {
      const rows = await Promise.all(Array.from({ length: 4 }, () => p.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.03)", [])));
      const pids = [...new Set(rows.map(result => Number(result[0]!.pid)))]; expect(pids).toHaveLength(4);
      const killed = await observer.unsafe(`SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid IN (${pids.join(",")})`);
      expect(killed.filter((row: { killed: boolean }) => row.killed)).toHaveLength(4);
      const until = performance.now() + 25; while (performance.now() < until) { /* exercise deferred close events */ }
      // Work already borrowing a server-killed slot may fail; it must settle.
      await Promise.allSettled(Array.from({ length: 12 }, () => context(p).transactionScope(async () => { await p.query("SELECT 42 AS value", []); })));
      await Promise.all(Array.from({ length: 12 }, () => context(p).transactionScope(async () => { expect((await p.query("SELECT 42 AS value", []))[0]!.value).toBe(42); })));
    } finally { await p.close(); await observer.close({ timeout: 0 }); }
  });

  test("network blackhole returns unconfirmed cancellation without publishing rollback", async () => {
    const fault = await relay(); const p = new PostgresProvider({ options: { url: fault.url, max: 1 }, cancellationTimeoutMs: 250 }); const observer = new SQL({ url });
    const controller = new AbortController(); let pid = 0, callbacks = 0;
    const operation = context(p).transactionScope(async () => { p.afterRollback(() => { callbacks++; }); pid = Number((await p.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); await p.query("SELECT pg_sleep(10)", []); }, { signal: controller.signal });
    void operation.catch(() => {});
    try {
      await eventually(async () => (await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query='SELECT pg_sleep(10)'", [pid])).length === 1);
      fault.freeze(); const start = performance.now(); controller.abort();
      await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "cancellation" });
      expect(performance.now() - start).toBeLessThan(1500); expect(callbacks).toBe(0);
      expect((await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).length).toBe(1);
      fault.close();
      await eventually(async () => (await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).length === 0);
      expect(callbacks).toBe(0);
    } finally { controller.abort(); fault.close(); await operation.catch(() => {}); await p.close(); await observer.close({ timeout: 0 }); }
  }, 10000);

  test("lost physical COMMIT reply preserves committed row and reports unknown without replay", async () => {
    const observer = new SQL({ url }); const table = `ack_${crypto.randomUUID().replaceAll("-", "")}`;
    await observer.unsafe(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
    const fault = await relay(); const p = new PostgresProvider({ options: { url: fault.url, max: 1 }, operationTimeoutMs: 600, cancellationTimeoutMs: 250 }); let callbacks = 0, calls = 0;
    try {
      fault.loseCommitReply();
      await expect(context(p).transactionScope(async tx => { calls++; tx.afterCommit(() => { callbacks++; }); p.afterRollback(() => { callbacks++; }); await p.execute(`INSERT INTO ${table} VALUES (1)`, []); })).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "commit" });
      expect(fault.commitSeen).toBe(true); expect(calls).toBe(1); expect(callbacks).toBe(0);
      expect((await observer.unsafe(`SELECT id FROM ${table}`)).map((x: { id: number }) => x.id)).toEqual([1]);
    } finally { fault.close(); await p.close(); await observer.unsafe(`DROP TABLE ${table}`); await observer.close({ timeout: 0 }); }
  }, 10000);

  test("PostgreSQL restart changes identity and old cancellation returns unknown in budget", async () => {
    const id = process.env.BAZIS_ORM_HARDENING_CONTAINER!, run = process.env.BAZIS_ORM_HARDENING_RUN!;
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{12}$/.test(run)) throw new Error("Owned disposable container identity is required.");
    const inspect = Bun.spawnSync(["/usr/local/bin/docker", "inspect", id]);
    const state = JSON.parse(inspect.stdout.toString())[0]; expect(state.Config.Labels["bazis.orm-qualification-run"]).toBe(run);
    const p = new PostgresProvider({ options: { url, max: 1 }, cancellationTimeoutMs: 250 }); const observer = new SQL({ url }); const controller = new AbortController();
    let pid = 0, callbacks = 0;
    const operation = context(p).transactionScope(async () => { p.afterRollback(() => { callbacks++; }); pid = Number((await p.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid); try { await p.query("SELECT pg_sleep(20)", []); } catch { await new Promise(() => {}); } }, { signal: controller.signal }); void operation.catch(() => {});
    try {
      await eventually(async () => (await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query='SELECT pg_sleep(20)'", [pid])).length === 1);
      const restart = Bun.spawn(["/usr/local/bin/docker", "exec", "--user", "postgres", id, "pg_ctl", "-D", "/var/lib/postgresql/data", "-m", "fast", "-w", "restart"], { stdout: "ignore", stderr: "pipe" });
      expect(await restart.exited).toBe(0);
      const start = performance.now(); controller.abort();
      await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "cancellation" });
      expect(performance.now() - start).toBeLessThan(1500); expect(callbacks).toBe(0);
      expect(await p.ping()).toBe(true);
    } finally { controller.abort(); await operation.catch(() => {}); await p.close(); await observer.close({ timeout: 0 }); }
  }, 15000);

  test("TLS validates the configured CA and rejects an incorrect hostname", async () => {
    const file = process.env.BAZIS_ORM_TLS_CA_FILE;
    if (!file) throw new Error("Disposable TLS certificate is required for qualification.");
    const ca = readFileSync(file, "utf8");
    const good = new PostgresProvider({ options: { url, tls: { ca, rejectUnauthorized: true, serverName: "localhost" } } });
    const bad = new PostgresProvider({ options: { url, tls: { ca, rejectUnauthorized: true, serverName: "invalid.example" } }, operationTimeoutMs: 500 });
    try { expect(await good.ping()).toBe(true); expect(await bad.ping()).toBe(false); }
    finally { await good.close(); await bad.close(); }
  });

  for (const guarded of [false, true]) test(`TLS cancellation ${guarded ? "is confirmed after the server statement limit" : "returns bounded unknown when native close leaves the backend active"}`, async () => {
    const file = process.env.BAZIS_ORM_TLS_CA_FILE;
    if (!file) throw new Error("Disposable TLS certificate is required for qualification.");
    const options = { url, max: 2, tls: { ca: readFileSync(file, "utf8"), rejectUnauthorized: true, serverName: "localhost" } };
    const p = new PostgresProvider({ options, cancellationMode: "close", cancellationTimeoutMs: guarded ? 2000 : 200, serverTimeouts: guarded ? { statementTimeoutMs: 600 } : undefined });
    const observer = new SQL(options), db = context(p), controller = new AbortController();
    let pid = 0, callbacks = 0;
    const operation = db.transactionScope(async () => {
      p.afterRollback(() => { callbacks++; });
      pid = Number((await p.query("SELECT pg_backend_pid() AS pid", []))[0]!.pid);
      await p.query("SELECT pg_sleep(3) /* tls_bounded */", []);
    }, { signal: controller.signal }); void operation.catch(() => {});
    try {
      await eventually(async () => (await observer.unsafe("SELECT 1 FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE pid=$1 AND s.ssl AND state='active' AND query='SELECT pg_sleep(3) /* tls_bounded */'", [pid])).length === 1);
      const start = performance.now(); controller.abort();
      if (guarded) {
        await expect(operation).rejects.toThrow();
        expect(callbacks).toBe(1);
        expect((await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).length).toBe(0);
      } else {
        await expect(operation).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", phase: "cancellation" });
        expect(callbacks).toBe(0);
        expect((await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active'", [pid])).length).toBe(1);
        await expect(db.saveChanges()).rejects.toMatchObject({ code: "ORM_TRANSACTION_OUTCOME_UNKNOWN" });
      }
      const cancellationMs = performance.now() - start;
      expect(cancellationMs).toBeLessThan(1500);
      expect(p.statistics().unconfirmedCancellations).toBe(guarded ? 0 : 1);
      expect(await p.ping()).toBe(true);
      console.log(JSON.stringify({ tls: true, guarded, cancellationMs, callbacks, statistics: p.statistics() }));
      await eventually(async () => (await observer.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).length === 0, 4000);
      expect(callbacks).toBe(guarded ? 1 : 0);
    } finally { controller.abort(); await operation.catch(() => {}); await p.close(); await observer.close({ timeout: 0 }); }
  }, 10000);
});
