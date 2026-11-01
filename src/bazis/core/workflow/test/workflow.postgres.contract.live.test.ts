import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { AccessPolicy } from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { TOOL_EXECUTION_OPTIONS, Tool, type AgentToolExecutionContext } from "@/core/agent";
import { DI, Module, singleton, singletonValue } from "@/core/di";
import { PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, OnEvent, secret, withEventSubscribers, type EventToken } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp, type TestApp } from "@/core/testing";
import {
  defineProcess,
  IWorkflowDefinitions,
  WORKFLOW_INSTANCE_CANCELLED,
  WORKFLOW_INSTANCE_RETRIED,
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_PROCESS_CHANGED,
  WORKFLOW_TASK_COMPLETED,
  WorkflowModule,
  type WorkflowInstanceCancelled,
  type WorkflowInstanceRetried,
  type WorkflowInstanceStarted,
  type WorkflowProcessChanged,
  type WorkflowTaskCompleted,
} from "@/core/workflow";
import { postgres } from "@/library/orm";
import type { ProcessDocument } from "@/library/workflow";

/**
 * The contract of WORKFLOW-002 stage 1 on PostgreSQL: lists in the style of
 * JSON:API, the draft lock, the audit events and what a Tool learns from its
 * context. Runs only against a throwaway database whose name starts with
 * `bazis_wf_`: set `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const everything = {
  "workflow.processes.read": "all",
  "workflow.processes.manage": "all",
  "workflow.processes.publish": "all",
  "workflow.instances.start": "all",
  "workflow.instances.read": "all",
  "workflow.instances.manage": "all",
  "workflow.events.emit": "all",
  "workflow.tasks.work": "all",
} as const;
const policy = new StaticAccessPolicy({ grants: { admin: everything }, principals: { admin: ["role:manager"] } });

const signedIn: AuthorizeCheck = (ctx) => {
  const subject = ctx.header("x-user");
  if (subject === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject });
  return true;
};

const seen: { name: string; payload: Record<string, unknown> }[] = [];
const contexts: AgentToolExecutionContext[] = [];
let failOnce = false;

class Audit {
  private keep(event: EventToken<unknown>, payload: object): void {
    seen.push({ name: event.name, payload: payload as Record<string, unknown> });
  }
  @OnEvent(WORKFLOW_PROCESS_CHANGED) changed(event: WorkflowProcessChanged): void { this.keep(WORKFLOW_PROCESS_CHANGED as EventToken<unknown>, event); }
  @OnEvent(WORKFLOW_INSTANCE_STARTED) started(event: WorkflowInstanceStarted): void { this.keep(WORKFLOW_INSTANCE_STARTED as EventToken<unknown>, event); }
  @OnEvent(WORKFLOW_INSTANCE_CANCELLED) cancelled(event: WorkflowInstanceCancelled): void { this.keep(WORKFLOW_INSTANCE_CANCELLED as EventToken<unknown>, event); }
  @OnEvent(WORKFLOW_INSTANCE_RETRIED) retried(event: WorkflowInstanceRetried): void { this.keep(WORKFLOW_INSTANCE_RETRIED as EventToken<unknown>, event); }
  @OnEvent(WORKFLOW_TASK_COMPLETED) completed(event: WorkflowTaskCompleted): void { this.keep(WORKFLOW_TASK_COMPLETED as EventToken<unknown>, event); }
}

@Tool({ name: "contract.note", description: "Keeps its context.", sideEffect: "write", dryRun: "supported", callers: ["workflow"] })
class NoteTool {
  execute(_input: unknown, context: AgentToolExecutionContext): { ok: true } {
    if (failOnce) {
      failOnce = false;
      throw new Error("not this time");
    }
    contexts.push(context);
    return { ok: true };
  }
}

const TASK_DOCUMENT: ProcessDocument = {
  schemaVersion: "bazis.workflow/v2",
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Approve: { kind: "userTask", title: "Approve", config: { assignee: { role: "manager" } } },
    End: { kind: "end", title: "End" },
  },
  flows: { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" } },
};

const TOOL_DOCUMENT = {
  schemaVersion: "bazis.workflow/v2",
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Note: { kind: "serviceTask", title: "Note", config: { tool: "contract.note", input: {} } },
    End: { kind: "end", title: "End" },
  },
  flows: { a: { source: "Start", target: "Note" }, b: { source: "Note", target: "End" } },
};

const fromCode = defineProcess({ key: "from-code", title: "From code", document: TASK_DOCUMENT });

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfcontract", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    tools: [NoteTool],
    processes: [fromCode],
    providers: [
      singletonValue(AccessPolicy, policy),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
      singleton(Audit),
      ...withEventSubscribers(Audit),
    ],
  })
  class AppModule {}
  return AppModule;
}

let app: TestApp;

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-user": "admin", "user-agent": "contract-test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function published(key: string, document: unknown): Promise<void> {
  expect((await call("POST", "/workflow/processes", { key, title: `Process ${key}` })).status).toBe(201);
  expect((await call("PUT", `/workflow/processes/${key}/draft`, { document })).status).toBe(200);
  expect((await call("POST", `/workflow/processes/${key}/publish`)).status).toBe(201);
}

/** Waits for the worker. */
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(25);
  }
  throw new Error("nothing came");
}

const eventsOf = (name: string) => seen.filter((event) => event.name === name).map((event) => event.payload);

beforeAll(async () => {
  if (!enabled) return;
  const sql = postgres({ url });
  try {
    const tables = (await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'bazis\\_wf%'", [])) as { tablename: string }[];
    if (tables.length > 0) await sql.execute(`DROP TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`, []);
    await sql.execute(`DO $$ BEGIN IF to_regclass('public.__bazis_orm_owned_stores_v1') IS NOT NULL THEN DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key LIKE 'bazis.workflow.%'; END IF; END $$`, []);
  } finally {
    await sql.close();
  }
  app = await startTestApp(root(url!), { http: { authorize: signedIn } });
});

afterAll(async () => {
  await app?.stop();
});

test.skipIf(!enabled)("a process declared in code reaches the audit when it is published at start", () => {
  const code = { kind: "system", id: "code" };
  expect(eventsOf("workflow.process-changed")).toEqual([
    { change: "created", key: "from-code", version: null, actor: code, request: null },
    { change: "published", key: "from-code", version: 1, actor: code, request: null },
  ]);
});

test.skipIf(!enabled)("process lists: filters, sort and pages; what is not listed is 400", async () => {
  for (const key of ["list-a", "list-b", "list-c"]) await published(key, TASK_DOCUMENT);
  expect((await call("PATCH", "/workflow/processes/list-c", { archived: true })).status).toBe(200);

  const page = await call("GET", "/workflow/processes?filter[search]=list-&page[size]=2&page[number]=1&sort=-key");
  expect(page.status).toBe(200);
  expect(page.body.data.map((p: { key: string }) => p.key)).toEqual(["list-c", "list-b"]);
  expect(page.body.meta).toEqual({ total: 3, page: 1, size: 2, pageCount: 2 });
  expect(page.body.links.next).toContain("page%5Bnumber%5D=2");

  const second = await call("GET", "/workflow/processes?filter[search]=list-&page[size]=2&page[number]=2&sort=-key");
  expect(second.body.data.map((p: { key: string }) => p.key)).toEqual(["list-a"]);

  const active = await call("GET", "/workflow/processes?filter[search]=list-&filter[archived]=false");
  expect(active.body.data.map((p: { key: string }) => p.key)).toEqual(["list-a", "list-b"]);

  for (const query of ["sort=draft", "filter[draft]=x", "filter[or][0][search]=a", "filter[search]=a&filter[search]=b"]) {
    expect((await call("GET", `/workflow/processes?${query}`)).status).toBe(400);
  }
  expect((await call("GET", "/workflow/processes?filter[archived]=maybe")).status).toBe(422);
});

test.skipIf(!enabled)("instance and task lists take filters in the same way", async () => {
  await published("listed", TASK_DOCUMENT);
  const one = await call("POST", "/workflow/instances", { processKey: "listed", businessKey: "b-1", partition: "space-1" });
  await call("POST", "/workflow/instances", { processKey: "listed", businessKey: "b-2", partition: "space-2" });
  expect(one.status).toBe(201);

  const byKey = await call("GET", "/workflow/instances?filter[businessKey]=b-1");
  expect(byKey.body.data.map((i: { id: string }) => i.id)).toEqual([one.body.id]);
  const newest = await call("GET", "/workflow/instances?filter[processKey]=listed&page[size]=1");
  expect(newest.body.data[0].businessKey).toBe("b-2");
  const oldest = await call("GET", "/workflow/instances?filter[processKey]=listed&page[size]=1&sort=createdAt");
  expect(oldest.body.meta.total).toBe(2);
  expect(oldest.body.data[0].businessKey).toBe("b-1");

  const task = await eventually(async () => {
    const list = await call("GET", "/workflow/tasks?filter[processKey]=listed&filter[partition]=space-1");
    return list.body.data[0] as { id: string; instanceId: string } | undefined;
  });
  expect(task.instanceId).toBe(one.body.id);
  expect((await call("GET", "/workflow/tasks?filter[processKey]=listed&filter[status][in]=completed,cancelled")).body.data).toEqual([]);
  expect((await call("GET", "/workflow/tasks?filter[processKey]=listed&filter[status]=open")).body.meta.total).toBe(2);
  expect((await call("GET", "/workflow/tasks?filter[status]=nope")).status).toBe(422);
});

test.skipIf(!enabled)("a draft saved by someone else in between is a conflict; the last save wins without expected", async () => {
  await call("POST", "/workflow/processes", { key: "locked", title: "Locked" });
  const read = (await call("GET", "/workflow/processes/locked")).body;

  const first = await call("PUT", "/workflow/processes/locked/draft", { document: TASK_DOCUMENT, expected: read.draftUpdatedAt });
  expect(first.status).toBe(200);
  expect(first.body.issues).toEqual([]);
  expect(first.body.draftUpdatedAt).not.toBe(read.draftUpdatedAt);

  const stale = await call("PUT", "/workflow/processes/locked/draft", { document: TOOL_DOCUMENT, expected: read.draftUpdatedAt });
  expect(stale.status).toBe(409);
  expect(stale.body.details.code).toBe("conflict");
  expect((await call("GET", "/workflow/processes/locked")).body.draft).toEqual(TASK_DOCUMENT);

  expect((await call("PUT", "/workflow/processes/locked/draft", { document: TASK_DOCUMENT, expected: first.body.draftUpdatedAt })).status).toBe(200);
  expect((await call("PUT", "/workflow/processes/locked/draft", { document: TASK_DOCUMENT, expected: "not a date" })).status).toBe(422);
  expect((await call("PUT", "/workflow/processes/locked/draft", { document: TASK_DOCUMENT })).status).toBe(200);

  const scope = app.container.createScope();
  try {
    const definitions = scope.resolve(IWorkflowDefinitions);
    const actor = { kind: "system", id: "test" } as const;
    const a = await definitions.saveDraft("locked", TASK_DOCUMENT, actor);
    // Two saves are told apart even within one millisecond.
    const b = await definitions.saveDraft("locked", TASK_DOCUMENT, actor, { expected: a.draftUpdatedAt });
    expect(b.draftUpdatedAt.getTime()).toBeGreaterThan(a.draftUpdatedAt.getTime());
    await expect(definitions.saveDraft("locked", TASK_DOCUMENT, actor, { expected: a.draftUpdatedAt })).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await scope.dispose();
  }
});

test.skipIf(!enabled)("the catalog tells the audit what changed, by whom and from where", async () => {
  seen.length = 0;
  const key = "audited";
  await call("POST", "/workflow/processes", { key, title: "Audited" });
  await call("PATCH", `/workflow/processes/${key}`, { title: "Audited" });
  await call("PATCH", `/workflow/processes/${key}`, { title: "Renamed" });
  await call("PUT", `/workflow/processes/${key}/draft`, { document: TASK_DOCUMENT });
  await call("POST", `/workflow/processes/${key}/publish`);
  await call("POST", `/workflow/processes/${key}/publish`);
  await call("PATCH", `/workflow/processes/${key}`, { archived: true });
  await call("PATCH", `/workflow/processes/${key}`, { archived: true });
  await call("PATCH", `/workflow/processes/${key}`, { archived: false });

  const changes = eventsOf("workflow.process-changed");
  expect(changes.map((change) => change.change)).toEqual(["created", "updated", "draftSaved", "published", "archived", "restored"]);
  expect(changes[3]).toMatchObject({ key, version: 1 });
  for (const change of changes) {
    expect(change.key).toBe(key);
    expect(change.actor).toEqual({ kind: "user", id: "admin" });
    expect((change.request as { userAgent: string }).userAgent).toBe("contract-test");
  }

  // A call from code has no request.
  seen.length = 0;
  const scope = app.container.createScope();
  try {
    await scope.resolve(IWorkflowDefinitions).update(key, { title: "From code" }, { kind: "system", id: "job" });
  } finally {
    await scope.dispose();
  }
  expect(eventsOf("workflow.process-changed")).toEqual([{ change: "updated", key, version: null, actor: { kind: "system", id: "job" }, request: null }]);
});

test.skipIf(!enabled)("instances and tasks tell the audit; a Tool learns who it runs for and which step it is", async () => {
  seen.length = 0;
  contexts.length = 0;
  await published("audited-task", TASK_DOCUMENT);
  await published("audited-tool", TOOL_DOCUMENT);
  const from = { userAgent: "contract-test" };

  const started = (await call("POST", "/workflow/instances", { processKey: "audited-task", businessKey: "k-1", partition: "space-1" })).body;
  expect(eventsOf("workflow.instance-started")).toContainEqual(expect.objectContaining({ instanceId: started.id, processKey: "audited-task", version: 1, partition: "space-1", businessKey: "k-1", startedVia: "manual", actor: { kind: "user", id: "admin" }, request: expect.objectContaining(from) }));

  const task = await eventually(async () => (await call("GET", `/workflow/tasks?filter[processKey]=audited-task`)).body.data[0] as { id: string; nodeId: string } | undefined);
  expect((await call("POST", `/workflow/tasks/${task.id}/complete`, { output: {} })).status).toBe(200);
  expect(eventsOf("workflow.task-completed")).toEqual([expect.objectContaining({ taskId: task.id, instanceId: started.id, processKey: "audited-task", nodeId: "Approve", partition: "space-1", actor: { kind: "user", id: "admin" }, request: expect.objectContaining(from) })]);

  const cancelled = (await call("POST", "/workflow/instances", { processKey: "audited-task" })).body;
  expect((await call("POST", `/workflow/instances/${cancelled.id}/cancel`, { reason: "enough" })).status).toBe(200);
  expect(eventsOf("workflow.instance-cancelled")).toEqual([expect.objectContaining({ instanceId: cancelled.id, processKey: "audited-task", reason: "enough", actor: { kind: "user", id: "admin" }, request: expect.objectContaining(from) })]);

  const ran = (await call("POST", "/workflow/instances", { processKey: "audited-tool", partition: "space-2" })).body;
  const context = await eventually(async () => contexts.find((item) => item.metadata.instanceId === ran.id));
  expect(context.actor).toEqual({ kind: "user", id: "admin" });
  expect(context.metadata).toMatchObject({ instanceId: ran.id, processKey: "audited-tool", nodeId: "Note", partition: "space-2", test: false });

  failOnce = true;
  const failed = (await call("POST", "/workflow/instances", { processKey: "audited-tool" })).body;
  await eventually(async () => (await call("GET", `/workflow/instances/${failed.id}`)).body.status === "failed" ? true : undefined);
  expect((await call("POST", `/workflow/instances/${failed.id}/retry`)).status).toBe(200);
  expect(eventsOf("workflow.instance-retried")).toEqual([expect.objectContaining({ instanceId: failed.id, processKey: "audited-tool", actor: { kind: "user", id: "admin" }, request: expect.objectContaining(from) })]);

  // An event from outside starts on behalf of the caller, with the same request.
  expect((await call("PUT", "/workflow/processes/audited-tool/draft", { document: { ...TOOL_DOCUMENT, nodes: { ...TOOL_DOCUMENT.nodes, Start: { kind: "eventStart", title: "Start", config: { event: "orders.paid" } } } } })).status).toBe(200);
  expect((await call("POST", "/workflow/processes/audited-tool/publish")).status).toBe(201);
  const emitted = await call("POST", "/workflow/events/orders.paid", { payload: {} });
  expect(emitted.status).toBe(202);
  expect(eventsOf("workflow.instance-started")).toContainEqual(expect.objectContaining({ instanceId: emitted.body.started[0], startedVia: "event", request: expect.objectContaining(from) }));
});

test.skipIf(!enabled)("the Tools of the catalog say whether they can dry-run", async () => {
  const tools = await call("GET", "/workflow/tools");
  expect(tools.body.data.find((tool: { name: string }) => tool.name === "contract.note")).toMatchObject({ dryRun: "supported", sideEffect: "write" });
});
