import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { AccessPolicy, type AccessSubject, type Grants, type Scope, type ScopePrincipals } from "@/core/access";
import { TOOL_EXECUTION_OPTIONS, Tool, ToolError, ToolRunner, type AgentToolExecutionContext } from "@/core/agent";
import { Module, singleton } from "@/core/di";
import { DI } from "@/core/di/lowLevel";
import type { AuthorizeContext } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { SecretStore, StandardToolsModule } from "@/core/tools";
import { defineProcess, IWorkflowDefinitions, WorkflowModule, type CodeProcess, type InstanceDetails } from "@/core/workflow";
import { dropWorkflowTables, testWorkflow, type TestWorkflow } from "@/core/workflow/testing";
import { postgres } from "@/library/orm";
import type { ProcessDocument, ProcessFlow, VariableSpec } from "@/library/workflow";

/**
 * Stage 6 of WORKFLOW-002 on PostgreSQL: `$secrets` and `http.request` in a process.
 * Runs only against a throwaway database whose name starts with `bazis_wf_`: set
 * `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const LONG = "long-secret-value-0123456789";
const SHORT = "s3cret";
const received: Record<string, unknown>[] = [];
const askedFor: { name: string; partition: string | null }[] = [];

@Tool({ name: "secrets.echo", description: "Says back what it got.", sideEffect: "write", callers: ["workflow"] })
class EchoTool {
  execute(input: Record<string, unknown>, _context: AgentToolExecutionContext): Record<string, unknown> {
    received.push(input);
    return { echoed: input, [SHORT]: "as a key" };
  }
}

@Tool({ name: "secrets.fail", description: "Fails telling what it got.", sideEffect: "write", callers: ["workflow"] })
class FailTool {
  execute(input: Record<string, unknown>): never {
    throw new ToolError(`could not use ${String(input.token)}`, { reason: "refused" });
  }
}

class TestSecrets extends SecretStore {
  get(name: string, context: { partition: string | null }): string | undefined {
    askedFor.push({ name, partition: context.partition });
    return ({ LONG, SHORT } as Record<string, string>)[name];
  }
}

class OpenPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): AccessSubject {
    return { sub: ctx.header("x-user") ?? "admin" };
  }

  grants(): Grants {
    return "all";
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [subject.sub];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    return scopes.map((scope) => ({ scope, principals: [`user:${subject.sub}`] }));
  }
}

const out: VariableSpec[] = [{ name: "url", type: "string", direction: "in" }, { name: "result", type: "object", direction: "out" }];

function line(key: string, steps: Record<string, unknown>, extra: { settings?: ProcessDocument["settings"]; variables?: VariableSpec[] } = {}): CodeProcess {
  const ids = ["Start", ...Object.keys(steps), "End"];
  const flows: Record<string, ProcessFlow> = Object.fromEntries(ids.slice(1).map((id, index) => [`f${index}`, { source: ids[index]!, target: id }]));
  return defineProcess({ key, title: key, document: { schemaVersion: "bazis.workflow/v2", nodes: { Start: { kind: "manualStart", title: "Start" }, ...steps, End: { kind: "end", title: "End" } } as unknown as ProcessDocument["nodes"], flows, ...extra } });
}

const PROCESSES: CodeProcess[] = [
  line("echo", { Echo: { kind: "serviceTask", title: "Echo", config: { tool: "secrets.echo", input: { long: "$secrets.LONG", short: "$secrets.SHORT", header: { op: "concat", args: ["Bearer ", { path: "$secrets.LONG" }] }, plain: "visible" }, saveTo: "result" } } }, { variables: [{ name: "result", type: "object", direction: "out" }], settings: { log: { toolPayloads: true } } }),
  line("fails", { Fail: { kind: "serviceTask", title: "Fail", config: { tool: "secrets.fail", input: { token: "$secrets.SHORT" } } } }),
  line("no-secret", { Echo: { kind: "serviceTask", title: "Echo", config: { tool: "secrets.echo", input: { token: "$secrets.NOPE" } } } }),
  line("calls-out", { Call: { kind: "serviceTask", title: "Call", config: { tool: "http.request", input: { url: "$input.url", auth: { type: "bearer", token: "$secrets.LONG" } }, saveTo: "result" } } }, { variables: out, settings: { log: { toolPayloads: true } } }),
  line("writes-out", { Call: { kind: "serviceTask", title: "Call", config: { tool: "http.request", input: { url: "$input.url", method: "POST", body: { a: 1 } }, saveTo: "result" } } }, { variables: out }),
];

let wf: TestWorkflow;
let server: ReturnType<typeof Bun.serve>;
const hits: { method: string; authorization: string | null }[] = [];

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfsecrets", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule, StandardToolsModule],
    tools: [EchoTool, FailTool],
    processes: PROCESSES,
    providers: [
      singleton(AccessPolicy, OpenPolicy),
      singleton(SecretStore, TestSecrets),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
    ],
  })
  class AppModule {}
  return AppModule;
}

beforeAll(async () => {
  if (!enabled) return;
  // The database is a throwaway one: its name was checked above.
  await dropWorkflowTables(url!, { force: true });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      hits.push({ method: request.method, authorization: request.headers.get("authorization") });
      return Response.json({ echo: request.headers.get("authorization") });
    },
  });
  process.env.BAZIS_TOOLS__HTTP__ALLOW = `127.0.0.1:${server.port}`;
  process.env.BAZIS_TOOLS__HTTP__ALLOWPRIVATENETWORKS = "true";
  wf = await testWorkflow(root(url!), { now: "2026-11-02T09:00:00Z" });
});

afterAll(async () => {
  if (!enabled) return;
  delete process.env.BAZIS_TOOLS__HTTP__ALLOW;
  delete process.env.BAZIS_TOOLS__HTTP__ALLOWPRIVATENETWORKS;
  server.stop(true);
  await wf.stop();
});

/** Everything the store and the API keep of an instance, as text. */
async function everything(instance: InstanceDetails): Promise<string> {
  const scope = wf.app.container.createScope();
  try {
    const { RuntimeDbContext } = await import("@/core/workflow/runtime_module/model/Runtime.dbContext");
    const db = scope.resolve(RuntimeDbContext);
    const [row, tokens, jobs, history] = await Promise.all([
      db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(instance.id)),
      db.tokens.asNoTracking().where((t) => t.instanceId.eq(instance.id)).toList(),
      db.jobs.asNoTracking().where((j) => j.instanceId.eq(instance.id)).toList(),
      db.history.asNoTracking().where((h) => h.instanceId.eq(instance.id)).toList(),
    ]);
    return JSON.stringify({ row, tokens, jobs, history, instance });
  } finally {
    await scope.dispose();
  }
}

test.skipIf(!enabled)("a Tool gets the values; the process and its history keep only the name", async () => {
  received.length = 0;
  askedFor.length = 0;
  const started = await wf.start("echo", { partition: "shop-1" });
  await wf.drain();
  const done = await wf.instance(started.id);
  expect(done.status).toBe("completed");
  expect(received).toEqual([{ long: LONG, short: SHORT, header: `Bearer ${LONG}`, plain: "visible" }]);
  expect(askedFor).toContainEqual({ name: "LONG", partition: "shop-1" });
  // What the Tool said back is cut too, a key among them, a short value too.
  expect(done.output).toEqual({ result: { echoed: { long: "***", short: "***", header: "Bearer ***", plain: "visible" }, "***": "as a key" } });
  const kept = await everything(done);
  expect(kept).not.toContain(LONG);
  expect(kept).not.toContain(SHORT);
  expect(kept).toContain("visible");
  const payload = (await wf.history(done.id)).find((entry) => entry.type === "tool")?.data;
  expect(payload?.input).toEqual({ long: "***", short: "***", header: "Bearer ***", plain: "visible" });
});

test.skipIf(!enabled)("an error that names a secret names it no more", async () => {
  const started = await wf.start("fails");
  await wf.drain();
  const failed = await wf.instance(started.id);
  expect(failed.status).toBe("failed");
  expect(failed.error?.message).toBe("could not use ***");
  expect(await everything(failed)).not.toContain(SHORT);
});

test.skipIf(!enabled)("a secret that does not exist fails the step by its name", async () => {
  received.length = 0;
  const started = await wf.start("no-secret");
  await wf.drain();
  const failed = await wf.instance(started.id);
  expect(failed).toMatchObject({ status: "failed", failedNode: "Echo", error: { code: "secret_not_found", message: "There is no secret NOPE" } });
  expect(received).toEqual([]);
});

test.skipIf(!enabled)("http.request in a process: the secret goes in the header and stays out of the answer", async () => {
  hits.length = 0;
  const started = await wf.start("calls-out", { input: { url: `http://127.0.0.1:${server.port}/x` } });
  await wf.drain();
  const done = await wf.instance(started.id);
  expect(done.status).toBe("completed");
  expect(hits).toEqual([{ method: "GET", authorization: `Bearer ${LONG}` }]);
  expect((done.output?.result as { status: number; body: unknown })).toMatchObject({ status: 200, body: { echo: "Bearer ***" } });
  expect(await everything(done)).not.toContain(LONG);
});

test.skipIf(!enabled)("a trial reads over HTTP and writes nothing", async () => {
  hits.length = 0;
  const reads = await wf.start("calls-out", { test: true, input: { url: `http://127.0.0.1:${server.port}/x` } });
  const writes = await wf.start("writes-out", { test: true, input: { url: `http://127.0.0.1:${server.port}/x` } });
  await wf.drain();
  expect((await wf.instance(reads.id)).status).toBe("completed");
  expect((await wf.instance(writes.id)).output).toEqual({ result: { dryRun: true } });
  expect(hits.map((hit) => hit.method)).toEqual(["GET"]);
});

test.skipIf(!enabled)("a host not on the list fails the step with its reason", async () => {
  const started = await wf.start("calls-out", { input: { url: "https://example.com/" } });
  await wf.drain();
  const failed = await wf.instance(started.id);
  expect(failed).toMatchObject({ status: "failed", failedNode: "Call" });
  expect(failed.error?.message).toContain("tools.http.allow");
});

test.skipIf(!enabled)("the palette shows http.request; a document may name secrets only in a Tool input", async () => {
  const scope = wf.app.container.createScope();
  try {
    const definitions = scope.resolve(IWorkflowDefinitions);
    const tool = definitions.palette().tools.find((item) => item.name === "http.request");
    expect(tool).toMatchObject({ sideEffect: "external", dryRun: "supported" });
    expect(wf.app.container.resolve(ToolRunner).as("workflow").describe("http.request")?.input?.kind).toBe("json-schema");
    const issues = await definitions.validate({
      schemaVersion: "bazis.workflow/v2",
      nodes: { Start: { kind: "manualStart", title: "Start" }, Keep: { kind: "assign", title: "Keep", config: { assignments: [{ var: "x", value: { path: "$secrets.LONG" } }] } }, End: { kind: "end", title: "End" } },
      flows: { a: { source: "Start", target: "Keep" }, b: { source: "Keep", target: "End" } },
      variables: [{ name: "x", type: "string", direction: "local" }],
    });
    expect(issues.some((issue) => issue.message.includes("only in the input of a Tool"))).toBe(true);
  } finally {
    await scope.dispose();
  }
});
