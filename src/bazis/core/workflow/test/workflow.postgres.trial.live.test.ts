import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { AccessPolicy, References, type AccessSubject, type Grants, type ReferenceContext, type ReferenceItem, type Scope, type ScopePrincipals } from "@/core/access";
import { TOOL_EXECUTION_OPTIONS, Tool, type AgentToolExecutionContext } from "@/core/agent";
import { Module, scoped, singleton } from "@/core/di";
import { DI } from "@/core/di/lowLevel";
import type { AuthorizeContext } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, OnEvent, secret, withEventSubscribers } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp } from "@/core/testing";
import { ormEntityTools } from "@/core/tools";
import { defineProcess, IWorkflowDefinitions, IWorkflowRuntime, IWorkflowTasks, WORKFLOW_INSTANCE_FINISHED, WORKFLOW_INSTANCE_STARTED, WORKFLOW_PROCESS_CHANGED, WORKFLOW_TASK_COMPLETED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED, WorkflowModule, WorkflowSetupError, type CodeProcess } from "@/core/workflow";
import { WorkflowRetention } from "@/core/workflow/runtime_module/background/WorkflowRetention";
import { dropWorkflowTables, testWorkflow, type TestWorkflow } from "@/core/workflow/testing";
import { Column, DbContext, Entity, UUID, Nullable } from "@/library/orm";
import type { ProcessDocument, ProcessFlow, VariableSpec } from "@/library/workflow";

/**
 * Stage 5 of WORKFLOW-002 on PostgreSQL: trial runs, references and the journal of
 * runs. Runs only against a throwaway database whose name starts with `bazis_wf_`:
 * set `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const written: unknown[] = [];
const dryCalls: unknown[] = [];

const tableInput = {
  type: "object",
  properties: {
    table: { type: "string", "x-ref": "trial.table" },
    field: { type: "string", "x-ref": "trial.field", "x-ref-scope": "/table" },
  },
};

@Tool({ name: "trial.supported", description: "Knows how to try.", sideEffect: "write", dryRun: "supported", callers: ["workflow"], inputSchema: tableInput })
class SupportedTool {
  execute(input: unknown, context: AgentToolExecutionContext): Record<string, unknown> {
    if (context.dryRun === true) {
      dryCalls.push(context.metadata);
      return { wouldWrite: true };
    }
    written.push(input);
    return { wrote: true };
  }
}

@Tool({ name: "trial.unsupported", description: "Always changes something.", sideEffect: "write", callers: ["workflow"] })
class UnsupportedTool {
  execute(input: unknown): Record<string, unknown> {
    written.push(input);
    return { wrote: true };
  }
}

const TABLES: Readonly<Record<string, readonly string[]>> = { orders: ["status", "amount"], users: ["name"] };

class TableReferences extends References {
  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(ids.filter((id) => Object.hasOwn(TABLES, id)));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    return [...await this.exists(ids)].map((id) => ({ id, title: id }));
  }

  async search(): Promise<readonly ReferenceItem[]> {
    return Object.keys(TABLES).map((id) => ({ id, title: id }));
  }
}

class FieldReferences extends References {
  async exists(ids: readonly string[], context: ReferenceContext): Promise<ReadonlySet<string>> {
    return new Set(ids.filter((id) => (context.within === undefined ? false : TABLES[context.within]?.includes(id) === true)));
  }

  async describe(ids: readonly string[], context: ReferenceContext): Promise<readonly ReferenceItem[]> {
    return [...await this.exists(ids, context)].map((id) => ({ id, title: id }));
  }

  async search(): Promise<readonly ReferenceItem[]> {
    return [];
  }
}

const heard: string[] = [];

class Listener {
  @OnEvent(WORKFLOW_INSTANCE_STARTED) started(event: { processKey: string }): void { heard.push(`started:${event.processKey}`); }
  @OnEvent(WORKFLOW_INSTANCE_FINISHED) finished(event: { processKey: string }): void { heard.push(`finished:${event.processKey}`); }
  @OnEvent(WORKFLOW_TASK_REQUESTED) requested(event: { processKey: string }): void { heard.push(`task:${event.processKey}`); }
  @OnEvent(WORKFLOW_TOKEN_CLOSED) closed(): void { heard.push("closed"); }
  @OnEvent(WORKFLOW_TASK_COMPLETED) completed(event: { processKey: string }): void { heard.push(`completed:${event.processKey}`); }
  @OnEvent(WORKFLOW_PROCESS_CHANGED) changed(): void {}
}

class OpenPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): AccessSubject {
    return { sub: ctx.header("x-user") ?? "admin" };
  }

  grants(subject: AccessSubject, permission: string): Grants {
    if (subject.sub === "no-trials" && permission === "workflow.instances.read") return [{ scopes: "all", where: { test: { eq: false } } }];
    return "all";
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [subject.sub];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    return scopes.map((scope) => ({ scope, principals: [`user:${subject.sub}`, "role:staff"] }));
  }
}

const check = { kind: "userTask", title: "Check", config: { assignee: { role: "staff" } } };
const step = (tool: string, input: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({ kind: "serviceTask", title: tool, config: { tool, input, saveTo: "result", ...more } });
const variables: VariableSpec[] = [{ name: "table", type: "string", direction: "in" }, { name: "result", type: "object", direction: "out" }];

function line(key: string, steps: Record<string, unknown>, extra: { settings?: ProcessDocument["settings"]; variables?: VariableSpec[] } = {}): CodeProcess {
  const ids = ["Start", ...Object.keys(steps), "End"];
  const flows: Record<string, ProcessFlow> = Object.fromEntries(ids.slice(1).map((id, index) => [`f${index}`, { source: ids[index]!, target: id }]));
  return defineProcess({ key, title: key, document: { schemaVersion: "bazis.workflow/v2", nodes: { Start: { kind: "manualStart", title: "Start" }, ...steps, End: { kind: "end", title: "End" } } as unknown as ProcessDocument["nodes"], flows, ...extra } });
}

const PROCESSES: CodeProcess[] = [
  line("writes", { Try: step("trial.supported", { table: "orders" }), Next: step("trial.unsupported", { a: 1 }) }, { variables }),
  line("asks", { Check: check }),
  line("limited", { Check: check }, { settings: { maxConcurrent: 1, sameKey: "skip" } }),
  line("parent", { Call: { kind: "callProcess", title: "Call", config: { process: "writes" } } }),
  line("computed-ref", { Try: step("trial.supported", { table: "$input.table", field: "status" }) }, { variables }),
  line("fails", { Try: step("trial.supported", { table: "$input.table" }) }, { variables }),
  line("caught", { Try: step("trial.supported", { table: "$input.table" }) }, { variables }),
];

function connection(dsn: string) {
  const parsed = new URL(dsn);
  return defineConfig(`wftrial${Math.random().toString(36).slice(2, 8)}`, { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
}

function root(dsn: string) {
  const dbConfig = connection(dsn);
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    references: { "trial.table": TableReferences, "trial.field": FieldReferences },
    tools: [SupportedTool, UnsupportedTool],
    processes: PROCESSES,
    providers: [
      scoped(TableReferences),
      scoped(FieldReferences),
      singleton(AccessPolicy, OpenPolicy),
      singleton(Listener),
      ...withEventSubscribers(Listener),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
    ],
  })
  class AppModule {}
  return AppModule;
}

let wf: TestWorkflow;

beforeAll(async () => {
  if (!enabled) return;
  // The database is a throwaway one: its name was checked above.
  await dropWorkflowTables(url!, { force: true });
  wf = await testWorkflow(root(url!), { now: "2026-11-02T09:00:00Z" });
});

afterAll(async () => {
  if (enabled) await wf.stop();
});

const ACTOR = { kind: "user", id: "ann" } as const;
const inScope = async <T>(work: (scope: ReturnType<TestWorkflow["app"]["container"]["createScope"]>) => Promise<T>): Promise<T> => {
  const scope = wf.app.container.createScope();
  try {
    return await work(scope);
  } finally {
    await scope.dispose();
  }
};
const definitions = <T>(work: (service: IWorkflowDefinitions) => Promise<T>) => inScope((scope) => work(scope.resolve(IWorkflowDefinitions)));
const runtime = <T>(work: (service: IWorkflowRuntime) => Promise<T>) => inScope((scope) => work(scope.resolve(IWorkflowRuntime)));
const reset = () => {
  written.length = 0;
  dryCalls.length = 0;
  heard.length = 0;
};

test.skipIf(!enabled)("a trial changes nothing: a Tool that can try tries, the other is not called", async () => {
  reset();
  const started = await wf.start("writes", { test: true, actor: ACTOR, input: {} });
  await wf.drain();
  const done = await wf.instance(started.id);
  expect(done).toMatchObject({ status: "completed", test: true });
  expect(done.nodes).toEqual({ Try: { wouldWrite: true }, Next: { dryRun: true } });
  expect(written).toEqual([]);
  expect(dryCalls).toEqual([expect.objectContaining({ test: true, nodeId: "Try" })]);
  const tools = (await wf.history(done.id)).filter((entry) => entry.type === "tool").map((entry) => entry.data);
  expect(tools).toEqual([
    expect.objectContaining({ tool: "trial.supported", dryRun: "called" }),
    expect.objectContaining({ tool: "trial.unsupported", dryRun: "not called" }),
  ]);
  // A real run is not a trial.
  const real = await wf.start("writes", { actor: ACTOR, input: {} });
  await wf.drain();
  expect((await wf.instance(real.id)).test).toBe(false);
  expect(written.length).toBe(2);
});

test.skipIf(!enabled)("a trial tells the application nothing, and its task goes to who started it", async () => {
  reset();
  const started = await wf.start("asks", { test: true, actor: ACTOR });
  await wf.drain();
  expect(heard).toEqual([]);
  const tasks = await inScope((scope) => scope.resolve(IWorkflowTasks).list({ addressees: [{ scope: null, principals: ["user:ann"] }] }));
  expect(tasks.items).toEqual([expect.objectContaining({ instanceId: started.id, test: true, assignee: "user:ann" })]);
  const others = await inScope((scope) => scope.resolve(IWorkflowTasks).list({ addressees: [{ scope: null, principals: ["role:staff"] }] }));
  expect(others.items).toEqual([]);
  await wf.complete(started.id, "Check", {}, ACTOR);
  await wf.drain();
  expect((await wf.instance(started.id)).status).toBe("completed");
  expect(heard).toEqual([]);

  const dropped = await wf.start("asks", { test: true, actor: ACTOR });
  await wf.drain();
  await runtime((service) => service.cancel(dropped.id, { actor: ACTOR }));
  const left = await inScope((scope) => scope.resolve(IWorkflowTasks).list({ addressees: [{ scope: null, principals: ["user:ann"] }], status: ["open"] }));
  expect(left.items).toEqual([]);
  expect(heard).toEqual([]);

  const real = await wf.start("asks", { actor: ACTOR });
  await wf.drain();
  expect(heard).toEqual(["started:asks", "task:asks"]);
  await wf.complete(real.id, "Check", {}, ACTOR);
});

test.skipIf(!enabled)("a trial takes no place among real runs and waits for no limit", async () => {
  const real = await wf.start("limited", { actor: ACTOR, businessKey: "k" });
  const trial = await wf.start("limited", { test: true, actor: ACTOR, businessKey: "k" });
  expect(trial.status).toBe("running");
  const another = await wf.start("limited", { actor: ACTOR, businessKey: "other" });
  expect(another.status).toBe("pending");
  await wf.complete(trial.id, "Check", {}, ACTOR);
  await wf.drain();
  expect((await wf.instance(another.id)).status).toBe("pending");
  await wf.complete(real.id, "Check", {}, ACTOR);
  await wf.drain();
  expect((await wf.instance(another.id)).status).toBe("running");
  await wf.complete(another.id, "Check", {}, ACTOR);
});

test.skipIf(!enabled)("what a trial calls is a trial too", async () => {
  reset();
  const started = await wf.start("parent", { test: true, actor: ACTOR });
  await wf.drain();
  expect((await wf.instance(started.id)).status).toBe("completed");
  const { items } = await runtime((service) => service.instances({ parentInstanceId: started.id }));
  expect(items).toEqual([expect.objectContaining({ test: true, status: "completed" })]);
  expect(written).toEqual([]);
});

test.skipIf(!enabled)("trials are hidden from lists unless asked for", async () => {
  const keys = async (path: string, user = "admin") => {
    const response = await wf.app.fetch(path, { headers: { "x-user": user } });
    expect(response.status).toBe(200);
    return (await response.json() as { data: { test: boolean }[] }).data.map((item) => item.test);
  };
  const plain = await keys("/workflow/instances?filter[processKey]=writes");
  expect(plain.length).toBeGreaterThan(0);
  expect(plain.every((value) => value === false)).toBe(true);
  const trials = await keys("/workflow/instances?filter[processKey]=writes&filter[test]=true");
  expect(trials.length).toBeGreaterThan(0);
  expect(trials.every((value) => value === true)).toBe(true);
  expect((await wf.app.fetch("/workflow/instances?filter[test]=maybe")).status).toBe(422);
  // A right can leave trials out.
  expect(await keys("/workflow/instances?filter[processKey]=writes&filter[test]=true", "no-trials")).toEqual([]);
  // Started over HTTP.
  const started = await wf.app.fetch("/workflow/instances", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ processKey: "asks", test: true }) });
  expect(started.status).toBe(201);
  const { id, test: isTrial } = await started.json() as { id: string; test: boolean };
  expect(isTrial).toBe(true);
  await runtime((service) => service.cancel(id, { actor: ACTOR }));
});

test.skipIf(!enabled)("a trial lives for a day", async () => {
  const old = await wf.start("writes", { test: true, actor: ACTOR, input: {} });
  await wf.drain();
  const waiting = await wf.start("asks", { test: true, actor: ACTOR });
  await wf.drain();
  const real = await wf.start("writes", { actor: ACTOR, input: {} });
  await wf.drain();
  const retention = new WorkflowRetention(wf.app.container, { get: (key: string) => (key === "retention.batchSize" ? 500 : true) } as never);
  expect(await retention.sweep()).toBe(0);
  // `createdAt` is the clock of the database: the clock of the test goes far past it.
  wf.clock.set(new Date(Date.now() + 2 * 86_400_000));
  expect(await retention.sweep()).toBeGreaterThanOrEqual(2);
  await expect(wf.instance(old.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(wf.instance(waiting.id)).rejects.toMatchObject({ code: "not_found" });
  expect((await wf.instance(real.id)).status).toBe("completed");
  const tasks = await inScope((scope) => scope.resolve(IWorkflowTasks).list({ addressees: [{ scope: null, principals: ["user:ann"] }], status: ["open"] }));
  expect(tasks.items.filter((task) => task.instanceId === waiting.id)).toEqual([]);
});

const document = (input: Record<string, unknown>, extra: Partial<ProcessDocument> = {}) => ({
  schemaVersion: "bazis.workflow/v2",
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Try: { kind: "serviceTask", title: "Try", config: { tool: "trial.supported", input } },
    End: { kind: "end", title: "End" },
  },
  flows: { a: { source: "Start", target: "Try" }, b: { source: "Try", target: "End" } },
  ...extra,
});

test.skipIf(!enabled)("a literal reference nobody knows is broken_ref on its node, and blocks publishing", async () => {
  const issues = await definitions((service) => service.validate(document({ table: "ghosts" })));
  expect(issues.filter((issue) => issue.code === "broken_ref")).toEqual([
    expect.objectContaining({ severity: "error", node: "Try", message: expect.stringContaining('"ghosts"') }),
  ]);
  const wrongField = await definitions((service) => service.validate(document({ table: "orders", field: "name" })));
  expect(wrongField.filter((issue) => issue.code === "broken_ref")).toEqual([expect.objectContaining({ message: expect.stringContaining('"name" in orders') })]);
  const fine = await definitions((service) => service.validate(document({ table: "users", field: "name" })));
  expect(fine.filter((issue) => issue.code === "broken_ref")).toEqual([]);
  const computed = await definitions((service) => service.validate(document({ table: "$input.t", field: "name" }, { variables: [{ name: "t", type: "string", direction: "in" }] })));
  expect(computed.filter((issue) => issue.code === "broken_ref")).toEqual([]);

  await definitions(async (service) => {
    await service.create({ key: "broken", title: "Broken" }, ACTOR);
    const saved = await service.saveDraft("broken", document({ table: "ghosts" }), ACTOR);
    expect(saved.issues.some((issue) => issue.code === "broken_ref")).toBe(true);
    await expect(service.publish("broken", ACTOR)).rejects.toMatchObject({ code: "invalid_document" });
    await service.saveDraft("broken", document({ table: "orders" }), ACTOR);
    expect((await service.publish("broken", ACTOR)).version).toBe(1);
  });
});

test.skipIf(!enabled)("a kind nobody owns is told by name", async () => {
  const issues = await definitions((service) => service.validate({ ...document({ table: "orders" }), variables: [{ name: "x", type: "ref", direction: "in", ref: "nobody.kind", default: "a" }] }));
  expect(issues).toContainEqual(expect.objectContaining({ code: "broken_ref", variable: "x", message: expect.stringContaining("no module owns the reference kind nobody.kind") }));
});

test.skipIf(!enabled)("a computed reference is checked when the step runs", async () => {
  reset();
  const bad = await wf.start("computed-ref", { actor: ACTOR, input: { table: "ghosts" } });
  await wf.drain();
  const failed = await wf.instance(bad.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ node: "Try", code: "ref_not_found" });
  expect(failed.failedNode).toBe("Try");
  expect(written).toEqual([]);
  const wrong = await wf.start("computed-ref", { actor: ACTOR, input: { table: "users" } });
  await wf.drain();
  expect((await wf.instance(wrong.id)).error?.message).toContain('"status"');
  const good = await wf.start("computed-ref", { actor: ACTOR, input: { table: "orders" } });
  await wf.drain();
  expect((await wf.instance(good.id)).status).toBe("completed");
  expect(written.length).toBe(1);
});

test.skipIf(!enabled)("referencing says who refers to a value, by the latest versions", async () => {
  const found = await definitions((service) => service.referencing({ kind: "trial.table", id: "orders" }));
  expect(found.map((item) => [item.processKey, item.node])).toEqual(expect.arrayContaining([["writes", "Try"], ["broken", "Try"]]));
  expect(found[0]!.path).toBe("/table");
  expect(await definitions((service) => service.referencing({ kind: "trial.table", id: "nothing" }))).toEqual([]);
  // A new version takes the place of the old one.
  await definitions(async (service) => {
    await service.saveDraft("broken", document({ table: "users", field: "name" }), ACTOR);
    await service.publish("broken", ACTOR);
  });
  const after = await definitions((service) => service.referencing({ kind: "trial.table", id: "orders" }));
  expect(after.map((item) => item.processKey)).not.toContain("broken");
  expect(await definitions((service) => service.referencing({ kind: "trial.field", id: "name", within: "users" }))).toEqual([expect.objectContaining({ processKey: "broken", node: "Try", version: 2, within: "users", path: "/field" })]);
  expect(await definitions((service) => service.referencing({ kind: "trial.field", id: "name", within: "orders" }))).toEqual([]);
  expect((await definitions((service) => service.referencing({ kind: "workflow.process", id: "writes" }))).map((item) => [item.processKey, item.node])).toEqual([["parent", "Call"]]);
});

test.skipIf(!enabled)("the journal of runs tells how long a run took and where it failed", async () => {
  const started = await wf.start("asks", { actor: ACTOR });
  await wf.drain();
  expect((await wf.instance(started.id)).durationMs).toBeNull();
  wf.clock.advance("PT90S");
  await wf.complete(started.id, "Check", {}, ACTOR);
  await wf.drain();
  const [listed] = (await runtime((service) => service.instances({ processKey: "asks", limit: 1 }))).items;
  expect(listed).toMatchObject({ id: started.id, durationMs: 90_000, failedNode: null, test: false });
});

test.skipIf(!enabled)("the start stops when a Tool refers to a kind no module owns", async () => {
  @Entity({ table: "bazis_wf_trial_notes" })
  class Note {
    @UUID()
    id = "";

    @Nullable()
    @Column({ type: "text" })
    text = "";
  }
  class NotesDbContext extends DbContext {
    readonly notes = this.set(Note);
  }
  const dbConfig = connection(url!);
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    ormBazis: { context: NotesDbContext, entities: [Note], ensureCreated: true },
    tools: [ormEntityTools(Note, { context: NotesDbContext, ops: ["find"], fields: ["text"] })],
    providers: [singleton(AccessPolicy, OpenPolicy)],
  })
  class WithoutOwner {}
  await expect(startTestApp(WithoutOwner, {})).rejects.toThrow(WorkflowSetupError);
  await expect(startTestApp(WithoutOwner, {})).rejects.toThrow("import StandardToolsModule");
});
