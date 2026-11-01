import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);
import { AccessPolicy, type AccessSubject, type Scope, type ScopePrincipals } from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { TOOL_EXECUTION_OPTIONS } from "@/core/agent";
import { DI, Module, singletonValue } from "@/core/di";
import { PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck } from "@/core/http";
import { Infra } from "@/core/infra";
import { defineConfig, secret } from "@/core/kernel";
import { ormBazisConnect } from "@/core/orm";
import { startTestApp, type TestApp } from "@/core/testing";
import { IWorkflowDefinitions, WorkflowModule } from "@/core/workflow";
import { postgres } from "@/library/orm";

/**
 * Rights of the workflow HTTP on PostgreSQL (WORKFLOW-002 §6.2): checks of
 * objects and the list filters, by grants of a rights system. Runs only against
 * a throwaway database whose name starts with `bazis_wf_`: set
 * `BAZIS_WORKFLOW_PG_URL`. The test drops the workflow tables before it starts.
 */
const url = process.env.BAZIS_WORKFLOW_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = database.startsWith("bazis_wf_");

const SYSTEM = { kind: "system", id: "test" } as const;

/** Lena is a manager in space-a only: her role does not address tasks of other partitions. */
class Policy extends StaticAccessPolicy {
  override async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    if (subject.sub !== "lena") return await super.principals(subject, scopes);
    return scopes.map((scope) => ({ scope, principals: scope === "space-a" ? ["user:lena", "role:manager"] : ["user:lena"] }));
  }
}

const everywhere = { scopes: "all" } as const;

const policy = new Policy({
  grants: {
    admin: {
      "access.catalog.read": "all",
      "workflow.processes.read": "all",
      "workflow.processes.manage": "all",
      "workflow.processes.publish": "all",
      "workflow.instances.start": "all",
      "workflow.instances.read": "all",
      "workflow.instances.manage": "all",
      "workflow.events.emit": "all",
      "workflow.tasks.work": "all",
    },
    /** One process of the catalog; starts only in space-a and only `visible`. */
    ann: {
      "workflow.processes.read": [{ ...everywhere, where: { process: { eq: "visible" } } }],
      "workflow.instances.start": [{ scopes: ["space-a"], where: { process: { eq: "visible" } } }],
      "workflow.instances.read": [{ ...everywhere, where: { own: true } }],
    },
    /** Sees and manages everything of space-a, nothing else. */
    bob: {
      "workflow.instances.read": [{ scopes: ["space-a"] }],
      "workflow.instances.manage": [{ scopes: ["space-a"] }],
      "workflow.tasks.work": [{ scopes: ["space-a"] }],
    },
    lena: { "workflow.tasks.work": [everywhere] },
    /** Works only on the tasks of `visible`. */
    kate: { "workflow.tasks.work": [{ ...everywhere, where: { process: { eq: "visible" } } }] },
    /** Sends one event in space-a. */
    hook: { "workflow.events.emit": [{ scopes: ["space-a"], where: { event: { eq: "orders.paid" } } }] },
    nobody: {},
  },
  principals: { kate: ["role:manager"], admin: ["role:manager"] },
});

const signedIn: AuthorizeCheck = (ctx) => {
  const subject = ctx.header("x-user");
  if (subject === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject });
  return true;
};

const DOCUMENT = {
  schemaVersion: "bazis.workflow/v1",
  nodes: {
    Start: { kind: "manualStart", title: "Start" },
    Approve: { kind: "userTask", title: "Approve", config: { assignee: { role: "manager" } } },
    End: { kind: "end", title: "End" },
  },
  flows: { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" } },
};

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("wfrights", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({
    imports: [TestInfra, WorkflowModule],
    providers: [singletonValue(AccessPolicy, policy), DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, { auditSink: () => undefined }))],
  })
  class AppModule {}
  return AppModule;
}

let app: TestApp;

async function call(user: string | undefined, method: string, path: string, body?: unknown) {
  const response = await app.fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(user === undefined ? {} : { "x-user": user }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const start = async (user: string, processKey: string, partition: string | null) => (await call(user, "POST", "/workflow/instances", { processKey, partition }));
const ids = (list: { body: { data: { id: string }[] } }) => list.body.data.map((item) => item.id).sort();

/** Waits for the worker: the task of a started instance appears shortly after. */
async function taskOf(instanceId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = await call("admin", "GET", "/workflow/tasks?page[size]=200");
    const found = (list.body.data as { id: string; instanceId: string }[]).find((task) => task.instanceId === instanceId);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`no task for ${instanceId}`);
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
  app = await startTestApp(root(url!), { http: { authorize: signedIn } });
  const scope = app.container.createScope();
  try {
    const definitions = scope.resolve(IWorkflowDefinitions);
    for (const key of ["visible", "hidden"]) {
      await definitions.create({ key, title: `The ${key} process` }, SYSTEM);
      await definitions.saveDraft(key, DOCUMENT, SYSTEM);
      await definitions.publish(key, SYSTEM);
    }
  } finally {
    await scope.dispose();
  }
});

afterAll(async () => {
  if (enabled) await app?.stop();
});

test.skipIf(!enabled)("the routes answer 401 without a subject and 403 without the right", async () => {
  expect((await call(undefined, "GET", "/workflow/processes")).status).toBe(401);
  for (const [method, path] of [
    ["GET", "/workflow/processes"],
    ["POST", "/workflow/processes"],
    ["GET", "/workflow/tools"],
    ["GET", "/workflow/instances"],
    ["POST", "/workflow/instances"],
    ["GET", "/workflow/tasks"],
    ["POST", "/workflow/events/orders.paid"],
  ] as const) {
    expect(`${method} ${path} ${(await call("nobody", method, path, method === "POST" ? {} : undefined)).status}`).toBe(`${method} ${path} 403`);
  }
});

test.skipIf(!enabled)("the catalog holds the permissions of the module and the processes as a reference kind", async () => {
  const catalog = await call("admin", "GET", "/access/catalog");
  const keys = (catalog.body.data as { key: string }[]).map((item) => item.key);
  expect(keys).toEqual(expect.arrayContaining([
    "workflow.processes.read",
    "workflow.processes.manage",
    "workflow.processes.publish",
    "workflow.instances.start",
    "workflow.instances.read",
    "workflow.instances.manage",
    "workflow.events.emit",
    "workflow.tasks.work",
  ]));
  const found = await call("admin", "GET", "/access/references/workflow.process?search=visible");
  expect(found.body.data).toEqual([{ id: "visible", title: "The visible process" }]);
});

test.skipIf(!enabled)("a condition on the process narrows the catalog and its objects", async () => {
  const list = await call("ann", "GET", "/workflow/processes");
  expect(list.status).toBe(200);
  expect(list.body.data.map((process: { key: string }) => process.key)).toEqual(["visible"]);
  expect(list.body.meta.total).toBe(1);
  expect((await call("ann", "GET", "/workflow/processes/visible")).status).toBe(200);
  expect((await call("ann", "GET", "/workflow/processes/hidden")).status).toBe(403);
  expect((await call("ann", "GET", "/workflow/processes/hidden/versions")).status).toBe(403);
  expect((await call("admin", "GET", "/workflow/processes")).body.meta.total).toBe(2);
});

test.skipIf(!enabled)("starting checks the partition of the request and the process", async () => {
  expect((await start("ann", "visible", "space-a")).status).toBe(201);
  expect((await start("ann", "visible", "space-b")).status).toBe(403);
  expect((await start("ann", "visible", null)).status).toBe(403);
  expect((await start("ann", "hidden", "space-a")).status).toBe(403);
});

test.skipIf(!enabled)("own instances and the instances of a partition: in the list and one by one", async () => {
  const mine = (await start("ann", "visible", "space-a")).body;
  const inA = (await start("admin", "hidden", "space-a")).body;
  const inB = (await start("admin", "hidden", "space-b")).body;

  const annSees = await call("ann", "GET", "/workflow/instances?page[size]=200");
  expect(ids(annSees)).toContain(mine.id);
  expect(ids(annSees)).not.toContain(inA.id);
  expect((await call("ann", "GET", `/workflow/instances/${mine.id}`)).status).toBe(200);
  expect((await call("ann", "GET", `/workflow/instances/${mine.id}/history`)).status).toBe(200);
  expect((await call("ann", "GET", `/workflow/instances/${inA.id}`)).status).toBe(403);

  const bobSees = await call("bob", "GET", "/workflow/instances?page[size]=200");
  expect(ids(bobSees)).toEqual(expect.arrayContaining([mine.id, inA.id]));
  expect(ids(bobSees)).not.toContain(inB.id);
  expect((await call("bob", "GET", `/workflow/instances/${inB.id}`)).status).toBe(403);
  expect((await call("bob", "GET", `/workflow/instances?filter[partition]=space-b`)).body.data).toEqual([]);

  expect((await call("ann", "POST", `/workflow/instances/${mine.id}/cancel`, {})).status).toBe(403);
  expect((await call("bob", "POST", `/workflow/instances/${inB.id}/cancel`, {})).status).toBe(403);
  expect((await call("bob", "POST", `/workflow/instances/${inA.id}/cancel`, {})).status).toBe(200);
});

test.skipIf(!enabled)("an event checks its partition and key", async () => {
  expect((await call("hook", "POST", "/workflow/events/orders.paid", { partition: "space-a" })).status).toBe(202);
  expect((await call("hook", "POST", "/workflow/events/orders.paid", { partition: "space-b" })).status).toBe(403);
  expect((await call("hook", "POST", "/workflow/events/orders.other", { partition: "space-a" })).status).toBe(403);
});

test.skipIf(!enabled)("addressees are counted per partition when the tasks are viewed", async () => {
  const inA = await taskOf((await start("admin", "visible", "space-a")).body.id);
  const inB = await taskOf((await start("admin", "visible", "space-b")).body.id);
  const noPartition = await taskOf((await start("admin", "visible", null)).body.id);
  const hidden = await taskOf((await start("admin", "hidden", "space-a")).body.id);

  // Lena is a manager in space-a only.
  const lena = await call("lena", "GET", "/workflow/tasks?page[size]=200");
  expect(ids(lena)).toContain(inA.id);
  expect(ids(lena)).not.toContain(inB.id);
  expect(ids(lena)).not.toContain(noPartition.id);
  expect((await call("lena", "GET", `/workflow/tasks/${inA.id}`)).status).toBe(200);
  expect((await call("lena", "GET", `/workflow/tasks/${inB.id}`)).status).toBe(404);
  expect((await call("lena", "GET", "/workflow/tasks?filter[partition]=space-b")).body.data).toEqual([]);

  // A manager everywhere, the task without a partition included, but only of one process.
  const kate = await call("kate", "GET", "/workflow/tasks?page[size]=200");
  expect(ids(kate)).toEqual(expect.arrayContaining([inA.id, inB.id, noPartition.id]));
  expect(ids(kate)).not.toContain(hidden.id);
  expect((await call("kate", "GET", `/workflow/tasks/${hidden.id}`)).status).toBe(403);

  // A right without being addressed gives nothing; a partition without the right gives 403.
  expect((await call("bob", "GET", "/workflow/tasks?page[size]=200")).body.data).toEqual([]);
  expect((await call("bob", "GET", `/workflow/tasks/${inA.id}`)).status).toBe(404);
  expect((await call("bob", "GET", `/workflow/tasks/${inB.id}`)).status).toBe(403);

  // A claimed task stays with the one who took it, wherever it is addressed.
  expect((await call("lena", "POST", `/workflow/tasks/${inA.id}/claim`)).body).toMatchObject({ status: "claimed", claimedBy: "lena" });
  expect((await call("kate", "POST", `/workflow/tasks/${inA.id}/complete`, { output: {} })).status).toBe(409);
  expect((await call("lena", "POST", `/workflow/tasks/${inA.id}/complete`, { output: {} })).body).toMatchObject({ status: "completed", completedBy: "lena" });
});
