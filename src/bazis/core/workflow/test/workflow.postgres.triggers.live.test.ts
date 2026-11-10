import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);
import { AccessPolicy, type AccessSubject, type Grants, type Scope, type ScopePrincipals } from "@/core/access";
import { TOOL_EXECUTION_OPTIONS } from "@/core/agent";
import { DI, Module, singleton } from "@/core/di";
import type { AuthorizeContext } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret, OnEvent, withEventSubscribers } from "@/core/kernel";
import { Column, DbContext, Entity, ormBazisConnect, UUID, Nullable } from "@/core/orm";
import { defineProcess, IWorkflowDefinitions, IWorkflowRuntime, WORKFLOW_PROCESS_CHANGED, WorkflowError, WorkflowModule, WorkflowPartitions, type CodeProcess, type EmitOptions, type EmitResult, type InstanceSummary, type ProcessPartition, type WorkflowProcessChanged } from "@/core/workflow";
import { testWorkflow, type TestWorkflow } from "@/core/workflow/testing";
import { postgres } from "@/library/orm";
import type { ProcessDocument, ProcessFlow, VariableSpec } from "@/library/workflow";

/**
 * Stage 4 of WORKFLOW-002 on PostgreSQL: how processes start and what they wait
 * for, partitions, delivery in the application's transaction, deleting a process.
 * Runs only against a throwaway database whose name starts with `bazis_wf_`: set
 * `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const connected = new Map<string, readonly ProcessPartition[]>();

class TestPartitions extends WorkflowPartitions {
  of(processKey: string): readonly ProcessPartition[] {
    return connected.get(processKey) ?? [{ partition: null, enabled: true }];
  }
}

const changes: WorkflowProcessChanged[] = [];

class ChangesLog {
  @OnEvent(WORKFLOW_PROCESS_CHANGED)
  changed(change: WorkflowProcessChanged): void {
    changes.push(change);
  }
}

class OpenPolicy extends AccessPolicy {
  subject(ctx: AuthorizeContext): AccessSubject {
    return { sub: ctx.header("x-user") ?? "admin" };
  }

  grants(subject: AccessSubject, permission: string): Grants {
    if (subject.sub === "admin") return "all";
    return permission === "workflow.processes.read" ? [{ scopes: [subject.sub] }] : [];
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [subject.sub];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    return scopes.map((scope) => ({ scope, principals: [`user:${subject.sub}`] }));
  }
}

@Entity({ table: "bazis_wf_trigger_rows" })
class TriggerRow {
  @UUID()
  id = "";

  @Nullable()
  @Column({ type: "text" })
  name = "";
}

class TriggerDbContext extends DbContext {
  readonly rows = this.set(TriggerRow);
}

type Extra = { variables?: VariableSpec[]; settings?: ProcessDocument["settings"] };
const check = { kind: "userTask", title: "Check", config: { assignee: { role: "staff" } } };
const noted: VariableSpec = { name: "at", type: "string", direction: "local" };
const scheduledAt = { kind: "assign", title: "Note", config: { assignments: [{ var: "at", value: { path: "$trigger.scheduledAt" } }] } };

/** A start → the steps → the end. */
function define(key: string, startNode: Record<string, unknown>, steps: Record<string, unknown> = {}, extra: Extra = {}): CodeProcess {
  const ids = ["Start", ...Object.keys(steps), "End"];
  const flows: Record<string, ProcessFlow> = Object.fromEntries(ids.slice(1).map((id, index) => [`f${index}`, { source: ids[index]!, target: id }]));
  return defineProcess({ key, title: key, document: { schemaVersion: "bazis.workflow/v2", nodes: { Start: { title: "Start", ...startNode }, ...steps, End: { kind: "end", title: "End" } } as unknown as ProcessDocument["nodes"], flows, ...extra } });
}
const schedule = (config: Record<string, unknown>) => ({ kind: "scheduleStart", config });
const onEvent = (event: string, config: Record<string, unknown> = {}) => ({ kind: "eventStart", config: { event, ...config } });

const PROCESSES: CodeProcess[] = [
  define("zone", schedule({ cron: "0 15 2 11 *", timezone: "Europe/Moscow" }), { Note: scheduledAt }, { variables: [noted] }),
  define("period", schedule({ cron: "0 * 3 11 *", from: "2026-11-03T01:00:00Z", until: "2026-11-03T02:30:00Z" })),
  define("overlap-skip", schedule({ cron: "0 * 4 11 *", overlap: "skip" }), { Check: check }),
  define("overlap-queue", schedule({ cron: "0 * 5 11 *", overlap: "queue" }), { Check: check }),
  define("overlap-parallel", schedule({ cron: "0 * 6 11 *" }), { Check: check }),
  define("catch-up", schedule({ cron: "0 * 7 11 *", catchUp: true }), { Note: scheduledAt }, { variables: [noted] }),
  define("no-catch-up", schedule({ cron: "0 * 7 11 *" }), { Note: scheduledAt }, { variables: [noted] }),
  define("in-all", schedule({ cron: "0 9 8 11 *", partitions: "all" })),
  define("in-listed", schedule({ cron: "0 9 8 11 *", partitions: ["shop-a", "shop-off", "shop-new"] })),
  define("filtered", onEvent("t.placed", { filter: { op: "gt", args: [{ path: "$event.amount" }, 100] } })),
  define("delayed", onEvent("t.later", { delay: "PT1H" }), { Note: { kind: "assign", title: "Note", config: { assignments: [{ var: "seen", value: { path: "$event.n" } }] } } }, { variables: [{ name: "seen", type: "number", direction: "out" }] }),
  define("debounced", onEvent("t.often", { debounce: { key: { path: "$event.id" }, window: "PT10M" } }), { Note: { kind: "assign", title: "Note", config: { assignments: [{ var: "seen", value: { path: "$event.n" } }] } } }, { variables: [{ name: "seen", type: "number", direction: "out" }] }),
  define("own", onEvent("t.own", { ignoreOwn: true }), { Note: { kind: "assign", title: "Note", config: { assignments: [{ var: "cause", value: { path: "$trigger.cause.note" } }] } } }, { variables: [{ name: "cause", type: "string", direction: "out" }] }),
  define("own-other", { kind: "manualStart" }),
  define("connected", onEvent("t.partition")),
  define("no-partitions", onEvent("t.partition")),
  define("waits", { kind: "manualStart" }, { Wait: { kind: "eventWait", title: "Wait", config: { event: "t.changed", correlation: "$input.id", saveTo: "last", until: { op: "eq", args: [{ path: "$event.status" }, { path: "$input.wanted" }] } } } }, { variables: [{ name: "id", type: "string", direction: "in" }, { name: "wanted", type: "string", direction: "in" }, { name: "last", type: "object", direction: "out" }] }),
  define("outbox", onEvent("t.outbox"), {}, { variables: [{ name: "n", type: "number", direction: "in", required: true }] }),
  define("outbox-wait", { kind: "manualStart" }, { Wait: { kind: "eventWait", title: "Wait", config: { event: "t.outbox" } } }),
];

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wftriggers", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    ormBazis: { context: TriggerDbContext, entities: [TriggerRow], ensureCreated: true },
    processes: PROCESSES,
    providers: [
      singleton(AccessPolicy, OpenPolicy),
      singleton(WorkflowPartitions, TestPartitions),
      singleton(ChangesLog),
      ...withEventSubscribers(ChangesLog),
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
  connected.set("in-all", [{ partition: "shop-a", timezone: "Asia/Tokyo", enabled: true }, { partition: "shop-b", enabled: true }, { partition: "shop-off", enabled: false }]);
  connected.set("in-listed", [{ partition: "shop-a", timezone: "Asia/Tokyo", enabled: true }, { partition: "shop-off", enabled: false }]);
  connected.set("connected", [{ partition: "shop-a", enabled: true }, { partition: "shop-off", enabled: false }]);
  wf = await testWorkflow(root(url!), { now: "2026-11-02T09:00:00Z" });
  await wf.drain();
});

afterAll(async () => {
  if (enabled) await wf.stop();
});

const inScope = async <T>(work: (scope: ReturnType<TestWorkflow["app"]["container"]["createScope"]>) => Promise<T>): Promise<T> => {
  const scope = wf.app.container.createScope();
  try {
    return await work(scope);
  } finally {
    await scope.dispose();
  }
};
const emit = (key: string, payload: unknown = {}, options: EmitOptions = {}): Promise<EmitResult> => wf.emit(key, payload, options);
const instancesOf = async (processKey: string): Promise<readonly InstanceSummary[]> => (await inScope((scope) => scope.resolve(IWorkflowRuntime).instances({ processKey, limit: 200, sort: [{ field: "id", dir: "asc" }] }))).items;
const statuses = async (processKey: string) => (await instancesOf(processKey)).map((item) => item.status);
const scheduledTimes = async (processKey: string) => Promise.all((await instancesOf(processKey)).map(async (item) => (await wf.instance(item.id)).vars.at));

test.skipIf(!enabled)("a schedule runs on the clocks of its zone and tells which firing it is", async () => {
  // 15:00 in Moscow is 12:00 UTC.
  wf.clock.set("2026-11-02T11:59:00Z");
  await wf.drain();
  expect(await statuses("zone")).toEqual([]);
  wf.clock.set("2026-11-02T12:00:00Z");
  await wf.drain();
  expect(await statuses("zone")).toEqual(["completed"]);
  expect(await scheduledTimes("zone")).toEqual(["2026-11-02T12:00:00.000Z"]);
});

test.skipIf(!enabled)("a schedule runs only inside its period", async () => {
  // Only the firings at 01:00 and 02:00 are from `from` to `until`.
  const counts: number[] = [];
  for (const hour of ["00", "01", "02", "03", "04"]) {
    wf.clock.set(`2026-11-03T${hour}:00:00Z`);
    await wf.drain();
    counts.push((await instancesOf("period")).length);
  }
  expect(counts).toEqual([0, 1, 2, 2, 2]);
});

test.skipIf(!enabled)("overlap: skip drops a firing while the last run goes on", async () => {
  wf.clock.set("2026-11-04T00:00:00Z");
  await wf.drain();
  wf.clock.set("2026-11-04T01:00:00Z");
  await wf.drain();
  const [first, ...rest] = await instancesOf("overlap-skip");
  expect(rest).toEqual([]);
  await wf.complete(first!.id, "Check");
  wf.clock.set("2026-11-04T02:00:00Z");
  await wf.drain();
  expect(await statuses("overlap-skip")).toEqual(["completed", "running"]);
});

test.skipIf(!enabled)("overlap: queue makes a firing wait for the last run", async () => {
  wf.clock.set("2026-11-05T00:00:00Z");
  await wf.drain();
  wf.clock.set("2026-11-05T01:00:00Z");
  await wf.drain();
  wf.clock.set("2026-11-05T02:00:00Z");
  await wf.drain();
  expect(await statuses("overlap-queue")).toEqual(["running", "pending", "pending"]);
  const [first, second] = await instancesOf("overlap-queue");
  await wf.complete(first!.id, "Check");
  await wf.drain();
  expect(await statuses("overlap-queue")).toEqual(["completed", "running", "pending"]);
  await wf.complete(second!.id, "Check");
  await wf.drain();
  expect(await statuses("overlap-queue")).toEqual(["completed", "completed", "running"]);
});

test.skipIf(!enabled)("overlap by default runs side by side", async () => {
  wf.clock.set("2026-11-06T00:00:00Z");
  await wf.drain();
  wf.clock.set("2026-11-06T01:00:00Z");
  await wf.drain();
  expect(await statuses("overlap-parallel")).toEqual(["running", "running"]);
});

test.skipIf(!enabled)("catchUp runs every firing missed, otherwise only one runs late", async () => {
  // The worker was off from midnight: three firings are due.
  wf.clock.set("2026-11-07T02:30:00Z");
  await wf.drain();
  expect(await scheduledTimes("catch-up")).toEqual(["2026-11-07T00:00:00.000Z", "2026-11-07T01:00:00.000Z", "2026-11-07T02:00:00.000Z"]);
  expect(await scheduledTimes("no-catch-up")).toEqual(["2026-11-07T00:00:00.000Z"]);
  wf.clock.set("2026-11-07T03:00:00Z");
  await wf.drain();
  expect(await scheduledTimes("no-catch-up")).toEqual(["2026-11-07T00:00:00.000Z", "2026-11-07T03:00:00.000Z"]);
});

test.skipIf(!enabled)("partitions: all fires in each enabled partition by its own clocks, a list in those not switched off", async () => {
  // 9:00 in Tokyo is midnight UTC; shop-b has no zone of its own.
  wf.clock.set("2026-11-08T00:00:00Z");
  await wf.drain();
  expect((await instancesOf("in-all")).map((item) => item.partition)).toEqual(["shop-a"]);
  expect((await instancesOf("in-listed")).map((item) => item.partition)).toEqual(["shop-a"]);
  wf.clock.set("2026-11-08T09:00:00Z");
  await wf.drain();
  expect((await instancesOf("in-all")).map((item) => item.partition)).toEqual(["shop-a", "shop-b"]);
  expect((await instancesOf("in-listed")).map((item) => item.partition)).toEqual(["shop-a", "shop-new"]);
});

test.skipIf(!enabled)("a partition switched off loses its schedule", async () => {
  connected.set("in-all", [{ partition: "shop-a", enabled: false }, { partition: "shop-b", enabled: true }]);
  await wf.drain();
  const scope = wf.app.container.createScope();
  try {
    const { RuntimeDbContext } = await import("@/core/workflow/runtime_module/model/Runtime.dbContext");
    const jobs = await scope.resolve(RuntimeDbContext).jobs.asNoTracking().where((j) => j.kind.eq("schedule")).toList();
    const version = (await scope.resolve(IWorkflowDefinitions).latest("in-all")).id;
    // It fired on the 8th of November only, so no job is left for either; the switch must not add one.
    expect(jobs.filter((job) => job.versionId === version && job.partition === "shop-a")).toEqual([]);
  } finally {
    await scope.dispose();
  }
});

test.skipIf(!enabled)("filter lets through only what it wants", async () => {
  expect((await emit("t.placed", { amount: 50 })).started).toEqual([]);
  const { started } = await emit("t.placed", { amount: 500 });
  expect(started.length).toBe(1);
});

test.skipIf(!enabled)("delay starts a process later, with the event it got", async () => {
  const before = (await instancesOf("delayed")).length;
  const result = await emit("t.later", { n: 7 });
  expect(result).toMatchObject({ started: [], deferred: [{ processKey: "delayed" }] });
  await wf.drain();
  expect((await instancesOf("delayed")).length).toBe(before);
  await wf.advance("PT1H");
  const all = await instancesOf("delayed");
  expect(all.length).toBe(before + 1);
  expect((await wf.instance(all.at(-1)!.id)).output).toEqual({ seen: 7 });
});

test.skipIf(!enabled)("debounce merges events of one key into the last and does not put the start off for ever", async () => {
  await emit("t.often", { id: "a", n: 1 });
  await emit("t.often", { id: "b", n: 2 });
  await wf.advance("PT6M");
  await emit("t.often", { id: "a", n: 3 });
  await wf.advance("PT3M");
  await emit("t.often", { id: "a", n: 4 });
  expect(await instancesOf("debounced")).toEqual([]);
  // The window of `a` runs from its first event: ten minutes after it the process starts.
  await wf.advance("PT1M");
  const started = await Promise.all((await instancesOf("debounced")).map(async (item) => (await wf.instance(item.id)).output));
  expect(started.map((output) => output?.seen).sort()).toEqual([2, 4]);
  // A new event opens a new window.
  await emit("t.often", { id: "a", n: 5 });
  await wf.advance("PT10M");
  expect((await instancesOf("debounced")).length).toBe(3);
});

test.skipIf(!enabled)("ignoreOwn skips an event caused by an instance of the same process", async () => {
  const { started: [own] } = await emit("t.own", {});
  await wf.drain();
  expect(own).toBeDefined();
  expect((await emit("t.own", {}, { cause: { instanceId: own! } })).started).toEqual([]);
  const other = await wf.start("own-other");
  const { started: [next] } = await emit("t.own", {}, { cause: { instanceId: other.id, note: "from another" } });
  await wf.drain();
  expect((await wf.instance(next!)).output).toEqual({ cause: "from another" });
  // A cause that names no instance changes nothing.
  expect((await emit("t.own", {}, { cause: { instanceId: "not-a-uuid" } })).started.length).toBe(1);
});

test.skipIf(!enabled)("an event starts only processes connected to its partition", async () => {
  const startedIn = async (partition: string | null) => {
    const { started } = await emit("t.partition", {}, { partition });
    return (await Promise.all(started.map((id) => wf.instance(id)))).map((item) => item.processKey).sort();
  };
  expect(await startedIn("shop-a")).toEqual(["connected"]);
  expect(await startedIn("shop-off")).toEqual([]);
  expect(await startedIn("shop-other")).toEqual([]);
  expect(await startedIn(null)).toEqual(["no-partitions"]);
});

test.skipIf(!enabled)("until leaves a step waiting until the event it wants comes", async () => {
  const started = await wf.start("waits", { input: { id: "o-1", wanted: "approved" } });
  await wf.drain();
  expect((await emit("t.changed", { status: "draft" }, { correlation: "o-1" })).continued).toEqual([]);
  expect((await wf.instance(started.id)).status).toBe("running");
  expect((await emit("t.changed", { status: "approved" }, { correlation: "o-1" })).continued).toEqual([started.id]);
  await wf.drain();
  expect((await wf.instance(started.id)).output).toEqual({ last: { status: "approved" } });
});

test.skipIf(!enabled)("emitLater goes with the application's transaction and starts once", async () => {
  const waiting = await wf.start("outbox-wait");
  await wf.drain();
  const later = (name: string, n: number, fail: boolean) => inScope(async (scope) => {
    const db = scope.resolve(TriggerDbContext);
    const runtime = scope.resolve(IWorkflowRuntime);
    await db.transactionScope(async (tx) => {
      db.rows.add(Object.assign(new TriggerRow(), { name }));
      await db.saveChanges();
      await runtime.emitLater(tx, "t.outbox", { n });
      if (fail) throw new Error("rolled back");
    });
  });
  await expect(later("lost", 1, true)).rejects.toThrow("rolled back");
  await wf.drain();
  expect(await instancesOf("outbox")).toEqual([]);
  expect((await wf.instance(waiting.id)).status).toBe("running");

  await later("kept", 2, false);
  expect(await instancesOf("outbox")).toEqual([]);
  await wf.drain();
  const started = await instancesOf("outbox");
  expect(started.length).toBe(1);
  expect((await wf.instance(started[0]!.id)).input).toEqual({ n: 2 });
  expect((await wf.instance(waiting.id)).status).toBe("completed");
  await wf.drain();
  expect((await instancesOf("outbox")).length).toBe(1);

  // A payload the process refuses starts nothing and blocks nothing.
  await inScope(async (scope) => {
    const db = scope.resolve(TriggerDbContext);
    await db.transactionScope((tx) => scope.resolve(IWorkflowRuntime).emitLater(tx, "t.outbox", { n: "many" }));
  });
  await wf.drain();
  expect((await instancesOf("outbox")).length).toBe(1);
});

test.skipIf(!enabled)("emitLater refuses at once what could never be delivered", async () => {
  await inScope(async (scope) => {
    const db = scope.resolve(TriggerDbContext);
    await expect(db.transactionScope((tx) => scope.resolve(IWorkflowRuntime).emitLater(tx, "NOT A KEY"))).rejects.toThrow(WorkflowError);
  });
});

const ACTOR = { kind: "user", id: "u-1" } as const;
const definitions = <T>(work: (service: IWorkflowDefinitions) => Promise<T>) => inScope((scope) => work(scope.resolve(IWorkflowDefinitions)));

test.skipIf(!enabled)("a process is deleted only when archived, finished with and in no partition", async () => {
  const key = "to-delete";
  await definitions(async (service) => {
    await service.create({ key, title: key }, ACTOR);
    await service.saveDraft(key, { schemaVersion: "bazis.workflow/v2", nodes: { Start: { kind: "manualStart", title: "Start" }, Check: check, End: { kind: "end", title: "End" } }, flows: { a: { source: "Start", target: "Check" }, b: { source: "Check", target: "End" } } }, ACTOR);
    await service.publish(key, ACTOR);
  });
  const remove = () => definitions((service) => service.remove(key, ACTOR));
  await expect(remove()).rejects.toMatchObject({ code: "wrong_status" });
  const instance = await wf.start(key);
  await definitions((service) => service.update(key, { archived: true }, ACTOR));
  await expect(remove()).rejects.toMatchObject({ code: "in_use", status: 409 });
  await wf.complete(instance.id, "Check");
  connected.set(key, [{ partition: "shop-a", enabled: false }]);
  await expect(remove()).rejects.toMatchObject({ code: "in_use", message: expect.stringContaining("shop-a") });
  connected.delete(key);
  changes.length = 0;
  await remove();
  expect(changes.map((item) => [item.change, item.key])).toEqual([["deleted", key]]);
  await expect(definitions((service) => service.get(key))).rejects.toMatchObject({ code: "not_found" });
  // What has run stays.
  expect((await wf.instance(instance.id)).status).toBe("completed");
  expect(await definitions((service) => service.versionById("00000000-0000-7000-8000-000000000000"))).toBeUndefined();
});

test.skipIf(!enabled)("a process declared in code is not deleted", async () => {
  await definitions((service) => service.update("own-other", { archived: true }, ACTOR));
  try {
    await expect(definitions((service) => service.remove("own-other", ACTOR))).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await definitions((service) => service.update("own-other", { archived: false }, ACTOR));
  }
});

test.skipIf(!enabled)("DELETE over HTTP answers 204, then 404", async () => {
  await definitions(async (service) => {
    await service.create({ key: "http-delete", title: "x" }, ACTOR);
    await service.update("http-delete", { archived: true }, ACTOR);
  });
  expect((await wf.app.fetch("/workflow/processes/http-delete", { method: "DELETE" })).status).toBe(204);
  expect((await wf.app.fetch("/workflow/processes/http-delete", { method: "DELETE" })).status).toBe(404);
});

test.skipIf(!enabled)("the right to read a process follows its partitions", async () => {
  const keysFor = async (user: string) => {
    const response = await wf.app.fetch("/workflow/processes?page[size]=200", { headers: { "x-user": user } });
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { key: string }[] };
    return data.map((item) => item.key);
  };
  expect(await keysFor("shop-a")).toEqual(["connected", "in-listed"]);
  expect(await keysFor("shop-b")).toEqual(["in-all"]);
  expect(await keysFor("shop-none")).toEqual([]);
  const read = async (user: string, key: string) => (await wf.app.fetch(`/workflow/processes/${key}`, { headers: { "x-user": user } })).status;
  expect(await read("shop-a", "connected")).toBe(200);
  expect(await read("shop-b", "connected")).toBe(403);
  expect(await read("admin", "connected")).toBe(200);
});
