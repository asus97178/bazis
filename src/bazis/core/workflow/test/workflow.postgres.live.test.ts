import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { AccessPolicy, type AccessSubject, type Grants, type Scope, type ScopePrincipals } from "@/core/access";
import { DI, Module, singleton } from "@/core/di";
import { Infra } from "@/core/infra";
import { defineConfig, eventsModule, OnEvent, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp, type TestApp } from "@/core/testing";
import { Tool, ToolError, TOOL_EXECUTION_OPTIONS, type AgentToolApprovalRequest, type AgentToolExecutionContext } from "@/core/agent";
import type { AuthorizeContext } from "@/core/http";
import { postgres } from "@/library/orm";
import {
  IWorkflowRuntime,
  WORKFLOW_INSTANCE_FINISHED,
  WORKFLOW_TASK_REQUESTED,
  WORKFLOW_TOKEN_CLOSED,
  WorkflowModule,
  type WorkflowInstanceFinished,
  type WorkflowTaskRequested,
  type WorkflowTokenClosed,
} from "@/core/workflow";
import { WorkflowRetention } from "../runtime_module/background/WorkflowRetention";
import { Schedules } from "../runtime_module/internal/Schedules";
import { RuntimeDbContext } from "../runtime_module/model/Runtime.dbContext";

/**
 * Live check of stages 1–4 of WORKFLOW-001 on PostgreSQL, through HTTP as an
 * application without the CMS would use it. Runs only against a throwaway
 * database whose name starts with `bazis_wf_`: set `BAZIS_WORKFLOW_PG_URL`.
 * The test drops the workflow tables before it starts.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const calls: { name: string; input: unknown; key: string | undefined; actor: unknown; metadata: unknown }[] = [];
let fragileFailures = 0;
const approvals: AgentToolApprovalRequest[] = [];

function record(name: string, input: unknown, context: AgentToolExecutionContext): void {
  calls.push({ name, input, key: context.idempotencyKey, actor: (context as { actor?: unknown }).actor, metadata: context.metadata });
}

@Tool({ name: "payments.charge", description: "Charges an amount.", sideEffect: "write", approval: "policy", callers: ["workflow"] })
class ChargeTool {
  execute(input: { amount: number }, context: AgentToolExecutionContext) {
    record("payments.charge", input, context);
    return { status: input.amount >= 100 ? "paid" : "declined", paymentId: `p-${input.amount}` };
  }
}

@Tool({ name: "notify.email", description: "Sends an email.", sideEffect: "external", callers: ["workflow"] })
class EmailTool {
  execute(input: unknown, context: AgentToolExecutionContext) {
    record("notify.email", input, context);
    return { sent: true };
  }
}

@Tool({ name: "notify.sms", description: "Sends an SMS.", sideEffect: "external", callers: ["workflow"] })
class SmsTool {
  execute(input: unknown, context: AgentToolExecutionContext) {
    record("notify.sms", input, context);
    return { sent: true };
  }
}

@Tool({ name: "flaky.step", description: "Fails the first time.", sideEffect: "write", callers: ["workflow"] })
class FlakyTool {
  execute(input: unknown, context: AgentToolExecutionContext) {
    record("flaky.step", input, context);
    if (fragileFailures++ === 0) throw new Error("upstream is down");
    return { ok: true };
  }
}

let twiceFailures = 0;

@Tool({ name: "flaky.twice", description: "Fails twice.", sideEffect: "write", callers: ["workflow"] })
class TwiceTool {
  execute(input: unknown, context: AgentToolExecutionContext) {
    record("flaky.twice", input, context);
    if (twiceFailures++ < 2) throw new Error("timeout upstream");
    return { ok: true };
  }
}

@Tool({ name: "cards.charge", description: "Charges a card.", sideEffect: "write", callers: ["workflow"] })
class CardTool {
  execute(input: { amount: number }, context: AgentToolExecutionContext) {
    record("cards.charge", input, context);
    if (input.amount > 1000) throw new ToolError("The card is declined", { reason: "card_declined" });
    return { charged: input.amount };
  }
}

@Tool({ name: "agents.only", description: "Agents only.", sideEffect: "read", callers: ["agent"] })
class AgentOnlyTool {
  execute() {
    return {};
  }
}

/** Identity from `x-user`, everything allowed except with `x-deny`. */
interface HeaderSubject extends AccessSubject {
  readonly id: string;
  readonly denied: boolean;
  readonly roles: readonly string[];
}

class HeaderPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): HeaderSubject | undefined {
    const user = ctx.header("x-user");
    if (user === undefined) return undefined;
    return { sub: `user:${user}`, id: user, denied: ctx.header("x-deny") !== undefined, roles: (ctx.header("x-roles") ?? "").split(",").filter(Boolean) };
  }

  grants(subject: AccessSubject): Grants {
    return (subject as HeaderSubject).denied ? [] : "all";
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [(subject as HeaderSubject).id];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    const { id, roles } = subject as HeaderSubject;
    return scopes.map((scope) => ({ scope, principals: [`user:${id}`, ...roles.map((role) => `role:${role}`)] }));
  }
}

const seen: { requested: WorkflowTaskRequested[]; closed: WorkflowTokenClosed[]; finished: WorkflowInstanceFinished[] } = { requested: [], closed: [], finished: [] };

class Inbox {
  @OnEvent(WORKFLOW_TASK_REQUESTED)
  requested(event: WorkflowTaskRequested): void {
    seen.requested.push(event);
  }

  @OnEvent(WORKFLOW_TOKEN_CLOSED)
  closed(event: WorkflowTokenClosed): void {
    seen.closed.push(event);
  }

  @OnEvent(WORKFLOW_INSTANCE_FINISHED)
  finished(event: WorkflowInstanceFinished): void {
    seen.finished.push(event);
  }
}

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfdb", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({ tools: [ChargeTool, EmailTool, SmsTool, FlakyTool, AgentOnlyTool, TwiceTool, CardTool] }) class ToolsModule {}
  @Module({
    imports: [TestInfra, WorkflowModule, ToolsModule, eventsModule({ subscribers: [Inbox] })],
    providers: [
      singleton(AccessPolicy, HeaderPolicy),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, {
        auditSink: () => undefined,
        approvalPolicy: (request: AgentToolApprovalRequest) => {
          approvals.push(request);
          return true;
        },
      })),
    ],
  })
  class AppModule {}
  return AppModule;
}

const ORDER = {
  schemaVersion: "bazis.workflow/v1",
  input: { fields: [{ code: "amount", type: "number", required: true }] },
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Pay: { kind: "serviceTask", title: "Pay", config: { tool: "payments.charge", input: { amount: "$input.amount" }, saveTo: "payment" } },
    Paid: { kind: "exclusiveGateway", title: "Paid?" },
    Split: { kind: "parallelGateway", title: "Notify" },
    Email: { kind: "serviceTask", title: "Email", config: { tool: "notify.email", input: { payment: "$vars.payment.paymentId" } } },
    Sms: { kind: "serviceTask", title: "SMS", config: { tool: "notify.sms" } },
    Join: { kind: "parallelGateway", title: "Joined" },
    Review: { kind: "userTask", title: "Call the customer", config: { assignee: { role: "support" }, form: { fields: [{ code: "comment", type: "string", required: true }] }, dueIn: "P1D" } },
    End: { kind: "end", title: "End" },
  },
  flows: {
    f1: { source: "Start", target: "Pay" },
    f2: { source: "Pay", target: "Paid" },
    f3: { source: "Paid", target: "Split", condition: { path: "$vars.payment.status", op: "eq", value: "paid" } },
    f4: { source: "Paid", target: "Review", isDefault: true },
    f5: { source: "Split", target: "Email" },
    f6: { source: "Split", target: "Sms" },
    f7: { source: "Email", target: "Join" },
    f8: { source: "Sms", target: "Join" },
    f9: { source: "Join", target: "End" },
    f10: { source: "Review", target: "End" },
  },
};

const FRAGILE = {
  schemaVersion: "bazis.workflow/v1",
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Step: { kind: "serviceTask", title: "Step", config: { tool: "flaky.step" } },
    End: { kind: "end", title: "End" },
  },
  flows: { a: { source: "Start", target: "Step" }, b: { source: "Step", target: "End" } },
};

let app: TestApp;
const as = (user: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-user": user, ...extra });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = as("u-1")) {
  const response = await app.fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function settled(id: string, statuses: readonly string[] = ["completed", "failed", "cancelled"]) {
  for (let i = 0; i < 100; i++) {
    const instance = (await call("GET", `/workflow/instances/${id}`)).body;
    if (statuses.includes(instance.status) || instance.tokens.some((t: { nodeId: string; status: string }) => t.nodeId === "Review" && t.status === "waiting")) return instance;
    await Bun.sleep(50);
  }
  throw new Error(`instance ${id} did not settle`);
}

beforeAll(async () => {
  if (!enabled) return;
  const sql = postgres({ url });
  try {
    const tables = (await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'bazis\\_wf\\_%'", [])) as { tablename: string }[];
    if (tables.length > 0) await sql.execute(`DROP TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`, []);
    await sql.execute(`DO $$ BEGIN IF to_regclass('public.__bazis_orm_owned_stores_v1') IS NOT NULL THEN DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key LIKE 'bazis.workflow.%'; END IF; END $$`, []);
  } finally {
    await sql.close();
  }
  process.env.BAZIS_WORKFLOW__WORKER__INTERVALMS = "50";
  app = await startTestApp(root(url!));
});

afterAll(async () => {
  await app?.stop();
  delete process.env.BAZIS_WORKFLOW__WORKER__INTERVALMS;
});

test.skipIf(!enabled)("the HTTP of the module is closed without an identity and with a refusal", async () => {
  expect((await call("GET", "/workflow/processes", undefined, { "content-type": "application/json" })).status).toBe(401);
  expect((await call("GET", "/workflow/processes", undefined, as("u-1", { "x-deny": "1" }))).status).toBe(403);
});

test.skipIf(!enabled)("a process is created, drafted, checked against the Tools and published once per document", async () => {
  const created = await call("POST", "/workflow/processes", { key: "order", title: "Order", retentionDays: 30 });
  expect(created.status).toBe(201);
  expect(created.body.draft.nodes.Start.kind).toBe("manualStart");
  expect((await call("POST", "/workflow/processes", { key: "order", title: "Again" })).status).toBe(409);

  const tools = await call("GET", "/workflow/tools");
  expect(tools.body.data.map((tool: { name: string }) => tool.name)).toEqual(["cards.charge", "flaky.step", "flaky.twice", "notify.email", "notify.sms", "payments.charge"]);

  const wrong = structuredClone(ORDER) as { nodes: Record<string, { config?: Record<string, unknown> }> };
  wrong.nodes.Sms!.config = { tool: "agents.only" };
  const draft = await call("PUT", "/workflow/processes/order/draft", { document: wrong });
  expect(draft.status).toBe(200);
  expect(draft.body.issues).toEqual([expect.objectContaining({ severity: "error", code: "unknown_tool", node: "Sms" })]);
  const refused = await call("POST", "/workflow/processes/order/publish");
  expect(refused.status).toBe(422);
  expect(refused.body.details.code).toBe("invalid_document");

  expect((await call("PUT", "/workflow/processes/order/draft", { document: ORDER })).body.issues).toEqual([]);
  const published = await call("POST", "/workflow/processes/order/publish");
  expect(published.status).toBe(201);
  expect(published.body).toMatchObject({ key: "order", version: 1, publishedBy: { kind: "user", id: "u-1" } });
  expect((await call("POST", "/workflow/processes/order/publish")).body.version).toBe(1);
  expect((await call("GET", "/workflow/processes/order/versions")).body.data.map((v: { version: number }) => v.version)).toEqual([1]);
});

test.skipIf(!enabled)("a paid order runs the Tools on behalf of the starter and joins the parallel branches", async () => {
  const invalid = await call("POST", "/workflow/instances", { processKey: "order", input: { amount: "a lot" } });
  expect(invalid.status).toBe(422);
  expect(invalid.body.details.issues).toEqual([expect.objectContaining({ field: "amount", code: "type" })]);

  calls.length = 0;
  const started = await call("POST", "/workflow/instances", { processKey: "order", input: { amount: 150 }, partition: "space-1", businessKey: "order:1" }, as("u-7"));
  expect(started.status).toBe(201);
  const done = await settled(started.body.id);
  expect(done.status).toBe("completed");
  expect(done.vars.payment).toEqual({ status: "paid", paymentId: "p-150" });

  const charge = calls.find((c) => c.name === "payments.charge")!;
  const payToken = done.tokens.find((t: { nodeId: string }) => t.nodeId === "Pay");
  expect(charge).toMatchObject({ input: { amount: 150 }, key: payToken.id, metadata: { instanceId: done.id, partition: "space-1", processKey: "order", nodeId: "Pay" } });
  expect(calls.map((c) => c.name).sort()).toEqual(["notify.email", "notify.sms", "payments.charge"]);
  expect(calls.find((c) => c.name === "notify.email")!.input).toEqual({ payment: "p-150" });
  expect(approvals.find((a) => a.tool.metadata.name === "payments.charge")).toMatchObject({ caller: "workflow", actor: { kind: "user", id: "u-7" } });

  const history = (await call("GET", `/workflow/instances/${done.id}/history`)).body.data;
  // 0.126.0: instance-level entries have no token (0.124–0.125 stored a generated uuid).
  expect(history[0]).toMatchObject({ type: "started", tokenId: null, actor: { kind: "user", id: "u-7" } });
  expect(history.at(-1)).toMatchObject({ type: "completed", tokenId: null });
  expect(history.at(-1).type).toBe("completed");
  expect(history.filter((h: { type: string }) => h.type === "tool")).toHaveLength(3);
  expect(seen.finished).toContainEqual({ instanceId: done.id, processKey: "order", partition: "space-1", status: "completed" });

  const list = await call("GET", "/workflow/instances?filter[partition]=space-1&filter[status]=completed");
  expect(list.body.meta.total).toBe(1);
  expect(list.body.data[0].businessKey).toBe("order:1");
});

test.skipIf(!enabled)("a declined order waits for a person; the task form is checked", async () => {
  const started = await call("POST", "/workflow/instances", { processKey: "order", input: { amount: 5 } });
  const waiting = await settled(started.body.id);
  expect(waiting.status).toBe("running");
  const token = waiting.tokens.find((t: { nodeId: string; status: string }) => t.nodeId === "Review" && t.status === "waiting");
  // The event follows the commit: the waiting step can be seen a moment before it.
  for (let i = 0; i < 40 && !seen.requested.some((r) => r.tokenId === token.id); i++) await Bun.sleep(25);
  const requested = seen.requested.find((r) => r.tokenId === token.id)!;
  expect(requested).toMatchObject({ instanceId: waiting.id, processKey: "order", nodeId: "Review", title: "Call the customer", assignee: { role: "support" } });
  expect(requested.dueAt).toBeInstanceOf(Date);

  const runtime = app.container.createScope();
  try {
    const service = runtime.resolve(IWorkflowRuntime);
    await expect(service.completeToken(token.id, {}, { kind: "user", id: "u-2" })).rejects.toMatchObject({ code: "invalid_input" });
    const done = await service.completeToken(token.id, { comment: "called" }, { kind: "user", id: "u-2" });
    expect(done.status).toBe("completed");
    expect(done.nodes.Review).toEqual({ comment: "called" });
    await expect(service.completeToken(token.id, { comment: "again" }, { kind: "user", id: "u-2" })).rejects.toMatchObject({ code: "wrong_status" });
  } finally {
    await runtime.dispose();
  }
});

test.skipIf(!enabled)("cancelling a waiting instance closes its task", async () => {
  const started = await call("POST", "/workflow/instances", { processKey: "order", input: { amount: 1 } });
  const waiting = await settled(started.body.id);
  const cancelled = await call("POST", `/workflow/instances/${waiting.id}/cancel`, { reason: "duplicate" }, as("admin"));
  expect(cancelled.body.status).toBe("cancelled");
  await Bun.sleep(20);
  const token = waiting.tokens.find((t: { nodeId: string }) => t.nodeId === "Review");
  expect(seen.closed).toContainEqual({ instanceId: waiting.id, tokenId: token.id, reason: "cancelled" });
  expect((await call("POST", `/workflow/instances/${waiting.id}/cancel`, {})).status).toBe(409);
  const history = (await call("GET", `/workflow/instances/${waiting.id}/history`)).body.data;
  expect(history.at(-1)).toMatchObject({ type: "cancelled", data: { reason: "duplicate" }, actor: { kind: "user", id: "admin" } });
});

test.skipIf(!enabled)("a failed step waits for a retry", async () => {
  await call("POST", "/workflow/processes", { key: "fragile", title: "Fragile" });
  await call("PUT", "/workflow/processes/fragile/draft", { document: FRAGILE });
  await call("POST", "/workflow/processes/fragile/publish");
  const started = await call("POST", "/workflow/instances", { processKey: "fragile" });
  const failed = await settled(started.body.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ node: "Step" });
  expect((await call("POST", `/workflow/instances/${failed.id}/retry`)).status).toBe(200);
  expect((await settled(failed.id)).status).toBe("completed");
  expect((await call("POST", `/workflow/instances/${failed.id}/retry`)).status).toBe(409);
});

async function publish(key: string, document: unknown) {
  await call("POST", "/workflow/processes", { key, title: key });
  expect((await call("PUT", `/workflow/processes/${key}/draft`, { document })).body.issues).toEqual([]);
  expect((await call("POST", `/workflow/processes/${key}/publish`)).status).toBe(201);
}

const doc = (nodes: Record<string, unknown>, flows: Record<string, unknown>, input?: unknown) => ({ schemaVersion: "bazis.workflow/v1", ...(input === undefined ? {} : { input }), nodes, flows });

interface Snapshot {
  readonly id: string;
  readonly status: string;
  readonly partition: string | null;
  readonly startedVia: string;
  readonly startedBy: { readonly kind: string; readonly id: string };
  readonly input: Record<string, unknown>;
  readonly nodes: Record<string, unknown>;
  readonly tokens: readonly { readonly nodeId: string; readonly status: string; readonly id: string }[];
}

async function until(id: string, test: (instance: Snapshot) => boolean): Promise<Snapshot> {
  for (let i = 0; i < 200; i++) {
    const instance = (await call("GET", `/workflow/instances/${id}`)).body as Snapshot;
    if (test(instance)) return instance;
    await Bun.sleep(50);
  }
  throw new Error(`instance ${id} did not reach the state`);
}

test.skipIf(!enabled)("stage 2: a failed call is retried by the node's policy with the same idempotency key", async () => {
  await publish("retrying", doc({
    Start: { kind: "manualStart", title: "Start" },
    Step: { kind: "serviceTask", title: "Step", config: { tool: "flaky.twice", retry: { maxAttempts: 3, backoff: "PT0S" } } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Step" }, b: { source: "Step", target: "End" } }));
  calls.length = 0;
  const started = await call("POST", "/workflow/instances", { processKey: "retrying" });
  const done = await until(started.body.id, (i) => i.status !== "running");
  expect(done.status).toBe("completed");
  const keys = calls.filter((c) => c.name === "flaky.twice").map((c) => c.key);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  const tools = (await call("GET", `/workflow/instances/${done.id}/history`)).body.data.filter((h: { type: string }) => h.type === "tool");
  expect(tools.map((h: { data: { attempt: number; status: string; retryAt?: string } }) => [h.data.attempt, h.data.status, h.data.retryAt !== undefined])).toEqual([[1, "error", true], [2, "error", true], [3, "success", false]]);
});

test.skipIf(!enabled)("stage 2: a business reason goes to the error boundary without retries", async () => {
  await publish("declines", doc({
    Start: { kind: "manualStart", title: "Start" },
    Charge: { kind: "serviceTask", title: "Charge", config: { tool: "cards.charge", input: { amount: "$input.amount" }, retry: { maxAttempts: 3, backoff: "PT0S" } } },
    Declined: { kind: "boundaryError", title: "Declined", attachedTo: "Charge", config: { errorCode: "card_declined" } },
    Email: { kind: "serviceTask", title: "Email", config: { tool: "notify.email" } },
    End: { kind: "end", title: "End" },
    Sorry: { kind: "end", title: "Sorry" },
  }, {
    a: { source: "Start", target: "Charge" },
    b: { source: "Charge", target: "End" },
    c: { source: "Declined", target: "Email" },
    d: { source: "Email", target: "Sorry" },
  }, { fields: [{ code: "amount", type: "number", required: true }] }));
  calls.length = 0;
  const declined = await until((await call("POST", "/workflow/instances", { processKey: "declines", input: { amount: 5000 } })).body.id, (i) => i.status !== "running");
  expect(declined.status).toBe("completed");
  expect(calls.filter((c) => c.name === "cards.charge")).toHaveLength(1);
  expect(calls.map((c) => c.name)).toContain("notify.email");
  expect(declined.nodes.Declined).toMatchObject({ reason: "card_declined", message: "The card is declined" });
  expect(declined.tokens.map((t) => t.nodeId)).toEqual(["Start", "Charge", "Declined", "Email", "Sorry"]);

  const paid = await until((await call("POST", "/workflow/instances", { processKey: "declines", input: { amount: 10 } })).body.id, (i) => i.status !== "running");
  expect(paid.tokens.map((t) => t.nodeId)).toEqual(["Start", "Charge", "End"]);
});

test.skipIf(!enabled)("stage 2: timers wait for a duration or a date from the data", async () => {
  await publish("waits", doc({
    Start: { kind: "manualStart", title: "Start" },
    Wait: { kind: "timerCatch", title: "Wait", config: { duration: "PT1S" } },
    Until: { kind: "timerCatch", title: "Until", config: { at: "$input.at" } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Wait" }, b: { source: "Wait", target: "Until" }, c: { source: "Until", target: "End" } },
  { fields: [{ code: "at", type: "datetime", required: true }] }));
  const startedAt = Date.now();
  const started = await call("POST", "/workflow/instances", { processKey: "waits", input: { at: new Date(Date.now() - 60_000).toISOString() } });
  expect(started.body.tokens.find((t: { nodeId: string }) => t.nodeId === "Wait").status).toBe("waiting");
  const done = await until(started.body.id, (i) => i.status !== "running");
  expect(done.status).toBe("completed");
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
});

test.skipIf(!enabled)("stage 2: an interrupting boundary timer takes over a task, a non-interrupting one runs beside it", async () => {
  const task = { kind: "userTask", title: "Approve", config: { assignee: { role: "boss" } } };
  await publish("escalates", doc({
    Start: { kind: "manualStart", title: "Start" },
    Approve: task,
    Late: { kind: "boundaryTimer", title: "Late", attachedTo: "Approve", config: { duration: "PT1S" } },
    Sms: { kind: "serviceTask", title: "Sms", config: { tool: "notify.sms" } },
    End: { kind: "end", title: "End" },
    Escalated: { kind: "end", title: "Escalated" },
  }, { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" }, c: { source: "Late", target: "Sms" }, d: { source: "Sms", target: "Escalated" } }));
  const escalated = await until((await call("POST", "/workflow/instances", { processKey: "escalates" })).body.id, (i) => i.status !== "running");
  expect(escalated.status).toBe("completed");
  const approve = escalated.tokens.find((t) => t.nodeId === "Approve")!;
  expect(approve.status).toBe("cancelled");
  expect(seen.closed).toContainEqual({ instanceId: escalated.id, tokenId: approve.id, reason: "interrupted" });

  await publish("reminds", doc({
    Start: { kind: "manualStart", title: "Start" },
    Approve: task,
    Remind: { kind: "boundaryTimer", title: "Remind", attachedTo: "Approve", config: { duration: "PT1S", interrupting: false } },
    Email: { kind: "serviceTask", title: "Email", config: { tool: "notify.email" } },
    End: { kind: "end", title: "End" },
    Reminded: { kind: "end", title: "Reminded" },
  }, { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" }, c: { source: "Remind", target: "Email" }, d: { source: "Email", target: "Reminded" } }));
  const reminded = await until((await call("POST", "/workflow/instances", { processKey: "reminds" })).body.id, (i) => i.tokens.some((t) => t.nodeId === "Reminded"));
  expect(reminded.status).toBe("running");
  const waiting = reminded.tokens.find((t) => t.nodeId === "Approve")!;
  expect(waiting.status).toBe("waiting");
  const scope = app.container.createScope();
  try {
    const done = await scope.resolve(IWorkflowRuntime).completeToken(waiting.id, {}, { kind: "user", id: "boss" });
    expect(done.status).toBe("completed");
  } finally {
    await scope.dispose();
  }
});

test.skipIf(!enabled)("stage 3: a wait takes the event of its correlation; HTTP delivers events too", async () => {
  await publish("awaits", doc({
    Start: { kind: "manualStart", title: "Start" },
    Wait: { kind: "eventWait", title: "Paid", config: { event: "payments.received", correlation: "$input.orderId", saveTo: "payment" } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Wait" }, b: { source: "Wait", target: "End" } }, { fields: [{ code: "orderId", type: "string", required: true }] }));
  const one = (await call("POST", "/workflow/instances", { processKey: "awaits", input: { orderId: "1" } })).body.id;
  const two = (await call("POST", "/workflow/instances", { processKey: "awaits", input: { orderId: "2" } })).body.id;
  const scope = app.container.createScope();
  try {
    const runtime = scope.resolve(IWorkflowRuntime);
    expect(await runtime.emit("payments.received", { amount: 5 })).toEqual({ started: [], continued: [], rejected: [] });
    expect(await runtime.emit("payments.received", { amount: 10 }, { correlation: "1" })).toEqual({ started: [], continued: [one], rejected: [] });
    expect((await runtime.instance(one))).toMatchObject({ status: "completed", vars: { payment: { amount: 10 } } });
    expect((await runtime.instance(two)).status).toBe("running");
  } finally {
    await scope.dispose();
  }
  const delivered = await call("POST", "/workflow/events/payments.received", { payload: { amount: 20 }, correlation: "2" });
  expect(delivered.status).toBe(202);
  expect(delivered.body.continued).toEqual([two]);
  const history = (await call("GET", `/workflow/instances/${two}/history`)).body.data;
  expect(history.find((h: { type: string }) => h.type === "event")).toMatchObject({ nodeId: "Wait", data: { event: "payments.received" } });
});

test.skipIf(!enabled)("stage 3: an event starts the processes listening for it; a boundary event interrupts a task", async () => {
  await publish("welcome", doc({
    Start: { kind: "eventStart", title: "Signed up", config: { event: "users.signed-up" } },
    Email: { kind: "serviceTask", title: "Email", config: { tool: "notify.email", input: { to: "$input.email" } } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Email" }, b: { source: "Email", target: "End" } }, { fields: [{ code: "email", type: "string", required: true }] }));
  const scope = app.container.createScope();
  try {
    const runtime = scope.resolve(IWorkflowRuntime);
    const result = await runtime.emit("users.signed-up", { email: "a@b.c", plan: "pro" }, { partition: "space-9" });
    expect(result.started).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    const started = await until(result.started[0]!, (i) => i.status !== "running");
    expect(started).toMatchObject({ status: "completed", partition: "space-9", startedVia: "event", startedBy: { kind: "system", id: "event:users.signed-up" }, input: { email: "a@b.c" } });
    expect((await runtime.emit("users.signed-up", { plan: "free" })).rejected).toEqual([{ processKey: "welcome", issues: [expect.objectContaining({ field: "email", code: "required" })] }]);
  } finally {
    await scope.dispose();
  }

  await publish("cancellable", doc({
    Start: { kind: "manualStart", title: "Start" },
    Review: { kind: "userTask", title: "Review", config: { assignee: { role: "support" } } },
    Cancelled: { kind: "boundaryEvent", title: "Cancelled", attachedTo: "Review", config: { event: "orders.cancelled", correlation: "$input.orderId" } },
    End: { kind: "end", title: "End" },
    Dropped: { kind: "end", title: "Dropped" },
  }, { a: { source: "Start", target: "Review" }, b: { source: "Review", target: "End" }, c: { source: "Cancelled", target: "Dropped" } }, { fields: [{ code: "orderId", type: "string", required: true }] }));
  const id = (await call("POST", "/workflow/instances", { processKey: "cancellable", input: { orderId: "77" } })).body.id;
  expect((await call("POST", "/workflow/events/orders.cancelled", { payload: { by: "client" }, correlation: "77" })).body.continued).toEqual([id]);
  const done = await until(id, (i) => i.status !== "running");
  expect(done.tokens.map((t) => [t.nodeId, t.status])).toEqual([["Start", "done"], ["Review", "cancelled"], ["Cancelled", "done"], ["Dropped", "done"]]);
  expect(done.nodes.Cancelled).toEqual({ by: "client" });
  expect(seen.closed).toContainEqual({ instanceId: id, tokenId: done.tokens[1]!.id, reason: "interrupted" });
});

test.skipIf(!enabled)("stage 3: a scheduled version gets one job; a firing starts an instance and plans the next", async () => {
  await publish("nightly", doc({
    Start: { kind: "scheduleStart", title: "Every minute", config: { cron: "* * * * *" } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "End" } }));
  const sql = postgres({ url });
  const jobs = async () => (await sql.query(`SELECT id, "dueAt", "versionId" FROM "bazis_wf_run_jobs" WHERE kind = 'schedule'`, [])) as { id: string; dueAt: Date; versionId: string }[];
  const scope = app.container.createScope();
  try {
    const schedules = scope.resolve(Schedules);
    await Promise.all([schedules.reconcile(), app.container.createScope().resolve(Schedules).reconcile()]);
    const [job] = await jobs();
    expect(await jobs()).toHaveLength(1);
    const runtime = scope.resolve(IWorkflowRuntime);
    const before = (await runtime.instances({ processKey: "nightly" })).total;
    const row = (await scope.resolve(RuntimeDbContext).jobs.asNoTracking().firstOrDefault((j) => j.id.eq(job!.id)))!;
    await schedules.fire(row);
    const after = await runtime.instances({ processKey: "nightly" });
    expect(after.total).toBe(before + 1);
    expect(after.items[0]).toMatchObject({ status: "completed", startedVia: "schedule", startedBy: { kind: "system", id: "schedule" } });
    const [moved] = await jobs();
    expect(new Date(moved!.dueAt).getTime() - new Date(job!.dueAt).getTime()).toBe(60_000);

    await call("PATCH", "/workflow/processes/nightly", { archived: true });
    await schedules.reconcile();
    expect(await jobs()).toEqual([]);
  } finally {
    await scope.dispose();
    await sql.close();
  }
});

test.skipIf(!enabled)("stage 4: a user task appears in the inbox of its assignees; claim, release and complete", async () => {
  await publish("approval", doc({
    Start: { kind: "manualStart", title: "Start" },
    Approve: { kind: "userTask", title: "Approve the purchase", config: { assignee: { role: "boss" }, form: { fields: [{ code: "ok", type: "boolean", required: true }] }, dueIn: "P1D" } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" } }));
  const boss = (user: string) => as(user, { "x-roles": "boss" });
  const id = (await call("POST", "/workflow/instances", { processKey: "approval" })).body.id;
  let inbox: { status: number; body: { data: { id: string; instanceId: string; status: string; assignee: string; title: string }[] } } = { status: 0, body: { data: [] } };
  for (let i = 0; i < 100 && !inbox.body.data.some((t) => t.instanceId === id); i++) {
    inbox = await call("GET", "/workflow/tasks", undefined, boss("anna"));
    await Bun.sleep(30);
  }
  const task = inbox.body.data.find((t) => t.instanceId === id)!;
  expect(task).toMatchObject({ status: "open", assignee: "role:boss", title: "Approve the purchase" });
  expect((await call("GET", "/workflow/tasks", undefined, as("clerk"))).body.data.some((t: { id: string }) => t.id === task.id)).toBe(false);
  expect((await call("GET", `/workflow/tasks/${task.id}`, undefined, as("clerk"))).status).toBe(404);

  expect((await call("POST", `/workflow/tasks/${task.id}/claim`, {}, boss("anna"))).body).toMatchObject({ status: "claimed", claimedBy: "anna" });
  expect((await call("POST", `/workflow/tasks/${task.id}/claim`, {}, boss("boris"))).status).toBe(409);
  expect((await call("POST", `/workflow/tasks/${task.id}/complete`, { output: { ok: true } }, boss("boris"))).status).toBe(409);
  expect((await call("GET", `/workflow/tasks/${task.id}`, undefined, as("anna"))).body.status).toBe("claimed");
  expect((await call("POST", `/workflow/tasks/${task.id}/release`, {}, boss("anna"))).body.status).toBe("open");

  const invalid = await call("POST", `/workflow/tasks/${task.id}/complete`, { output: {} }, boss("boris"));
  expect(invalid.status).toBe(422);
  expect(invalid.body.details.issues).toEqual([expect.objectContaining({ field: "ok", code: "required" })]);
  const done = await call("POST", `/workflow/tasks/${task.id}/complete`, { output: { ok: true } }, boss("boris"));
  expect(done.body).toMatchObject({ status: "completed", completedBy: "boris", output: { ok: true } });
  expect((await call("GET", `/workflow/instances/${id}`)).body.status).toBe("completed");
  expect((await call("POST", `/workflow/tasks/${task.id}/complete`, { output: { ok: true } }, boss("boris"))).status).toBe(409);
});

test.skipIf(!enabled)("stage 4: a cancelled instance cancels its task; a task for a person is theirs only", async () => {
  await publish("personal", doc({
    Start: { kind: "manualStart", title: "Start" },
    Sign: { kind: "userTask", title: "Sign", config: { assignee: { user: "clara" } } },
    End: { kind: "end", title: "End" },
  }, { a: { source: "Start", target: "Sign" }, b: { source: "Sign", target: "End" } }));
  const id = (await call("POST", "/workflow/instances", { processKey: "personal" })).body.id;
  let mine: { id: string; instanceId: string }[] = [];
  for (let i = 0; i < 100 && !mine.some((t) => t.instanceId === id); i++) {
    mine = (await call("GET", "/workflow/tasks", undefined, as("clara"))).body.data;
    await Bun.sleep(30);
  }
  const task = mine.find((t) => t.instanceId === id)!;
  expect((await call("GET", `/workflow/tasks/${task.id}`, undefined, as("boris", { "x-roles": "boss" }))).status).toBe(404);
  await call("POST", `/workflow/instances/${id}/cancel`, { reason: "not needed" });
  let status = "";
  for (let i = 0; i < 100 && status !== "cancelled"; i++) {
    status = (await call("GET", `/workflow/tasks/${task.id}`, undefined, as("clara"))).body.status;
    await Bun.sleep(30);
  }
  expect(status).toBe("cancelled");
  expect((await call("GET", "/workflow/tasks", undefined, as("clara"))).body.data.some((t: { id: string }) => t.id === task.id)).toBe(false);
});

test.skipIf(!enabled)("retention deletes finished instances older than the process keeps them", async () => {
  const sql = postgres({ url });
  try {
    await sql.execute(`UPDATE "bazis_wf_run_instances" SET "endedAt" = now() - interval '40 days' WHERE "processKey" = 'order' AND status = 'completed'`, []);
    const retention = app.container.resolve(WorkflowRetention);
    await sql.execute(`UPDATE "bazis_wf_run_instances" SET "endedAt" = now() - interval '40 days' WHERE "processKey" = 'approval'`, []);
    await call("PATCH", "/workflow/processes/approval", { retentionDays: 30 });
    expect(await retention.sweep()).toBe(3);
    // The task of the deleted approval instance went with it.
    expect(await sql.query(`SELECT 1 FROM "bazis_wf_task_items" WHERE "processKey" = 'approval'`, [])).toEqual([]);
    const left = (await sql.query(`SELECT status FROM "bazis_wf_run_instances" WHERE "processKey" = 'order' ORDER BY status`, [])) as { status: string }[];
    expect(left.map((row) => row.status)).toEqual(["cancelled"]);
    expect(await sql.query(`SELECT 1 FROM "bazis_wf_run_tokens" t LEFT JOIN "bazis_wf_run_instances" i ON i.id = t."instanceId" WHERE i.id IS NULL`, [])).toEqual([]);
  } finally {
    await sql.close();
  }
});

test.skipIf(!enabled)("a second start checks the stores and keeps the data", async () => {
  await app.stop();
  app = await startTestApp(root(url!));
  expect((await call("GET", "/workflow/processes/order")).body.latestVersion).toBe(1);
});
