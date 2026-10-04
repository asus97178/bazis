import { resolve, sep } from "node:path";
import { startHostedServices, stopHostedServices } from "@osnova/core/di";
import { ConsoleLogger, Osnova, memorySource } from "@osnova/core/kernel";
import { HttpContext, HttpError, PRINCIPAL_STATE_KEY } from "@osnova/core/http";
import { ormModule, postgres } from "@osnova/core/orm";
import { registerOsnovaGeneratedRuntime } from "../../src/generated/osnv/runtime";
import { TokenKind } from "../../src/app/modules/auth/tokenKinds";
import { DataManagerRecordsModule } from "../../src/app/modules/datamanager_modules/records_module/DataManagerRecords.module";
import { DataManagerFieldsModule } from "../../src/app/modules/datamanager_modules/fields_module/DataManagerFields.module";
import { DataController } from "../../src/app/modules/datamanager_modules/records_module/http/DataController";
import { TableService } from "../../src/app/modules/datamanager_modules/tables_module/services/TableService";

if (process.env.OSNV_CLIENT_RECOVERY !== "owned-disposable-v1") throw new Error("Owned disposable gate required");
const url = new URL(process.env.OSNV_PG_URL!);
if (url.hostname !== "127.0.0.1" || !/^\/recordclient_[a-f0-9]+$/.test(url.pathname)) throw new Error("Only owned local fixture is allowed");
const dist = resolve(process.env.OSNV_CLIENT_DIST!);
const provider = postgres({ options: { url: url.toString(), max: 6 }, operationTimeoutMs: 3000 });
await registerOsnovaGeneratedRuntime();
const kernel = await Osnova.createBuilder({ imports: [ormModule({ provider, healthCheck: false }), DataManagerFieldsModule, DataManagerRecordsModule] })
  .useEnvironment("test", false).addConfigSource(memorySource({})).useLogger(new ConsoleLogger({ minLevel: "error" }))
  .useStartupReport(false).useSignals([]).useUnhandledErrorPolicy("none").build();
await startHostedServices(kernel.container);
const scope = kernel.container.createScope();
try {
  for (const name of ["ClientRecords", "OtherRecords"]) await scope.resolve(TableService).createTable({ name, tableName: name.toLowerCase(), fields: [
    { name: "id", type: "int", isKey: true }, { name: "title", type: "string", required: true }, { name: "value", type: "int" },
  ] });
} finally { await scope.dispose(); }
await provider.execute("CREATE TABLE client_audit (operation text NOT NULL, table_name text NOT NULL)", []);
await provider.execute("CREATE FUNCTION client_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO client_audit VALUES (TG_OP,TG_TABLE_NAME); RETURN NULL; END $$", []);
for (const table of ["clientrecords", "otherrecords"]) await provider.execute(`CREATE TRIGGER client_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION client_audit_fn()`, []);

let fault = "none";
const requests: object[] = [];
const faults: object[] = [];
async function status() {
  return { records: await provider.query("SELECT id,title,value FROM clientrecords ORDER BY id", []),
    otherRecords: await provider.query("SELECT id,title,value FROM otherrecords ORDER BY id", []),
    mutations: await provider.query("SELECT operation,table_name,count(*)::int AS count FROM client_audit GROUP BY operation,table_name ORDER BY table_name,operation", []),
    receipts: (await provider.query("SELECT count(*)::int AS n FROM dm_record_write_receipts", []))[0]!.n,
    requests, faults };
}
const wireHeaders = { "content-type": "application/json", "x-osnova-redirect": "manual-v1", "cache-control": "no-store" };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: wireHeaders }); }
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/status") return json(await status());
  if (path === "/fixture/fault" && request.method === "POST") {
    const body = await request.json() as { fault: string };
    if (!["none", "unknown", "drop", "validation"].includes(body.fault)) return json({}, 400);
    fault = body.fault; return json({ fault });
  }
  if (path === "/fixture/finish" && request.method === "POST") {
    await Bun.write(process.env.OSNV_CLIENT_RESULT!, JSON.stringify(await status(), null, 2));
    setTimeout(async () => { server.stop(true); await stopHostedServices(kernel.container); await kernel.container.dispose(); await provider.close(); process.exit(0); }, 100);
    return json({ saved: true });
  }
  const match = /^\/api\/data\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (match) {
    const actor = /^Bearer fixture-(admin-[12])$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!actor) return json({ error: "Unauthorized" }, 401);
    const method = request.method, write = method !== "GET", mode = write ? fault : "none";
    if (write) { fault = "none"; requests.push({ method, path, actor, key: request.headers.get("idempotency-key"), body: await request.clone().text() }); }
    if (mode === "validation") return json({ error: "Planned validation failure" }, 400);
    const scoped = kernel.container.createScope();
    try {
      const ctx = new HttpContext(request, new URL(request.url), { table: decodeURIComponent(match[1]!), ...(match[2] ? { id: decodeURIComponent(match[2]) } : {}) }, scoped);
      ctx.state.set(PRINCIPAL_STATE_KEY, { kind: TokenKind.Admin, subject: actor, claims: {} });
      const controller = scoped.resolve(DataController);
      const result = method === "POST" ? await controller.create(ctx) : method === "PUT" ? await controller.update(ctx)
        : method === "DELETE" ? await controller.remove(ctx) : match[2] ? await controller.getById(ctx) : await controller.list(ctx);
      if (mode === "unknown" || mode === "drop") {
        faults.push({ mode, method, key: request.headers.get("idempotency-key"), committedReceipts: (await provider.query("SELECT count(*)::int AS n FROM dm_record_write_receipts", []))[0]!.n });
        if (mode === "unknown") return json({ error: "Result unavailable after commit", details: { code: "ORM_TRANSACTION_OUTCOME_UNKNOWN", outcome: "unknown", retry: "same-key" } }, 503);
        return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"id":')); setTimeout(() => stream.error(new Error("Planned response interruption after COMMIT")), 30); } }), { headers: wireHeaders });
      }
      if (write) {
        const http = result as { status: number; body?: unknown; headers?: Record<string, string> };
        return new Response(http.body === undefined || http.status === 204 ? null : JSON.stringify(http.body), { status: http.status, headers: { ...wireHeaders, ...http.headers } });
      }
      return json(result);
    } catch (error) {
      return error instanceof HttpError ? json({ error: error.message, details: error.details }, error.status) : json({ error: error instanceof Error ? error.message : String(error) }, 500);
    } finally { await scoped.dispose(); }
  }
  const file = resolve(dist, path === "/" ? "test/record-recovery/index.html" : `.${path}`);
  if (!file.startsWith(dist + sep) || !await Bun.file(file).exists()) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(file));
} });
console.log(JSON.stringify({ event: "ready", url: server.url.toString(), version: Bun.version, revision: Bun.revision }));
