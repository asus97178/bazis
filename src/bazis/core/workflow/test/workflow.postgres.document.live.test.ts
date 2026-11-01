import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { AccessPolicy } from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { TOOL_EXECUTION_OPTIONS, Tool, type AgentToolExecutionContext } from "@/core/agent";
import { DI, Module, singleton, singletonValue } from "@/core/di";
import { PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp, type TestApp } from "@/core/testing";
import { defineProcess, IWorkflowDefinitions, WorkflowExtensions, WorkflowInputValidator, WorkflowModule, type ExtensionTarget, type WorkflowInputContext, type WorkflowPortContext } from "@/core/workflow";
import { postgres } from "@/library/orm";
import { validateForm, type FormSpec, type ProcessDocument } from "@/library/workflow";

/**
 * The document of WORKFLOW-002 stage 2 on PostgreSQL: the catalog brought over
 * from the old store, expressions, variables, step settings, the history log,
 * the ports, the palette, the card and the language of a request. Runs only
 * against a throwaway database whose name starts with `bazis_wf_`: set
 * `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables.
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
const inFolder = (permission: string, folder: string) => ({ [permission]: [{ scopes: "all" as const, where: { folder: { eq: folder } } }] });
const policy = new StaticAccessPolicy({
  grants: {
    admin: everything,
    sales: {
      ...inFolder("workflow.processes.read", "Sales"),
      ...inFolder("workflow.processes.manage", "Sales"),
      ...inFolder("workflow.instances.read", "Sales"),
      ...inFolder("workflow.instances.start", "Sales"),
    },
  },
  principals: { admin: ["role:manager"] },
});

const signedIn: AuthorizeCheck = (ctx) => {
  const subject = ctx.header("x-user");
  if (subject === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject });
  return true;
};

const inputs: unknown[] = [];
let slowMs = 0;

@Tool({ name: "doc.echo", description: "Gives back what it got.", sideEffect: "write", callers: ["workflow"] })
class EchoTool {
  execute(input: unknown): unknown {
    inputs.push(input);
    return { echoed: input, secretPhone: "+1" };
  }
}

@Tool({ name: "doc.slow", description: "Takes its time.", sideEffect: "write", callers: ["workflow"] })
class SlowTool {
  async execute(_input: unknown, context: AgentToolExecutionContext): Promise<{ ok: true }> {
    await Bun.sleep(slowMs);
    context.signal?.throwIfAborted();
    return { ok: true };
  }
}

@Tool({ name: "doc.fail", description: "Always fails.", sideEffect: "write", callers: ["workflow"] })
class FailTool {
  execute(): never {
    throw new Error("down");
  }
}

const portCalls: { namespace: string; target: ExtensionTarget; context: WorkflowPortContext }[] = [];

class CmsExtensions extends WorkflowExtensions {
  namespaces(): readonly string[] {
    return ["cms"];
  }

  check(namespace: string, value: unknown, target: ExtensionTarget, context: WorkflowPortContext): readonly string[] {
    portCalls.push({ namespace, target, context });
    return (value as { bad?: boolean }).bad === true ? ["bad is not allowed"] : [];
  }
}

const validatorContexts: WorkflowInputContext[] = [];

class RuleValidator extends WorkflowInputValidator {
  validate(spec: FormSpec | undefined, value: unknown, context: WorkflowInputContext) {
    validatorContexts.push(context);
    const result = validateForm(spec, value);
    const issues = [...result.issues];
    for (const field of spec?.fields ?? []) {
      const rules = field.extensions?.cms as { minLength?: number } | undefined;
      const text = result.value[field.name];
      if (rules?.minLength !== undefined && typeof text === "string" && text.length < rules.minLength) issues.push({ field: field.name, code: "minLength", message: "too short" });
    }
    return { value: result.value, issues };
  }
}

const start = { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" } } as const;
const line = (nodes: Record<string, unknown>, extra: Record<string, unknown> = {}): ProcessDocument => {
  const ids = ["Start", ...Object.keys(nodes), "End"];
  return {
    schemaVersion: "bazis.workflow/v2",
    nodes: { ...start, ...nodes } as ProcessDocument["nodes"],
    flows: Object.fromEntries(ids.slice(1).map((id, index) => [`f${index}`, { source: ids[index]!, target: id }])),
    ...extra,
  };
};

const translated = defineProcess({
  key: "translated-code",
  title: { en: "From code", ru: "Из кода" },
  folder: "Code/Examples",
  owner: "team-a",
  document: line({}),
});

function root(dsn: string, extra: { readonly processes?: readonly ReturnType<typeof defineProcess>[] } = {}) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfdocument", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    tools: [EchoTool, SlowTool, FailTool],
    processes: [translated, ...(extra.processes ?? [])],
    providers: [
      singletonValue(AccessPolicy, policy),
      singleton(WorkflowExtensions, CmsExtensions),
      singleton(WorkflowInputValidator, RuleValidator),
      DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined, approvalPolicy: () => true })),
    ],
  })
  class AppModule {}
  return AppModule;
}

let app: TestApp;

async function send(user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-user": user, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}
const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => send("admin", method, path, body, headers);

async function published(key: string, document: unknown, card: Record<string, unknown> = {}): Promise<void> {
  expect((await call("POST", "/workflow/processes", { key, title: `Process ${key}`, ...card })).status).toBe(201);
  const draft = await call("PUT", `/workflow/processes/${key}/draft`, { document });
  expect(draft.body.issues?.filter((issue: { severity: string }) => issue.severity === "error")).toEqual([]);
  const version = await call("POST", `/workflow/processes/${key}/publish`);
  expect(version.status).toBe(201);
}

/** Waits for the worker to settle an instance. */
async function settled(id: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { body } = await call("GET", `/workflow/instances/${id}`);
    if (body.status !== "running") return body;
    await Bun.sleep(25);
  }
  throw new Error(`instance ${id} is still running`);
}

async function run(key: string, input: unknown = {}): Promise<Record<string, any>> {
  const started = await call("POST", "/workflow/instances", { processKey: key, input });
  expect(started.status).toBe(201);
  return await settled(started.body.id);
}

const V1_DOCUMENT = {
  schemaVersion: "bazis.workflow/v1",
  input: { fields: [{ code: "amount", type: "number", required: true }] },
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Big: { kind: "exclusiveGateway", title: "Big?" },
    Yes: { kind: "serviceTask", title: "Echo", config: { tool: "doc.echo", input: { amount: "$input.amount" }, saveTo: "echo" } },
    End: { kind: "end", title: "End" },
  },
  flows: {
    a: { source: "Start", target: "Big" },
    b: { source: "Big", target: "Yes", condition: { path: "$input.amount", op: "gt", value: 10 } },
    c: { source: "Big", target: "End", isDefault: true },
    d: { source: "Yes", target: "End" },
  },
};
const PUBLISHED_AT = "2026-03-01T10:00:00.000Z";

/** The tables of the store before WORKFLOW-002, as the old release left them. */
async function oldStore(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.execute(`CREATE TABLE "bazis_wf_def_processes" (id uuid PRIMARY KEY, key text NOT NULL, title text NOT NULL, description text, draft json, "draftUpdatedAt" timestamptz, "draftUpdatedByKind" text, "draftUpdatedById" text, "latestVersion" integer, "retentionDays" integer, "archivedAt" timestamptz, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL)`, []);
  await sql.execute(`CREATE TABLE "bazis_wf_def_versions" (id uuid PRIMARY KEY, "processId" uuid NOT NULL, version integer NOT NULL, document json NOT NULL, "documentHash" text NOT NULL, "publishedAt" timestamptz NOT NULL, "publishedByKind" text NOT NULL, "publishedById" text NOT NULL)`, []);
  const process = "018f0000-0000-7000-8000-000000000001";
  await sql.execute(
    `INSERT INTO "bazis_wf_def_processes" VALUES ($1, 'old-order', 'Old order', 'About', $2::text::json, $3, 'user', 'u-1', 1, 30, NULL, $3, $3)`,
    [process, JSON.stringify(V1_DOCUMENT), PUBLISHED_AT],
  );
  await sql.execute(
    `INSERT INTO "bazis_wf_def_processes" VALUES ($1, 'old-broken', 'Old broken', NULL, $2::text::json, NULL, NULL, NULL, NULL, NULL, $3, $3, $3)`,
    ["018f0000-0000-7000-8000-000000000002", JSON.stringify({ schemaVersion: "bazis.workflow/v1", nodes: 1, flows: { a: 1 } }), PUBLISHED_AT],
  );
  await sql.execute(
    `INSERT INTO "bazis_wf_def_versions" VALUES ($1, $2, 1, $3::text::json, 'old-hash', $4, 'user', 'u-1')`,
    ["018f0000-0000-7000-8000-000000000003", process, JSON.stringify(V1_DOCUMENT), PUBLISHED_AT],
  );
}

beforeAll(async () => {
  if (!enabled) return;
  process.env.BAZIS_WORKFLOW__LANGUAGE = "en";
  process.env.BAZIS_WORKFLOW__LANGUAGES = "en,ru";
  const sql = postgres({ url });
  try {
    const tables = (await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'bazis\\_wf%'", [])) as { tablename: string }[];
    if (tables.length > 0) await sql.execute(`DROP TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`, []);
    await sql.execute(`DO $$ BEGIN IF to_regclass('public.__bazis_orm_owned_stores_v1') IS NOT NULL THEN DELETE FROM "__bazis_orm_owned_stores_v1" WHERE store_key LIKE 'bazis.workflow.%'; END IF; END $$`, []);
    await oldStore(sql);
  } finally {
    await sql.close();
  }
  app = await startTestApp(root(url!), { http: { authorize: signedIn } });
});

afterAll(async () => {
  await app?.stop();
  delete process.env.BAZIS_WORKFLOW__LANGUAGE;
  delete process.env.BAZIS_WORKFLOW__LANGUAGES;
});

test.skipIf(!enabled)("the catalog of the old store comes over: cards, drafts and versions as version 2", async () => {
  const card = (await call("GET", "/workflow/processes/old-order")).body;
  expect(card).toMatchObject({ key: "old-order", title: { en: "Old order" }, description: { en: "About" }, latestVersion: 1, retentionDays: 30, draftUpdatedBy: { kind: "user", id: "u-1" }, archived: false, folder: null, owner: null });
  expect(new Date(card.createdAt).toISOString()).toBe(PUBLISHED_AT);
  expect(card.draft.schemaVersion).toBe("bazis.workflow/v2");
  expect(card.draft.variables).toEqual([{ name: "amount", type: "number", required: true, direction: "in" }]);

  const version = (await call("GET", "/workflow/processes/old-order/versions/1")).body;
  expect(version.id).toBe("018f0000-0000-7000-8000-000000000003");
  expect(new Date(version.publishedAt).toISOString()).toBe(PUBLISHED_AT);
  expect(version.document.flows.b.condition).toEqual({ op: "gt", args: [{ path: "$input.amount" }, 10] });

  // A draft with errors comes over as it is, an archived process stays archived.
  const broken = (await call("GET", "/workflow/processes/old-broken")).body;
  expect(broken).toMatchObject({ archived: true, draft: { schemaVersion: "bazis.workflow/v2", nodes: 1 } });

  // It runs, and publishing the same draft again adds no version.
  expect((await run("old-order", { amount: 50 })).vars.echo.echoed).toEqual({ amount: 50 });
  expect((await call("POST", "/workflow/processes/old-order/publish")).body.version).toBe(1);
});

test.skipIf(!enabled)("the import happens once and leaves the old tables alone", async () => {
  await app.stop();
  const sql = postgres({ url });
  try {
    await sql.execute(`INSERT INTO "bazis_wf_def_processes" VALUES ('018f0000-0000-7000-8000-000000000009', 'late', 'Late', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), now())`, []);
  } finally {
    await sql.close();
  }
  app = await startTestApp(root(url!), { http: { authorize: signedIn } });
  expect((await call("GET", "/workflow/processes/late")).status).toBe(404);
  const check = postgres({ url });
  try {
    expect(await check.query(`SELECT count(*)::int AS n FROM "bazis_wf_def_processes"`, [])).toEqual([{ n: 3 }]);
  } finally {
    await check.close();
  }
});

test.skipIf(!enabled)("assign, expressions, paths of the run and out variables", async () => {
  await published("calc", line({
    Sum: {
      kind: "assign",
      title: "Sum",
      config: {
        assignments: [
          { var: "total", value: { op: "mul", args: [{ path: "$input.amount" }, 1.2] } },
          { var: "doubled", value: { op: "mul", args: [{ path: "$vars.total" }, 2] } },
          { var: "label", value: { op: "format", args: ["{0}/{1}", { path: "$run.processKey" }, { path: "$trigger.via" }] } },
          { var: "when", value: { op: "dateAdd", args: [{ path: "$now" }, "P1D"] } },
        ],
      },
    },
    Send: { kind: "serviceTask", title: "Send", config: { tool: "doc.echo", input: { total: "$vars.total", computed: { op: "add", args: [{ path: "$vars.doubled" }, 1] }, literal: { nested: ["$vars.label"] } }, saveTo: "sent" } },
  }, {
    variables: [
      { name: "amount", type: "number", direction: "in", required: true },
      { name: "note", type: "string", direction: "in", default: "none" },
      { name: "total", type: "number", direction: "local", default: 0 },
      { name: "doubled", type: "number", direction: "out" },
      { name: "label", type: "string", direction: "out" },
      { name: "when", type: "datetime", direction: "local" },
      { name: "untouched", type: "string", direction: "out" },
    ],
  }));
  const done = await run("calc", { amount: 100 });
  expect(done.status).toBe("completed");
  expect(done.input).toEqual({ amount: 100, note: "none" });
  expect(done.vars).toMatchObject({ total: 120, doubled: 240, label: "calc/manual" });
  expect(new Date(done.vars.when).getTime()).toBeGreaterThan(Date.now());
  expect(done.output).toEqual({ doubled: 240, label: "calc/manual", untouched: null });
  expect(inputs.at(-1)).toEqual({ total: 120, computed: 241, literal: { nested: ["calc/manual"] } });
  // By default the history names the variables, not their values.
  const history = (await call("GET", `/workflow/instances/${done.id}/history`)).body.data as { type: string; data: Record<string, unknown> }[];
  expect(history.find((entry) => entry.type === "assigned")!.data).toEqual({ vars: ["total", "doubled", "label", "when"] });
  expect(history.find((entry) => entry.type === "tool")!.data.input).toBeUndefined();
});

test.skipIf(!enabled)("a flow condition is an expression; $event comes from the event that started the process", async () => {
  await published("on-order", {
    schemaVersion: "bazis.workflow/v2",
    variables: [{ name: "seen", type: "object", direction: "out" }],
    nodes: {
      Start: { kind: "eventStart", title: "Start", config: { event: "orders.paid" } },
      Keep: { kind: "assign", title: "Keep", config: { assignments: [{ var: "seen", value: { path: "$event" } }] } },
      Big: { kind: "exclusiveGateway", title: "Big?" },
      Wait: { kind: "eventWait", title: "Wait", config: { event: "orders.shipped", saveTo: "shipped" } },
      End: { kind: "end", title: "End" },
    },
    flows: {
      a: { source: "Start", target: "Keep" },
      b: { source: "Keep", target: "Big" },
      c: { source: "Big", target: "Wait", condition: { op: "gt", args: [{ path: "$event.record.amount" }, 100] } },
      d: { source: "Big", target: "End", isDefault: true },
      e: { source: "Wait", target: "End" },
    },
  });
  const small = await call("POST", "/workflow/events/orders.paid", { payload: { record: { amount: 5 } } });
  const smallDone = await settled(small.body.started[0]);
  expect(smallDone.status).toBe("completed");
  expect(smallDone.output).toEqual({ seen: { record: { amount: 5 } } });

  const big = await call("POST", "/workflow/events/orders.paid", { payload: { record: { amount: 500 } } });
  const id = big.body.started[0];
  expect((await call("GET", `/workflow/instances/${id}`)).body.status).toBe("running");
  await call("POST", "/workflow/events/orders.shipped", { payload: { by: "post" } });
  expect((await settled(id)).vars.shipped).toEqual({ by: "post" });
});

test.skipIf(!enabled)("a step's timeout is an error with the reason timeout; settings.stepTimeout is the default", async () => {
  slowMs = 2_000;
  await published("slow", {
    schemaVersion: "bazis.workflow/v2",
    nodes: {
      ...start,
      Slow: { kind: "serviceTask", title: "Slow", config: { tool: "doc.slow", timeout: "PT1S" } },
      Caught: { kind: "boundaryError", title: "Caught", attachedTo: "Slow", config: { errorCode: "timeout" } },
      Note: { kind: "assign", title: "Note", config: { assignments: [{ var: "reason", value: { path: "$nodes.Caught.reason" } }] } },
    },
    variables: [{ name: "reason", type: "string", direction: "out" }],
    flows: {
      a: { source: "Start", target: "Slow" },
      b: { source: "Slow", target: "End" },
      c: { source: "Caught", target: "Note" },
      d: { source: "Note", target: "End" },
    },
  });
  const caught = await run("slow");
  expect(caught.status).toBe("completed");
  expect(caught.output).toEqual({ reason: "timeout" });

  await published("slow-default", line({ Slow: { kind: "serviceTask", title: "Slow", config: { tool: "doc.slow" } } }, { settings: { stepTimeout: "PT1S" } }));
  const failed = await run("slow-default");
  expect(failed.status).toBe("failed");
  expect(failed.error.code).toMatch(/^TOOL_TIMEOUT/);
  slowMs = 0;
}, 20_000);

test.skipIf(!enabled)("a step longer than the lease keeps its job: no second worker calls the Tool meanwhile", async () => {
  slowMs = 1_000;
  await published("long", line({ Long: { kind: "serviceTask", title: "Long", config: { tool: "doc.slow", timeout: "PT1H" } } }));
  const id = (await call("POST", "/workflow/instances", { processKey: "long" })).body.id;
  const sql = postgres({ url });
  try {
    let lockedUntil: Date | undefined;
    for (let attempt = 0; attempt < 100 && lockedUntil === undefined; attempt += 1) {
      const [row] = await sql.query(`SELECT "lockedUntil" FROM "bazis_wf2_run_jobs" WHERE "instanceId" = $1::uuid AND "lockedUntil" > now() + interval '50 minutes'`, [id]) as { lockedUntil: Date }[];
      lockedUntil = row?.lockedUntil;
      if (lockedUntil === undefined) await Bun.sleep(20);
    }
    expect(lockedUntil).toBeDefined();
  } finally {
    await sql.close();
  }
  expect((await settled(id)).status).toBe("completed");
  slowMs = 0;
});

test.skipIf(!enabled)("onError: skip moves on with { skipped, error }; an error boundary comes first", async () => {
  await published("skips", line({
    Fail: { kind: "serviceTask", title: "Fail", config: { tool: "doc.fail", onError: "skip", saveTo: "failure" } },
  }));
  const skipped = await run("skips");
  expect(skipped.status).toBe("completed");
  expect(skipped.vars.failure).toMatchObject({ skipped: true, error: { message: expect.stringContaining("") } });
  const history = (await call("GET", `/workflow/instances/${skipped.id}/history`)).body.data as { type: string }[];
  expect(history.map((entry) => entry.type)).toContain("skipped");

  await published("skip-boundary", {
    schemaVersion: "bazis.workflow/v2",
    nodes: {
      ...start,
      Fail: { kind: "serviceTask", title: "Fail", config: { tool: "doc.fail", onError: "skip" } },
      Caught: { kind: "boundaryError", title: "Caught", attachedTo: "Fail" },
      After: { kind: "end", title: "After" },
    },
    flows: { a: { source: "Start", target: "Fail" }, b: { source: "Fail", target: "End" }, c: { source: "Caught", target: "After" } },
  });
  const caught = await run("skip-boundary");
  expect(caught.status).toBe("completed");
  expect(caught.nodes.Caught).toBeDefined();
});

test.skipIf(!enabled)("the history keeps values and Tool payloads only when asked, personal data masked", async () => {
  const variables = [
    { name: "email", type: "string", direction: "in", personal: true },
    { name: "plain", type: "string", direction: "in" },
    { name: "copy", type: "string", direction: "local", personal: true },
    { name: "fromPersonal", type: "string", direction: "local" },
    { name: "open", type: "string", direction: "local" },
  ];
  const nodes = {
    Set: {
      kind: "assign",
      title: "Set",
      config: {
        assignments: [
          { var: "copy", value: { path: "$input.plain" } },
          { var: "fromPersonal", value: { op: "upper", args: [{ path: "$input.email" }] } },
          { var: "open", value: { path: "$input.plain" } },
        ],
      },
    },
    Send: { kind: "serviceTask", title: "Send", config: { tool: "doc.echo", input: { to: "$input.email", copy: { op: "lower", args: [{ path: "$vars.copy" }] }, open: "$vars.open" } } },
  };
  const entries = async (id: string) => (await call("GET", `/workflow/instances/${id}/history`)).body.data as { type: string; data: Record<string, unknown> }[];

  await published("logged", line(nodes, { variables, settings: { log: { variables: true, toolPayloads: true } } }));
  const masked = await run("logged", { email: "a@b.c", plain: "x" });
  const history = await entries(masked.id);
  expect(history.find((entry) => entry.type === "assigned")!.data).toEqual({ values: { copy: "***", fromPersonal: "***", open: "x" } });
  expect(history.find((entry) => entry.type === "tool")!.data.input).toEqual({ to: "***", copy: "***", open: "x" });
  // The instance itself keeps the real values: only the history is masked.
  expect(masked.vars.fromPersonal).toBe("A@B.C");

  await published("logged-open", line(nodes, { variables, settings: { log: { variables: true, toolPayloads: true, maskPersonal: false } } }));
  const open = await entries((await run("logged-open", { email: "a@b.c", plain: "x" })).id);
  expect(open.find((entry) => entry.type === "assigned")!.data).toEqual({ values: { copy: "x", fromPersonal: "A@B.C", open: "x" } });
  expect(open.find((entry) => entry.type === "tool")!.data).toMatchObject({ input: { to: "a@b.c", copy: "x", open: "x" }, output: { secretPhone: "+1" } });
});

test.skipIf(!enabled)("WorkflowExtensions: a namespace without a check is an error, the application checks its own, the engine ignores them", async () => {
  const issuesOf = async (document: unknown) => (await call("POST", "/workflow/validate", { document }, { "accept-language": "ru" })).body.issues as { code: string; node?: string; variable?: string; message: string }[];
  portCalls.length = 0;
  const document = line({}, {
    extensions: { cms: { places: ["card"] } },
    variables: [{ name: "x", type: "string", direction: "local", extensions: { cms: { bad: true } } }],
  });
  const found = await issuesOf(document);
  expect(found.map((issue) => [issue.code, issue.variable, issue.message])).toEqual([["extension_invalid", "x", "cms: bad is not allowed"]]);
  expect(portCalls.map((item) => [item.namespace, item.target])).toEqual([["cms", {}], ["cms", { variable: "x" }]]);
  expect(portCalls[0]!.context).toEqual({ partition: null, language: "ru", actor: { kind: "user", id: "admin" } });

  expect((await issuesOf(line({}, { extensions: { other: {} } }))).map((issue) => issue.code)).toEqual(["extension_unknown"]);

  // A draft keeps the errors, a publication refuses them.
  await call("POST", "/workflow/processes", { key: "with-ext", title: "With extensions" });
  const draft = await call("PUT", "/workflow/processes/with-ext/draft", { document: line({}, { extensions: { other: {} } }) });
  expect(draft.body.issues.map((issue: { code: string }) => issue.code)).toEqual(["extension_unknown"]);
  expect((await call("POST", "/workflow/processes/with-ext/publish")).status).toBe(422);

  await call("PUT", "/workflow/processes/with-ext/draft", { document: line({}, { extensions: { cms: { places: [] } } }) });
  expect((await call("POST", "/workflow/processes/with-ext/publish")).status).toBe(201);
  expect((await run("with-ext")).status).toBe("completed");
});

test.skipIf(!enabled)("a published version with a namespace nobody checks still runs", async () => {
  const scope = app.container.createScope();
  try {
    const definitions = scope.resolve(IWorkflowDefinitions);
    await call("POST", "/workflow/processes", { key: "orphan", title: "Orphan" });
    await call("PUT", "/workflow/processes/orphan/draft", { document: line({}, { extensions: { cms: {} } }) });
    const version = await definitions.publish("orphan", { kind: "system", id: "t" });
    const sql = postgres({ url });
    try {
      await sql.execute(`UPDATE "bazis_wf2_def_versions" SET document = $1::text::json WHERE id = $2::uuid`, [JSON.stringify(line({}, { extensions: { removed: {} } })), version.id]);
    } finally {
      await sql.close();
    }
  } finally {
    await scope.dispose();
  }
  expect((await run("orphan")).status).toBe("completed");
});

test.skipIf(!enabled)("WorkflowInputValidator gets the rules of a field and the language of the request", async () => {
  await published("ruled", line({}, { variables: [{ name: "name", type: "string", direction: "in", extensions: { cms: { minLength: 3 } } }] }));
  validatorContexts.length = 0;
  const refused = await call("POST", "/workflow/instances", { processKey: "ruled", input: { name: "ab" } }, { "accept-language": "de, ru;q=0.5" });
  expect(refused.status).toBe(422);
  expect(refused.body.details.issues).toEqual([{ field: "name", code: "minLength", message: "too short" }]);
  expect(validatorContexts[0]).toEqual({ purpose: "input", processKey: "ruled", partition: null, language: "ru", actor: { kind: "user", id: "admin" } });
});

test.skipIf(!enabled)("the palette and /workflow/validate", async () => {
  const palette = (await call("GET", "/workflow/palette")).body;
  expect(palette.nodeKinds.map((kind: { kind: string }) => kind.kind)).toContain("assign");
  expect(palette.functions.map((item: { name: string }) => item.name)).toContain("dateAdd");
  expect(palette.paths.map((item: { path: string }) => item.path)).toContain("$event");
  expect(palette.tools.map((tool: { name: string }) => tool.name)).toEqual(["doc.echo", "doc.fail", "doc.slow"]);
  expect(palette.tools[0]).toMatchObject({ sideEffect: "write", dryRun: "unsupported" });

  const { body } = await call("POST", "/workflow/validate", { document: { schemaVersion: "bazis.workflow/v1" } });
  expect(body.issues[0]).toMatchObject({ severity: "error", code: "schema" });
  expect((await call("POST", "/workflow/validate", { document: line({ Sms: { kind: "serviceTask", title: "Sms", config: { tool: "no.such" } } }) })).body.issues[0]).toMatchObject({ code: "unknown_tool", node: "Sms" });
  expect((await send("nobody", "GET", "/workflow/palette")).status).toBe(403);
  expect((await send("nobody", "POST", "/workflow/validate", { document: {} })).status).toBe(403);
});

test.skipIf(!enabled)("version 1 is refused when saved: only the import reads it", async () => {
  await call("POST", "/workflow/processes", { key: "stale", title: "Stale" });
  const draft = await call("PUT", "/workflow/processes/stale/draft", { document: V1_DOCUMENT });
  expect(draft.body.issues.map((issue: { code: string }) => issue.code)).toEqual(["schema"]);
  expect((await call("POST", "/workflow/processes/stale/publish")).status).toBe(422);
});

test.skipIf(!enabled)("the card: localized titles, folder and owner, search and filters, and processes in code", async () => {
  const created = await call("POST", "/workflow/processes", { key: "card", title: { en: "Invoice", ru: "Счёт" }, description: { ru: "Описание" }, folder: "Sales/Orders", owner: "u-5" }, { "accept-language": "ru-RU" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ title: { en: "Invoice", ru: "Счёт" }, titleText: "Счёт", description: { ru: "Описание" }, folder: "Sales/Orders", owner: "u-5" });
  await call("POST", "/workflow/processes", { key: "card-top", title: "Top", folder: "Sales" });
  await call("POST", "/workflow/processes", { key: "card-other", title: "Other", folder: "Salesman" });

  const keys = async (query: string) => (await call("GET", `/workflow/processes?${query}`)).body.data.map((item: { key: string }) => item.key);
  expect(await keys("filter[folder]=Sales")).toEqual(["card", "card-top"]);
  expect(await keys("filter[folder]=Sales/Orders")).toEqual(["card"]);
  expect(await keys("filter[owner]=u-5")).toEqual(["card"]);
  expect(await keys(`filter[search]=${encodeURIComponent("счёт")}`)).toEqual(["card"]);
  expect(await keys("filter[search]=invoice")).toEqual(["card"]);
  expect((await keys("filter[folder]=Sales&sort=-title"))[0]).toBe("card-top");

  const list = (await call("GET", "/workflow/processes?filter[owner]=u-5", undefined, { "accept-language": "en" })).body.data[0];
  expect(list.titleText).toBe("Invoice");
  expect((await call("GET", "/workflow/processes/card", undefined, { "accept-language": "fr" })).body.titleText).toBe("Invoice");

  const moved = await call("PATCH", "/workflow/processes/card", { folder: "Sales/Archive", title: "Bill", owner: null });
  expect(moved.body).toMatchObject({ folder: "Sales/Archive", title: "Bill", titleText: "Bill", owner: null });
  expect((await call("PATCH", "/workflow/processes/card", { folder: "/bad/" })).status).toBe(422);
  expect((await call("PATCH", "/workflow/processes/card", { title: { "not a language": "x" } })).status).toBe(422);
  expect((await call("POST", "/workflow/processes", { key: "no-title" })).status).toBe(422);

  expect((await call("GET", "/workflow/processes/translated-code", undefined, { "accept-language": "ru" })).body).toMatchObject({ title: { en: "From code", ru: "Из кода" }, titleText: "Из кода", folder: "Code/Examples", owner: "team-a", module: "AppModule" });
});

test.skipIf(!enabled)("a folder in a grant narrows the catalog, a process and its instances", async () => {
  await published("sales-a", line({ Wait: { kind: "timerCatch", title: "Wait", config: { duration: "P1D" } } }), { folder: "Sales" });
  await published("hr-a", line({ Wait: { kind: "timerCatch", title: "Wait", config: { duration: "P1D" } } }), { folder: "HR" });
  const inSales = (await call("POST", "/workflow/instances", { processKey: "sales-a" })).body.id;
  const inHr = (await call("POST", "/workflow/instances", { processKey: "hr-a" })).body.id;
  const sales = (method: string, path: string, body?: unknown) => send("sales", method, path, body);

  const catalog = (await sales("GET", "/workflow/processes?page[size]=200")).body.data.map((item: { key: string }) => item.key);
  expect(catalog).toContain("sales-a");
  expect(catalog).not.toContain("hr-a");
  expect((await sales("GET", "/workflow/processes/sales-a")).status).toBe(200);
  expect((await sales("GET", "/workflow/processes/hr-a")).status).toBe(403);

  // Moving a process needs the right in the folder it goes to.
  expect((await sales("PATCH", "/workflow/processes/sales-a", { folder: "HR" })).status).toBe(403);
  expect((await sales("POST", "/workflow/processes", { key: "sales-b", title: "B", folder: "HR" })).status).toBe(403);
  expect((await sales("POST", "/workflow/processes", { key: "sales-b", title: "B", folder: "Sales" })).status).toBe(201);

  const instances = (await sales("GET", "/workflow/instances?page[size]=200")).body.data.map((item: { id: string }) => item.id);
  expect(instances).toContain(inSales);
  expect(instances).not.toContain(inHr);
  expect((await sales("GET", `/workflow/instances/${inSales}`)).status).toBe(200);
  expect((await sales("GET", `/workflow/instances/${inHr}`)).status).toBe(403);
  expect((await sales("POST", "/workflow/instances", { processKey: "sales-a" })).status).toBe(201);
  expect((await sales("POST", "/workflow/instances", { processKey: "hr-a" })).status).toBe(403);
});

test.skipIf(!enabled)("the title of a task is localized, a form field has a name", async () => {
  await published("translated-task", line({
    Approve: { kind: "userTask", title: { en: "Approve", ru: "Утвердить" }, config: { assignee: { role: "manager" }, saveTo: "review", form: { fields: [{ name: "ok", type: "boolean", required: true, title: { ru: "Да?" } }] } } },
  }));
  const started = (await call("POST", "/workflow/instances", { processKey: "translated-task" })).body.id;
  const list = async (language: string) => (await call("GET", "/workflow/tasks?filter[processKey]=translated-task", undefined, { "accept-language": language })).body.data;
  let task;
  for (let attempt = 0; attempt < 100 && task === undefined; attempt += 1) {
    task = (await list("ru"))[0];
    if (task === undefined) await Bun.sleep(25);
  }
  expect(task).toMatchObject({ title: { en: "Approve", ru: "Утвердить" }, titleText: "Утвердить", form: { fields: [{ name: "ok" }] } });
  expect((await list("en"))[0].titleText).toBe("Approve");
  expect((await call("GET", `/workflow/tasks/${task.id}`, undefined, { "accept-language": "ru" })).body.titleText).toBe("Утвердить");
  expect((await call("POST", `/workflow/tasks/${task.id}/complete`, { output: {} })).status).toBe(422);
  expect((await call("POST", `/workflow/tasks/${task.id}/complete`, { output: { ok: true } })).body.titleText).toBe("Approve");
  expect((await settled(started)).vars.review).toEqual({ ok: true });
});

test.skipIf(!enabled)("a process in code with a namespace nobody checks stops the start", async () => {
  const stray = defineProcess({ key: "stray", title: "Stray", document: line({}, { extensions: { nobody: {} } }) });
  await app.stop();
  await expect(startTestApp(root(url!, { processes: [stray] }), { http: { authorize: signedIn } })).rejects.toThrow("extensions namespace nobody");
  app = await startTestApp(root(url!), { http: { authorize: signedIn } });
});
