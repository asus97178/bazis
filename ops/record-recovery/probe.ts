import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { startHostedServices, stopHostedServices } from "@osnova/core/di";
import { ConsoleLogger, Osnova, memorySource } from "@osnova/core/kernel";
import { HttpContext, HttpError, PRINCIPAL_STATE_KEY } from "@osnova/core/http";
import { PostgresProvider, isUnknownTransactionOutcome, ormModule } from "@osnova/core/orm";
import { registerOsnovaGeneratedRuntime } from "../../src/generated/osnova/runtime";
import { TokenKind } from "../../src/app/modules/auth/tokenKinds";
import { DataManagerFieldsModule } from "../../src/app/modules/datamanager_modules/fields_module/DataManagerFields.module";
import { DataManagerRecordsModule } from "../../src/app/modules/datamanager_modules/records_module/DataManagerRecords.module";
import { DataController } from "../../src/app/modules/datamanager_modules/records_module/http/DataController";
import { RecordWriteDbContext } from "../../src/app/modules/datamanager_modules/records_module/model/RecordWriteDbContext";
import { TableService } from "../../src/app/modules/datamanager_modules/tables_module/services/TableService";

const emit = (value: unknown) => console.log(JSON.stringify(value));
let assertions = 0;
function check(value: unknown, message: string): asserts value { assertions++; if (!value) throw new Error(message); }
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
check(process.env.OSNOVA_RECORD_RECOVERY === "owned-disposable-v1", "Owned fixture gate required");
const url = new URL(process.env.OSNOVA_PG_URL!);
check(url.hostname === "127.0.0.1" && /^\/recovery_[a-f0-9]+_(darwin|linux)$/.test(url.pathname), "Only an owned loopback database is allowed");
check(Bun.version === "1.4.0" && Bun.revision === "34cbb9a40b4bd1bd767d134a7065e66c2432a676", "Runtime mismatch");
const ca = readFileSync(process.env.OSNOVA_RECORD_CA!, "utf8");
const options = (address = url.toString(), isolation = "read committed") => ({ url: address, max: 6,
  tls: { ca, serverName: "localhost", rejectUnauthorized: true },
  connectionTimeout: 3, idleTimeout: 5, connection: { default_transaction_isolation: isolation,
    statement_timeout: "5000", idle_in_transaction_session_timeout: "5000", application_name: "record_recovery_qualification" } });
const observer = new SQL(options());
await registerOsnovaGeneratedRuntime();

async function peer(address?: string, isolation?: string, timeoutMs = 3000) {
  const provider = new PostgresProvider({ options: options(address, isolation), operationTimeoutMs: timeoutMs, cancellationTimeoutMs: 1000 });
  const kernel = await Osnova.createBuilder({ imports: [ormModule({ provider, healthCheck: false }), DataManagerFieldsModule, DataManagerRecordsModule] })
    .useEnvironment("test", false).addConfigSource(memorySource({})).useLogger(new ConsoleLogger({ minLevel: "error" }))
    .useStartupReport(false).useSignals([]).useUnhandledErrorPolicy("none").build();
  try { await startHostedServices(kernel.container); }
  catch (error) { await kernel.container.dispose(); await provider.close(); throw error; }
  return { provider, container: kernel.container, async close() {
    try { await stopHostedServices(kernel.container); await kernel.container.dispose(); } finally { await provider.close(); }
  } };
}
type Peer = Awaited<ReturnType<typeof peer>>;
async function invoke(app: Peer, method: "POST" | "PUT" | "DELETE", key: string | undefined, body?: object, id?: string,
  subject = "admin-1", setup?: (scope: ReturnType<Peer["container"]["createScope"]>) => void) {
  const scope = app.container.createScope();
  try {
    setup?.(scope);
    const path = `http://localhost/api/data/RecoveryRecords${id === undefined ? "" : `/${id}`}`;
    const request = new Request(path, { method, headers: { "content-type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
      ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }) });
    const ctx = new HttpContext(request, new URL(path), { table: "RecoveryRecords", ...(id === undefined ? {} : { id }) }, scope);
    ctx.state.set(PRINCIPAL_STATE_KEY, { kind: TokenKind.Admin, subject, claims: {} });
    const controller = scope.resolve(DataController);
    return await controller[method === "POST" ? "create" : method === "PUT" ? "update" : "remove"](ctx);
  } finally { await scope.dispose(); }
}
const rows = async (title: string) => (await observer.unsafe('SELECT id, title, value FROM recovery_rows WHERE title=$1 ORDER BY id', [title]));
const count = async (table: string) => Number((await observer.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
const createdId = (result: unknown) => String((result as { body: { id: unknown } }).body.id);

async function relay() {
  let frozen = false; const sockets = new Set<Socket>();
  const server = createServer(front => {
    const back = connect({ host: url.hostname, port: Number(url.port) }); sockets.add(front); sockets.add(back);
    front.on("data", bytes => back.write(bytes)); back.on("data", bytes => { if (!frozen) front.write(bytes); });
    front.on("error", () => {}); back.on("error", () => {});
    front.on("close", () => { sockets.delete(front); if (!frozen) back.destroy(); });
    back.on("close", () => { sockets.delete(back); if (!frozen) front.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); check(address && typeof address !== "string", "Relay port missing");
  const value = new URL(url); value.port = String(address.port);
  const disconnect = () => { frozen = false; for (const socket of sockets) socket.destroy(); };
  return { url: value.toString(), freeze() { frozen = true; }, disconnect, close() { disconnect(); server.close(); } };
}

async function lostCommit(clean: Peer, commit: boolean) {
  const auditBefore = await count("recovery_audit");
  const proxy = await relay(), fault = await peer(proxy.url), title = commit ? "commit-response-lost" : "commit-not-sent";
  const root = (fault.provider as unknown as { sql: SQL }).sql, reserve = root.reserve.bind(root);
  let fired = false, observed = false, dispatched = 0, observation: Promise<void> | undefined, oldContext: RecordWriteDbContext | undefined;
  root.reserve = (async (...args: Parameters<typeof reserve>) => {
    const session = await reserve(...args), unsafe = session.unsafe.bind(session);
    await unsafe("BEGIN"); await unsafe("COMMIT"); // Parse/bind before dropping encrypted responses.
    return { ...session, unsafe(text: string, params?: readonly unknown[]) {
      if (text === "COMMIT" && !fired) {
        fired = true;
        if (!commit) { proxy.disconnect(); return Promise.reject(new Error("Fixture dropped connection before COMMIT dispatch")); }
        dispatched++; proxy.freeze();
        observation = (async () => {
          const until = performance.now() + 2000;
          while (performance.now() < until) { if ((await rows(title)).length === 1) { observed = true; break; } await sleep(3); }
          proxy.disconnect();
        })();
      }
      return unsafe(text, params as never);
    }, release: session.release.bind(session), close: session.close.bind(session) } as never;
  }) as typeof root.reserve;
  try {
    const initial = await outcome(invoke(fault, "POST", title, { title, value: 9 }, undefined, "admin-1", scope => { oldContext = scope.resolve(RecordWriteDbContext); }));
    await observation;
    check(!initial.ok && initial.error instanceof HttpError && initial.error.status === 503
      && (initial.error.details as { retry?: string })?.retry === "same-key", "Lost outcome must request same-key recovery");
    const fenced = await outcome(oldContext!.saveChanges());
    check(!fenced.ok && isUnknownTransactionOutcome(fenced.error), "Unknown context must be fenced");
    if (commit) check(observed && dispatched === 1, "Server commit must be visible before disconnect");
    const recovered = await invoke(clean, "POST", title, { title, value: 9 });
    const persisted = await rows(title);
    check(persisted.length === 1 && String(persisted[0].id) === createdId(recovered), "Recovery must produce exactly one row");
    check(await count("recovery_audit") === auditBefore + 1, "Recovery performed more than one durable mutation");
    emit({ event: "case", name: title, status: "PASS", commitDispatched: dispatched, serverCommitObservedBeforeDisconnect: observed, persistedRows: persisted.length });
  } finally { proxy.close(); await fault.close(); }
}

async function contended(clean: Peer) {
  const key = "contended", id = createHash("sha256").update(JSON.stringify(["dm-record-write-v1", "admin", "admin-1", key])).digest("hex");
  const lock = BigInt.asIntN(64, BigInt(`0x${id.slice(0, 16)}`)).toString();
  const holder = await observer.reserve();
  const waiter = await peer(undefined, undefined, 200);
  let blockedObserved = false;
  try {
    await holder.unsafe("BEGIN");
    await holder.unsafe("SELECT pg_advisory_xact_lock($1::bigint)", [lock]);
    const start = performance.now();
    const pending = outcome(invoke(waiter, "POST", key, { title: key, value: 1 }));
    const watch = (async () => {
      const until = performance.now() + 800;
      while (performance.now() < until) {
        const active = await observer.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'");
        if (active[0].n > 0) { blockedObserved = true; return; }
        await sleep(3);
      }
    })();
    const result = await pending;
    await watch;
    const elapsedMs = performance.now() - start;
    check(blockedObserved, "The server must acknowledge the waiting lock");
    check(!result.ok && elapsedMs < 1800, "Contended request did not respect the bounded budget");
    check((await rows(key)).length === 0, "Timed-out waiter wrote a record");
    await holder.unsafe("ROLLBACK");
    const recovered = await invoke(clean, "POST", key, { title: key, value: 1 });
    check((await rows(key)).length === 1 && createdId(recovered) === String((await rows(key))[0].id), "Retry after lock timeout failed");
    emit({ event: "case", name: "contended-key-timeout", status: "PASS", blockedObserved, elapsedMs, operationTimeoutMs: 200 });
  } finally { try { await holder.unsafe("ROLLBACK"); } finally { holder.release(); await waiter.close(); } }
}

async function exercise() {
  const app = await peer(); let other: Peer | undefined;
  try {
    const scope = app.container.createScope();
    try { await scope.resolve(TableService).createTable({ name: "RecoveryRecords", tableName: "recovery_rows", fields: [
      { name: "id", type: "int", isKey: true }, { name: "title", type: "string", required: true }, { name: "value", type: "int", required: true },
    ] }); } finally { await scope.dispose(); }
    await observer.unsafe("CREATE TABLE recovery_audit (operation text NOT NULL)");
    await observer.unsafe("CREATE FUNCTION recovery_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO recovery_audit VALUES (TG_OP); RETURN NULL; END $$");
    await observer.unsafe("CREATE TRIGGER recovery_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON recovery_rows FOR EACH ROW EXECUTE FUNCTION recovery_audit_fn()");
    other = await peer();
    const tls = await observer.unsafe("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"); check(tls[0].ssl === true, "TLS required");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => invoke(i % 2 ? other! : app, "POST", "parallel", i % 2 ? { value: 1, title: "parallel" } : { title: "parallel", value: 1 })));
    const id = createdId(results[0]);
    check(results.every(result => createdId(result) === id), "Concurrent keys returned different IDs");
    check((await rows("parallel")).length === 1 && await count("recovery_audit") === 1, "Concurrent write duplicated");
    check(await count("dm_record_write_receipts") === 1, "Receipt duplicated");
    for (const request of [() => invoke(other!, "POST", "parallel", { title: "changed", value: 1 }), () => invoke(other!, "DELETE", "parallel", undefined, id)]) {
      const conflict = await outcome(request());
      check(!conflict.ok && conflict.error.status === 409 && conflict.error.details.code === "DM_IDEMPOTENCY_CONFLICT", "Key conflict must reject before mutation");
    }
    await invoke(other, "POST", "parallel", { title: "other-admin", value: 1 }, undefined, "admin-2");
    check((await rows("other-admin")).length === 1, "Admin key namespaces collided");
    await invoke(app, "PUT", "update", { title: "updated" }, id);
    await invoke(app, "PUT", undefined, { title: "later" }, id);
    const auditAfterUpdates = await count("recovery_audit");
    await invoke(other, "PUT", "update", { title: "updated" }, id);
    check((await rows("later")).length === 1 && await count("recovery_audit") === auditAfterUpdates, "Repeated PUT mutated newer data");
    await invoke(app, "DELETE", "delete", undefined, id);
    const afterDelete = await count("recovery_audit");
    await invoke(other, "DELETE", "delete", undefined, id);
    check(await count("recovery_audit") === afterDelete, "Repeated DELETE mutated twice");
    for (let i = 0; i < 2; i++) {
      const missing = await outcome(invoke(app, "PUT", "missing", { title: "missing" }, "999999"));
      check(!missing.ok && missing.error.status === 404, "Missing-row outcome changed on repeat");
    }
    const beforeRollback = await count("recovery_audit");
    const rolledBack = await outcome(invoke(app, "POST", "rollback", { title: "rollback", value: 2 }, undefined, "admin-1", scope => {
      scope.resolve(RecordWriteDbContext).saveChanges = async () => { throw new Error("Planned receipt failure after real record INSERT"); };
    }));
    check(!rolledBack.ok && (await rows("rollback")).length === 0 && await count("recovery_audit") === beforeRollback, "Record escaped receipt rollback");
    await invoke(other, "POST", "rollback", { title: "rollback", value: 2 });
    check((await rows("rollback")).length === 1, "Retry after rollback failed");
    const invalid = await outcome(invoke(app, "POST", "validation", { value: 4 }));
    check(!invalid.ok, "Missing required field accepted");
    await invoke(app, "POST", "validation", { title: "valid-after-rejection", value: 4 });
    const repeatable = await peer(undefined, "repeatable read");
    try {
      const rejected = await outcome(invoke(repeatable, "POST", "isolation", { title: "wrong-isolation", value: 0 }));
      check(!rejected.ok && (await rows("wrong-isolation")).length === 0, "Unsupported isolation admitted");
    } finally { await repeatable.close(); }
    emit({ event: "case", name: "crud-concurrency-rollback", status: "PASS", concurrentRequests: 12, independentProviders: 2 });
    await lostCommit(other, true);
    await lostCommit(other, false);
    await contended(other);
    // Repeat committed results after the peer's in-memory caches are discarded.
    const sessions = await observer.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'");
    check(sessions[0].n === 0, "Leaked transaction");
  } finally { await other?.close(); await app.close(); }
}

async function restart() {
  const app = await peer();
  try {
    const before = await count("recovery_audit");
    for (const title of ["commit-response-lost", "commit-not-sent"]) {
      const result = await invoke(app, "POST", title, { title, value: 9 });
      check(createdId(result) === String((await rows(title))[0].id), "Restart lost receipt");
    }
    check(await count("recovery_audit") === before, "Restart replay mutated rows");
  } finally { await app.close(); }
  emit({ event: "case", name: "fresh-process-replay", status: "PASS" });
}

try {
  const mode = Bun.argv[2];
  if (mode === "exercise") await exercise(); else if (mode === "restart") await restart(); else throw new Error("Unknown probe mode");
  emit({ event: "result", mode, status: "PASS", assertions, version: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch });
} catch (error) {
  emit({ event: "result", status: "FAIL", assertions, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exitCode = 1;
} finally { await observer.close({ timeout: 0 }); }
