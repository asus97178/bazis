import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { AccessPolicy, type AccessSubject, type Grants, type Scope, type ScopePrincipals } from "@/core/access";
import { TOOL_EXECUTION_OPTIONS, Tool, type AgentToolExecutionContext } from "@/core/agent";
import { DI, Module, singleton } from "@/core/di";
import type { AuthorizeContext } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { defineProcess, IWorkflowRuntime, WorkflowError, WorkflowModule, type CodeProcess, type InstanceDetails } from "@/core/workflow";
import { testWorkflow, type TestWorkflow } from "@/core/workflow/testing";
import { postgres } from "@/library/orm";
import type { ProcessDocument, ProcessFlow, VariableSpec } from "@/library/workflow";

/**
 * Stage 3 of WORKFLOW-002 on PostgreSQL: loops, called processes and the settings
 * of a run. Runs only against a throwaway database whose name starts with
 * `bazis_wf_`: set `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const calls: { input: Record<string, unknown>; actor: unknown; key: string | undefined }[] = [];
const failing = new Set<unknown>();

@Tool({ name: "runs.note", description: "Remembers the call.", sideEffect: "write", callers: ["workflow"] })
class NoteTool {
  execute(input: Record<string, unknown>, context: AgentToolExecutionContext): Record<string, unknown> {
    calls.push({ input, actor: context.actor, key: context.idempotencyKey });
    if (failing.has(input.value)) throw new Error(`no ${String(input.value)}`);
    return { noted: input.value ?? null };
  }
}

class OpenPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): AccessSubject {
    return { sub: ctx.header("x-user") ?? "u-1" };
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

const task = (title: string, more: Record<string, unknown> = {}) => ({ kind: "userTask", title, config: { assignee: { role: "staff" } }, ...more });
const note = (value: unknown, more: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({ kind: "serviceTask", title: "Note", config: { tool: "runs.note", input: { value }, ...config }, ...more });
const start = { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" } };

/** Flows through the ids in order. */
const through = (prefix: string, ...ids: string[]): Record<string, ProcessFlow> => Object.fromEntries(ids.slice(1).map((id, index) => [`${prefix}${index}`, { source: ids[index]!, target: id }]));

function define(key: string, nodes: Record<string, unknown>, flows: Record<string, ProcessFlow>, extra: { variables?: VariableSpec[]; settings?: ProcessDocument["settings"] } = {}): CodeProcess {
  return defineProcess({ key, title: key, document: { schemaVersion: "bazis.workflow/v2", nodes: { ...start, ...nodes } as ProcessDocument["nodes"], flows, ...extra } });
}

/** Start → the ids → End. */
const line = (key: string, nodes: Record<string, unknown>, extra: { variables?: VariableSpec[]; settings?: ProcessDocument["settings"] } = {}): CodeProcess => define(key, nodes, through("f", "Start", ...Object.keys(nodes), "End"), extra);

const items: VariableSpec = { name: "items", type: "list", direction: "in" };
const out = (name: string, type: VariableSpec["type"] = "list"): VariableSpec => ({ name, type, direction: "out" });

/** A loop over `$input.items` whose body is `Inner`, then its end. */
function overItems(key: string, inner: unknown, config: Record<string, unknown> = {}, extra: { variables?: VariableSpec[]; settings?: ProcessDocument["settings"]; nodes?: Record<string, unknown>; flows?: Record<string, ProcessFlow> } = {}): CodeProcess {
  return define(
    key,
    { Loop: { kind: "loop", title: "Loop", config: { over: { path: "$input.items" }, maxIterations: 300, ...config } }, Inner: { ...(inner as object), parent: "Loop" }, BodyEnd: { kind: "end", title: "Done", parent: "Loop" }, ...extra.nodes },
    { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" }, c: { source: "Inner", target: "BodyEnd" }, ...extra.flows },
    { variables: extra.variables ?? [items], ...(extra.settings === undefined ? {} : { settings: extra.settings }) },
  );
}

const PROCESSES: CodeProcess[] = [
  overItems("collects", note({ path: "$item.id" }, {}, { saveTo: "saved" }), { item: "order", index: "at", collect: { from: { op: "concat", args: [{ path: "$vars.order.id" }, "#", { path: "$vars.at" }, ":", { path: "$vars.saved.noted" }, ":", { path: "$nodes.Inner.noted" }] }, to: "seen" } }, { variables: [items, out("seen")] }),
  overItems("in-parallel", task("Check"), { parallel: { limit: 2 } }),
  overItems("over-text", note("x"), { over: { path: "$input.text" } }, { variables: [{ name: "text", type: "string", direction: "in" }] }),
  overItems("many", { kind: "assign", title: "Add", config: { assignments: [{ var: "count", value: { op: "add", args: [{ op: "coalesce", args: [{ path: "$vars.count" }, 0] }, 1] } }] } }, {}, { variables: [items, out("count", "number")] }),
  overItems("skips", note({ path: "$item" }), { onItemError: "skip", collect: { from: { path: "$item" }, to: "good" } }, { variables: [items, out("good")] }),
  overItems("stops", note({ path: "$item" })),
  overItems("stops-parallel", note({ path: "$item" }), { parallel: { limit: 2 } }),
  overItems("caught", note({ path: "$item" }), {}, {
    nodes: { Oops: { kind: "boundaryError", title: "Oops", attachedTo: "Loop" } },
    flows: { d: { source: "Oops", target: "End" } },
  }),
  overItems("waits-too-long", task("Check"), {}, {
    nodes: { Late: { kind: "boundaryTimer", title: "Late", attachedTo: "Loop", config: { duration: "PT1H" } } },
    flows: { d: { source: "Late", target: "End" } },
  }),
  define(
    "counts",
    {
      First: { kind: "assign", title: "Zero", config: { assignments: [{ var: "count", value: 0 }] } },
      Loop: { kind: "loop", title: "Loop", config: { while: { op: "lt", args: [{ path: "$vars.count" }, { path: "$input.until" }] }, maxIterations: 3 } },
      Inner: { kind: "assign", title: "Add", parent: "Loop", config: { assignments: [{ var: "count", value: { op: "add", args: [{ path: "$vars.count" }, 1] } }] } },
      BodyEnd: { kind: "end", title: "Done", parent: "Loop" },
    },
    { a: { source: "Start", target: "First" }, b: { source: "First", target: "Loop" }, c: { source: "Loop", target: "End" }, d: { source: "Inner", target: "BodyEnd" } },
    { variables: [{ name: "until", type: "number", direction: "in" }, out("count", "number")] },
  ),
  define(
    "branches",
    {
      Loop: { kind: "loop", title: "Loop", config: { times: 2, maxIterations: 2, parallel: { limit: 2 }, collect: { from: { op: "concat", args: [{ path: "$index" }, "=", { path: "$vars.left.value" }, "+", { path: "$vars.right.value" }] }, to: "joined" } } },
      Split: { kind: "parallelGateway", title: "Split", parent: "Loop" },
      Left: { ...task("Left", { parent: "Loop" }), config: { assignee: { role: "staff" }, form: { fields: [{ name: "value", type: "string" }] }, saveTo: "left" } },
      Right: { ...task("Right", { parent: "Loop" }), config: { assignee: { role: "staff" }, form: { fields: [{ name: "value", type: "string" }] }, saveTo: "right" } },
      Join: { kind: "parallelGateway", title: "Join", parent: "Loop" },
      BodyEnd: { kind: "end", title: "Done", parent: "Loop" },
    },
    {
      a: { source: "Start", target: "Loop" },
      b: { source: "Loop", target: "End" },
      c: { source: "Split", target: "Left" },
      d: { source: "Split", target: "Right" },
      e: { source: "Left", target: "Join" },
      f: { source: "Right", target: "Join" },
      g: { source: "Join", target: "BodyEnd" },
    },
    { variables: [out("joined")] },
  ),
  define(
    "nested",
    {
      Rows: { kind: "loop", title: "Rows", config: { over: { path: "$input.items" }, item: "row", maxIterations: 5 } },
      Cells: { kind: "loop", title: "Cells", parent: "Rows", config: { over: { path: "$vars.row.cells" }, maxIterations: 5 } },
      Note: { ...note({ op: "concat", args: [{ path: "$vars.row.name" }, "/", { path: "$item" }] }), parent: "Cells" },
      CellEnd: { kind: "end", title: "Done", parent: "Cells" },
      RowEnd: { kind: "end", title: "Done", parent: "Rows" },
    },
    { a: { source: "Start", target: "Rows" }, b: { source: "Rows", target: "End" }, c: { source: "Cells", target: "RowEnd" }, d: { source: "Note", target: "CellEnd" } },
    { variables: [items] },
  ),

  line("child", { Work: note({ path: "$input.value" }, {}, { saveTo: "result" }) }, { variables: [{ name: "value", type: "string", direction: "in", required: true }, out("result", "object")] }),
  line("child-steps", { One: note("one"), Two: note({ path: "$input.value" }) }, { variables: [{ name: "value", type: "string", direction: "in" }] }),
  line("child-waits", { Check: task("Check") }),
  line("calls", { Call: { kind: "callProcess", title: "Call", config: { process: "child", input: { value: { path: "$input.value" } }, saveTo: "answer" } } }, { variables: [{ name: "value", type: "string", direction: "in" }, out("answer", "object")] }),
  line("calls-steps", { Call: { kind: "callProcess", title: "Call", config: { process: "child-steps", input: { value: { path: "$input.value" } } } } }, { variables: [{ name: "value", type: "string", direction: "in" }] }),
  line("calls-waits", { Call: { kind: "callProcess", title: "Call", config: { process: "child-waits" } } }),
  define(
    "calls-caught",
    { Call: { kind: "callProcess", title: "Call", config: { process: "child-steps", input: { value: { path: "$input.value" } } } }, Oops: { kind: "boundaryError", title: "Oops", attachedTo: "Call", config: { errorCode: "child_failed" } } },
    { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" }, c: { source: "Oops", target: "End" } },
    { variables: [{ name: "value", type: "string", direction: "in" }] },
  ),
  line("calls-skips", { Call: { kind: "callProcess", title: "Call", config: { process: "child-steps", input: { value: { path: "$input.value" } }, onError: "skip", saveTo: "answer" } } }, { variables: [{ name: "value", type: "string", direction: "in" }, out("answer", "object")] }),
  line("calls-bad-input", { Call: { kind: "callProcess", title: "Call", config: { process: "child" } } }),
  overItems("calls-in-loop", { kind: "callProcess", title: "Call", config: { process: "child", input: { value: { path: "$item" } }, saveTo: "answer" } }, { parallel: { limit: 3 }, collect: { from: { path: "$vars.answer.result.noted" }, to: "answers" } }, { variables: [items, out("answers")] }),
  line("calls-itself", { Call: { kind: "callProcess", title: "Call", config: { process: "calls-itself" } } }),

  line("as-starter", { Work: note("a") }),
  line("as-process", { Work: note("a"), Call: { kind: "callProcess", title: "Call", config: { process: "as-starter" } } }, { settings: { runAs: "process" } }),

  line("handler", { Work: note({ path: "$event.processKey" }, {}, { saveTo: "about" }) }, { variables: [out("about", "object")] }),
  line("timed", { Check: task("Check") }, { settings: { runTimeout: "PT1H", errorHandler: "handler" } }),
  line("timed-call", { Call: { kind: "callProcess", title: "Call", config: { process: "child-waits" } } }, { settings: { runTimeout: "PT1H" } }),
  line("fast-enough", { Work: note("fast") }, { settings: { runTimeout: "PT1H" } }),
  line("fails-handled", { Work: note("boom") }, { settings: { errorHandler: "handler" } }),
  line("handler-fails", { Work: note("boom") }, { settings: { errorHandler: "handler-fails" } }),

  line("one-at-a-time", { Check: task("Check") }, { settings: { maxConcurrent: 1 } }),
  line("key-skips", { Check: task("Check") }, { settings: { sameKey: "skip" } }),
  line("key-queues", { Check: task("Check") }, { settings: { sameKey: "queue" } }),
  line("key-free", { Check: task("Check") }),
  define("event-key", { Begin: { kind: "eventStart", title: "Begin", config: { event: "runs.keyed" } }, Check: task("Check") }, { b: { source: "Begin", target: "Check" }, c: { source: "Check", target: "End" }, a: { source: "Start", target: "Check" } }, { settings: { sameKey: "skip" } }),
  line("many-input", { Check: task("Check") }, { settings: { sameKey: "skip" }, variables: [{ name: "n", type: "number", direction: "in", required: true }] }),
];

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfruns", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    tools: [NoteTool],
    processes: PROCESSES,
    providers: [
      singleton(AccessPolicy, OpenPolicy),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
    ],
  })
  class AppModule {}
  return AppModule;
}

let wf: TestWorkflow;

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
  wf = await testWorkflow(root(url!), { now: "2026-11-02T09:00:00Z" });
});

afterAll(async () => {
  if (enabled) await wf.stop();
});

const inScope = async <T>(work: (runtime: IWorkflowRuntime) => Promise<T>): Promise<T> => {
  const scope = wf.app.container.createScope();
  try {
    return await work(scope.resolve(IWorkflowRuntime));
  } finally {
    await scope.dispose();
  }
};
const ACTOR = { kind: "user", id: "u-7" } as const;

async function run(key: string, input: unknown = {}, businessKey?: string): Promise<InstanceDetails> {
  const started = await wf.start(key, { input, actor: ACTOR, ...(businessKey === undefined ? {} : { businessKey }) });
  await wf.drain();
  return await wf.instance(started.id);
}
const waitingAt = (instance: InstanceDetails, nodeId: string) => instance.tokens.filter((t) => t.status === "waiting" && t.nodeId === nodeId);
const noted = () => calls.map((call) => call.input.value);
const childrenOf = async (id: string) => (await inScope((runtime) => runtime.instances({ parentInstanceId: id }))).items;
const reset = () => {
  calls.length = 0;
  failing.clear();
};

test.skipIf(!enabled)("a loop runs its body once per element; what an iteration keeps stays in it", async () => {
  reset();
  const done = await run("collects", { items: [{ id: "a" }, { id: "b" }] });
  expect(done.status).toBe("completed");
  expect(noted()).toEqual(["a", "b"]);
  // The element under its name, the number, `saveTo` and `$nodes` of that iteration, in order.
  expect(done.output).toEqual({ seen: ["a#0:a:a", "b#1:b:b"] });
  expect(done.nodes.Loop).toEqual({ iterations: 2, skipped: 0 });
  expect(done.nodes.Inner).toBeUndefined();
  expect(done.vars.saved).toBeUndefined();
  // Each iteration has its token and so its idempotency key.
  expect(new Set(calls.map((call) => call.key)).size).toBe(2);
  expect(done.tokens.filter((t) => t.nodeId === "Inner").map((t) => t.iteration)).toEqual([0, 1]);
});

test.skipIf(!enabled)("an empty or a missing list runs no iteration; something else fails the step", async () => {
  reset();
  expect((await run("stops", { items: [] })).status).toBe("completed");
  expect((await run("stops", {})).status).toBe("completed");
  expect(noted()).toEqual([]);
  const bad = await run("over-text", { text: "not a list" });
  expect(bad.status).toBe("failed");
  expect(bad.error).toMatchObject({ node: "Loop", code: "loop_not_a_list" });
});

test.skipIf(!enabled)("parallel: no more iterations at once than the limit, the next begins when one ends", async () => {
  const started = await run("in-parallel", { items: [1, 2, 3] });
  expect(waitingAt(started, "Inner").map((t) => t.iteration)).toEqual([0, 1]);
  const after = await wf.complete(started.id, "Inner");
  expect(waitingAt(after, "Inner").map((t) => t.iteration)).toEqual([1, 2]);
  await wf.complete(started.id, "Inner");
  const done = await wf.complete(started.id, "Inner");
  expect(done.status).toBe("completed");
  expect(done.nodes.Loop).toEqual({ iterations: 3, skipped: 0 });
});

test.skipIf(!enabled)("a body without waits goes in batches: one transaction does not take all iterations", async () => {
  const started = await wf.start("many", { input: { items: Array.from({ length: 250 }, (_, index) => index) }, actor: ACTOR });
  // The first batch ran in the start, the rest waits for the worker.
  const first = await wf.instance(started.id);
  expect(first.status).toBe("running");
  expect(first.vars.count).toBe(100);
  await wf.drain();
  const done = await wf.instance(started.id);
  expect(done.status).toBe("completed");
  expect(done.output).toEqual({ count: 250 });
});

test.skipIf(!enabled)("while looks before each iteration; past maxIterations the loop fails", async () => {
  const done = await run("counts", { until: 3 });
  expect(done.status).toBe("completed");
  expect(done.output).toEqual({ count: 3 });
  const over = await run("counts", { until: 5 });
  expect(over.status).toBe("failed");
  expect(over.error).toMatchObject({ node: "Loop", code: "loop_limit" });
});

test.skipIf(!enabled)("too many elements fail at the start of the loop", async () => {
  const over = await run("stops", { items: Array.from({ length: 301 }, () => "x") });
  expect(over.status).toBe("failed");
  expect(over.error?.code).toBe("loop_limit");
});

test.skipIf(!enabled)("onItemError skip: the iteration drops and the loop goes on", async () => {
  reset();
  failing.add("bad");
  const done = await run("skips", { items: ["a", "bad", "c"] });
  expect(done.status).toBe("completed");
  expect(done.nodes.Loop).toEqual({ iterations: 3, skipped: 1 });
  expect(done.output).toEqual({ good: ["a", "c"] });
  expect((await wf.history(done.id)).filter((entry) => entry.type === "skipped").map((entry) => entry.data?.iteration)).toEqual([1]);
});

test.skipIf(!enabled)("onItemError stop: the instance fails at the step, and a retry goes on from there", async () => {
  reset();
  failing.add("bad");
  const failed = await run("stops", { items: ["a", "bad", "c"] });
  expect(failed.status).toBe("failed");
  expect(failed.error?.node).toBe("Inner");
  expect(noted()).toEqual(["a", "bad"]);
  failing.clear();
  await inScope((runtime) => runtime.retry(failed.id, { actor: ACTOR }));
  await wf.drain();
  const done = await wf.instance(failed.id);
  expect(done.status).toBe("completed");
  expect(noted()).toEqual(["a", "bad", "bad", "c"]);
  // The same token again: the same idempotency key.
  expect(calls[1]!.key).toBe(calls[2]!.key);
});

test.skipIf(!enabled)("a retry brings back what the failure stopped: the other iterations of a parallel loop go on", async () => {
  reset();
  failing.add("bad");
  const failed = await run("stops-parallel", { items: ["bad", "good", "next"] });
  expect(failed.status).toBe("failed");
  // The job of the other iteration found the instance stopped and dropped.
  expect(waitingAt(failed, "Inner").map((t) => t.iteration)).toEqual([1]);
  failing.clear();
  await inScope((runtime) => runtime.retry(failed.id, { actor: ACTOR }));
  await wf.drain();
  const done = await wf.instance(failed.id);
  expect(done.status).toBe("completed");
  expect(done.nodes.Loop).toEqual({ iterations: 3, skipped: 0 });
});

test.skipIf(!enabled)("an error boundary on the loop takes the failure of its body", async () => {
  reset();
  failing.add("bad");
  const done = await run("caught", { items: ["bad", "never"] });
  expect(done.status).toBe("completed");
  expect(noted()).toEqual(["bad"]);
  expect(done.tokens.filter((t) => t.nodeId === "Oops").length).toBe(1);
});

test.skipIf(!enabled)("a boundary timer on the loop closes what runs inside it", async () => {
  const started = await run("waits-too-long", { items: [1, 2] });
  expect(waitingAt(started, "Inner").length).toBe(1);
  await wf.advance("PT2H");
  const done = await wf.instance(started.id);
  expect(done.status).toBe("completed");
  expect(done.tokens.filter((t) => t.nodeId === "Inner").map((t) => t.status)).toEqual(["cancelled"]);
});

test.skipIf(!enabled)("branches of one iteration meet at a join; iterations do not mix", async () => {
  const started = await run("branches");
  expect(waitingAt(started, "Left").length).toBe(2);
  const token = (instance: InstanceDetails, node: string, iteration: number) => instance.tokens.find((t) => t.nodeId === node && t.iteration === iteration && t.status === "waiting")!.id;
  const complete = (id: string, value: string) => inScope((runtime) => runtime.completeToken(id, { value }, ACTOR));
  await complete(token(started, "Left", 1), "l1");
  await complete(token(started, "Right", 0), "r0");
  const middle = await wf.instance(started.id);
  // Neither iteration is whole: Left of 1 and Right of 0 must not make a join.
  expect(middle.tokens.filter((t) => t.nodeId === "Join" && t.status === "waiting").length).toBe(2);
  await complete(token(started, "Left", 0), "l0");
  const done = await complete(token(started, "Right", 1), "r1");
  expect(done.status).toBe("completed");
  expect(done.output).toEqual({ joined: ["0=l0+r0", "1=l1+r1"] });
});

test.skipIf(!enabled)("loops nest: the inner one sees what the outer one gave", async () => {
  reset();
  const done = await run("nested", { items: [{ name: "x", cells: [1, 2] }, { name: "y", cells: [3] }] });
  expect(done.status).toBe("completed");
  expect(noted()).toEqual(["x/1", "x/2", "y/3"]);
});

test.skipIf(!enabled)("callProcess: the step waits for the child and gets its out variables", async () => {
  reset();
  const done = await run("calls", { value: "v" });
  expect(done.status).toBe("completed");
  expect(done.output).toEqual({ answer: { result: { noted: "v" } } });
  const [child] = await childrenOf(done.id);
  expect(child).toMatchObject({ processKey: "child", status: "completed", parentInstanceId: done.id, startedVia: "callProcess", startedBy: ACTOR });
  const trigger = (await wf.history(done.id)).find((entry) => entry.type === "called");
  expect(trigger?.data).toMatchObject({ process: "child", instanceId: child!.id });
});

test.skipIf(!enabled)("callProcess: input the child refuses fails the step", async () => {
  const failed = await run("calls-bad-input");
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ node: "Call", code: "invalid_input" });
  expect(await childrenOf(failed.id)).toEqual([]);
});

test.skipIf(!enabled)("callProcess: a failed child fails the caller; the caller's retry resumes the child, its finished steps do not repeat", async () => {
  reset();
  failing.add("bad");
  const failed = await run("calls-steps", { value: "bad" });
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ node: "Call", code: "child_failed" });
  const [child] = await childrenOf(failed.id);
  expect(child!.status).toBe("failed");
  // The child goes through its caller.
  await expect(inScope((runtime) => runtime.retry(child!.id, { actor: ACTOR }))).rejects.toThrow(/retry that one/);

  failing.clear();
  await inScope((runtime) => runtime.retry(failed.id, { actor: ACTOR }));
  await wf.drain();
  expect((await wf.instance(failed.id)).status).toBe("completed");
  expect(noted()).toEqual(["one", "bad", "bad"]);
  expect((await childrenOf(failed.id)).length).toBe(1);
  expect((await wf.instance(child!.id)).status).toBe("completed");
});

test.skipIf(!enabled)("callProcess: an error boundary takes the child's failure, the child closes", async () => {
  reset();
  failing.add("bad");
  const done = await run("calls-caught", { value: "bad" });
  expect(done.status).toBe("completed");
  expect(done.nodes.Oops).toMatchObject({ code: "child_failed", reason: "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN" });
  const [child] = await childrenOf(done.id);
  expect(child!.status).toBe("cancelled");
});

test.skipIf(!enabled)("callProcess: onError skip moves on", async () => {
  reset();
  failing.add("bad");
  const done = await run("calls-skips", { value: "bad" });
  expect(done.status).toBe("completed");
  expect(done.output?.answer).toMatchObject({ skipped: true, error: { code: "child_failed" } });
  expect((await childrenOf(done.id))[0]!.status).toBe("cancelled");
});

test.skipIf(!enabled)("callProcess: cancelling the caller cancels the child; cancelling the child fails the caller", async () => {
  const caller = await run("calls-waits");
  const [child] = await childrenOf(caller.id);
  expect(child!.status).toBe("running");
  await inScope((runtime) => runtime.cancel(caller.id, { actor: ACTOR, reason: "enough" }));
  await wf.drain();
  expect((await wf.instance(child!.id)).status).toBe("cancelled");

  const second = await run("calls-waits");
  const [other] = await childrenOf(second.id);
  await inScope((runtime) => runtime.cancel(other!.id, { actor: ACTOR }));
  await wf.drain();
  const stopped = await wf.instance(second.id);
  expect(stopped.status).toBe("failed");
  expect(stopped.error?.code).toBe("child_cancelled");

  // A cancelled child is called anew by the retry.
  await inScope((runtime) => runtime.retry(second.id, { actor: ACTOR }));
  await wf.drain();
  const children = await childrenOf(second.id);
  expect(children.map((item) => item.status).sort()).toEqual(["cancelled", "running"]);
});

test.skipIf(!enabled)("callProcess in a parallel loop: each iteration has its child and its answer", async () => {
  reset();
  const done = await run("calls-in-loop", { items: ["a", "b", "c", "d"] });
  expect(done.status).toBe("completed");
  expect(done.output).toEqual({ answers: ["a", "b", "c", "d"] });
  expect((await childrenOf(done.id)).length).toBe(4);
});

test.skipIf(!enabled)("a process that calls itself stops at the depth limit", async () => {
  const top = await run("calls-itself");
  expect(top.status).toBe("failed");
  let current = top;
  let depth = 0;
  for (;;) {
    const [child] = await childrenOf(current.id);
    if (!child) break;
    current = await wf.instance(child.id);
    depth += 1;
  }
  expect(depth).toBe(16);
  expect(current.error?.code).toBe("call_depth");
});

test.skipIf(!enabled)("runAs: steps act for who started or for the process; a called process takes it over", async () => {
  reset();
  await run("as-starter");
  expect(calls[0]!.actor).toMatchObject({ kind: "user", id: "u-7" });
  reset();
  const done = await run("as-process");
  expect(calls.map((call) => call.actor)).toEqual([{ kind: "system", id: "process:as-process" }, { kind: "system", id: "process:as-process" }] as never);
  expect((await childrenOf(done.id))[0]!.startedBy).toEqual({ kind: "system", id: "process:as-process" });
});

test.skipIf(!enabled)("runTimeout: the run ends as timedOut with what it waited for, and the handler starts with $event", async () => {
  reset();
  const started = await run("timed");
  expect(started.status).toBe("running");
  await wf.advance("PT59M");
  expect((await wf.instance(started.id)).status).toBe("running");
  await wf.advance("PT2M");
  const over = await wf.instance(started.id);
  expect(over.status).toBe("timedOut");
  expect(over.error?.code).toBe("run_timeout");
  expect(over.endedAt).not.toBeNull();
  expect(over.tokens.every((t) => t.status === "done" || t.status === "cancelled")).toBe(true);
  expect(noted()).toEqual(["timed"]);
  const note = (await wf.history(started.id)).find((entry) => entry.type === "handler");
  const handler = await wf.instance(note!.data!.instanceId as string);
  expect(handler).toMatchObject({ processKey: "handler", status: "completed", startedVia: "errorHandler" });
  await expect(inScope((runtime) => runtime.retry(started.id, { actor: ACTOR }))).rejects.toThrow(/Only a failed instance/);
});

test.skipIf(!enabled)("runTimeout: the called process closes with its caller, and a run in time leaves no job behind", async () => {
  const started = await run("timed-call");
  const [child] = await childrenOf(started.id);
  await wf.advance("PT2H");
  expect((await wf.instance(started.id)).status).toBe("timedOut");
  expect((await wf.instance(child!.id)).status).toBe("cancelled");

  const fast = await run("fast-enough");
  expect(fast.status).toBe("completed");
  expect(await wf.advance("PT2H")).toBe(0);
});

test.skipIf(!enabled)("errorHandler: a failure starts it; a handler that fails does not start another", async () => {
  reset();
  failing.add("boom");
  const failed = await run("fails-handled");
  expect(failed.status).toBe("failed");
  const note = (await wf.history(failed.id)).find((entry) => entry.type === "handler");
  const handler = await wf.instance(note!.data!.instanceId as string);
  expect(handler.status).toBe("completed");
  expect(handler.output).toEqual({ about: { noted: "fails-handled" } });

  const chain = await run("handler-fails");
  expect(chain.status).toBe("failed");
  const first = (await wf.history(chain.id)).find((entry) => entry.type === "handler")!.data!.instanceId as string;
  const second = await wf.instance(first);
  expect(second).toMatchObject({ status: "failed", startedVia: "errorHandler" });
  expect((await wf.history(second.id)).some((entry) => entry.type === "handler")).toBe(false);
});

test.skipIf(!enabled)("maxConcurrent: the rest wait as pending and start in order when a place is free", async () => {
  const first = await run("one-at-a-time");
  const second = await run("one-at-a-time");
  const third = await run("one-at-a-time");
  expect([first.status, second.status, third.status]).toEqual(["running", "pending", "pending"]);
  expect(second.tokens.map((t) => t.nodeId)).toEqual(["Start"]);

  // A pending one can be cancelled: it never runs.
  await inScope((runtime) => runtime.cancel(second.id, { actor: ACTOR }));
  await wf.complete(first.id, "Check");
  await wf.drain();
  const released = await wf.instance(third.id);
  expect(released.status).toBe("running");
  expect(waitingAt(released, "Check").length).toBe(1);
  await wf.complete(third.id, "Check");
  await wf.drain();
});

test.skipIf(!enabled)("maxConcurrent holds under starts at the same moment", async () => {
  const before = (await inScope((runtime) => runtime.instances({ processKey: "one-at-a-time", status: "running" }))).total;
  expect(before).toBe(0);
  const started = await Promise.all(Array.from({ length: 8 }, () => wf.start("one-at-a-time", { actor: ACTOR })));
  expect(started.filter((instance) => instance.status === "running").length).toBe(1);
  expect(started.filter((instance) => instance.status === "pending").length).toBe(7);
  // One after another; nobody jumps over the limit.
  for (let left = started.length; left > 0; left -= 1) {
    const { items } = await inScope((runtime) => runtime.instances({ processKey: "one-at-a-time", status: "running" }));
    expect(items.length).toBe(1);
    await wf.complete(items[0]!.id, "Check");
    await wf.drain();
  }
  expect((await inScope((runtime) => runtime.instances({ processKey: "one-at-a-time", status: "pending" }))).total).toBe(0);
});

test.skipIf(!enabled)("sameKey skip refuses a start while the key is unfinished; other keys and no key go ahead", async () => {
  const first = await run("key-skips", {}, "order:1");
  await expect(wf.start("key-skips", { actor: ACTOR, businessKey: "order:1" })).rejects.toThrow(WorkflowError);
  expect((await run("key-skips", {}, "order:2")).status).toBe("running");
  expect((await run("key-skips")).status).toBe("running");
  expect((await run("key-skips")).status).toBe("running");
  await wf.complete(first.id, "Check");
  expect((await run("key-skips", {}, "order:1")).status).toBe("running");
});

test.skipIf(!enabled)("sameKey queue: the same key waits for the old one, in order; allow runs side by side", async () => {
  const first = await run("key-queues", {}, "k");
  const second = await run("key-queues", {}, "k");
  const third = await run("key-queues", {}, "k");
  const other = await run("key-queues", {}, "other");
  expect([first.status, second.status, third.status, other.status]).toEqual(["running", "pending", "pending", "running"]);
  await wf.complete(first.id, "Check");
  await wf.drain();
  expect((await wf.instance(second.id)).status).toBe("running");
  expect((await wf.instance(third.id)).status).toBe("pending");

  expect((await run("key-free", {}, "k")).status).toBe("running");
  expect((await run("key-free", {}, "k")).status).toBe("running");
});

test.skipIf(!enabled)("an event start obeys sameKey too and says what it skipped", async () => {
  const first = await wf.emit("runs.keyed", {}, { correlation: "e-1" });
  expect(first.started.length).toBe(1);
  const second = await wf.emit("runs.keyed", {}, { correlation: "e-1" });
  expect(second).toMatchObject({ started: [], skipped: [{ processKey: "event-key", instanceId: first.started[0] }] });
});

test.skipIf(!enabled)("startMany: an instance per element, with what became of each", async () => {
  const results = await inScope((runtime) => runtime.startMany("many-input", {
    actor: ACTOR,
    items: [
      { businessKey: "a", input: { n: 1 } },
      { businessKey: "a", input: { n: 2 } },
      { businessKey: "b", input: {} },
      { input: { n: 3 } } as never,
      { businessKey: "c", input: { n: 4 } },
    ],
  }));
  expect(results.map((item) => [item.status, item.businessKey])).toEqual([["started", "a"], ["skipped", "a"], ["rejected", "b"], ["rejected", null], ["started", "c"]]);
  expect(results[0]).toMatchObject({ instanceStatus: "running" });
  expect(results[1]).toMatchObject({ reason: "same_key", instanceId: (results[0] as { instanceId: string }).instanceId });
  expect(results[2]).toMatchObject({ reason: "invalid_input" });
  expect(results[3]).toMatchObject({ reason: "business_key_required" });
  await expect(inScope((runtime) => runtime.startMany("many-input", { actor: ACTOR, items: [] }))).rejects.toThrow(/items must be/);
  expect((await wf.instance((results[4] as { instanceId: string }).instanceId)).status).toBe("running");
});
