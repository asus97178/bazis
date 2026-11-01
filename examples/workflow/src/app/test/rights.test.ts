import { afterAll, beforeAll, expect, test } from "bun:test";
import { hs256, TokenIssuer } from "bazis/library/jwt";

// End-to-end: the app from source on a real PostgreSQL, the rights of the roles
// over HTTP. Needs BAZIS_DB__HOST; without it the test is reported as skipped.
const enabled = Boolean(process.env.BAZIS_DB__HOST);
const port = String(20000 + Math.floor(Math.random() * 20000));
const base = `http://127.0.0.1:${port}`;
const issuer = new TokenIssuer({ issuer: "orders", audience: "user", algorithm: hs256("dev-only-secret-at-least-32-bytes!!"), accessTtlSeconds: 3600, refreshTtlSeconds: 86400 });
let app: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  if (!enabled) return;
  app = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    env: { ...process.env, BAZIS_ENV: "development", HOST: "127.0.0.1", PORT: port },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`${base}/health`).then((response) => response.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("app did not answer /health");
});

afterAll(async () => {
  app?.kill();
  await app?.exited;
});

async function send(user: string | undefined, role: string, method: string, path: string, body?: unknown) {
  const token = user === undefined ? undefined : (await issuer.issue(user, { role })).accessToken;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const ann = (method: string, path: string, body?: unknown) => send("ann", "customer", method, path, body);
const boris = (method: string, path: string, body?: unknown) => send("boris", "customer", method, path, body);
const mila = (method: string, path: string, body?: unknown) => send("mila", "manager", method, path, body);
const root = (method: string, path: string, body?: unknown) => send("root", "admin", method, path, body);

interface Task { id: string; instanceId: string; processKey: string; status: string }

async function reviewTask(businessKey: string): Promise<Task> {
  const instance = (await mila("GET", `/workflow/instances?filter[businessKey]=${businessKey}`)).body.data[0];
  for (let attempt = 0; attempt < 200; attempt++) {
    const tasks = (await mila("GET", "/workflow/tasks?page[size]=200")).body.data as Task[];
    const found = tasks.find((task) => task.instanceId === instance.id);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`no task for ${businessKey}`);
}

async function statusOf(id: string, expected: string): Promise<string> {
  let status = "";
  for (let attempt = 0; attempt < 200; attempt++) {
    status = (await mila("GET", `/orders/${id}`)).body.status;
    if (status === expected) return status;
    await Bun.sleep(25);
  }
  return status;
}

test.skipIf(!enabled)("401 without a token, 403 without the right", async () => {
  expect((await send(undefined, "", "GET", "/orders")).status).toBe(401);
  expect((await send(undefined, "", "GET", "/workflow/processes")).status).toBe(401);
  expect((await ann("GET", "/workflow/processes")).status).toBe(403);
  expect((await ann("GET", "/workflow/tasks")).status).toBe(403);
  expect((await mila("POST", "/orders", { amount: 10 })).status).toBe(403);
  expect((await send("guest", "nobody", "GET", "/orders")).status).toBe(403);
});

test.skipIf(!enabled)("a customer sees only their orders and instances, a manager sees all", async () => {
  const mine = (await ann("POST", "/orders", { amount: 5000 })).body;
  const other = (await boris("POST", "/orders", { amount: 5000 })).body;

  const orders = (await ann("GET", "/orders")).body.data as { id: string }[];
  expect(orders.map((order) => order.id)).toContain(mine.id);
  expect(orders.map((order) => order.id)).not.toContain(other.id);
  expect((await ann("GET", `/orders/${mine.id}`)).status).toBe(200);
  expect((await ann("GET", `/orders/${other.id}`)).status).toBe(404);
  const managed = (await mila("GET", "/orders")).body.data as { id: string }[];
  expect(managed.map((order) => order.id)).toEqual(expect.arrayContaining([mine.id, other.id]));

  const instances = (await ann("GET", "/workflow/instances?page[size]=200")).body.data as { id: string; businessKey: string }[];
  expect(instances.map((instance) => instance.businessKey)).toContain(`order:${mine.id}`);
  expect(instances.map((instance) => instance.businessKey)).not.toContain(`order:${other.id}`);
  const others = (await mila("GET", `/workflow/instances?filter[businessKey]=order:${other.id}`)).body.data[0];
  expect((await ann("GET", `/workflow/instances/${others.id}`)).status).toBe(403);
});

test.skipIf(!enabled)("the task goes to the role of its assignee, and the decision moves the process", async () => {
  const order = (await ann("POST", "/orders", { amount: 5000 })).body;
  const task = await reviewTask(`order:${order.id}`);
  expect((await root("GET", `/workflow/tasks/${task.id}`)).status).toBe(404);

  expect((await mila("POST", `/workflow/tasks/${task.id}/complete`, { output: { approved: true } })).body.status).toBe("completed");
  expect(await statusOf(order.id, "approved")).toBe("approved");
});

test.skipIf(!enabled)("a step knows on whose behalf it runs, and its Tool describes what it takes", async () => {
  const order = (await ann("POST", "/orders", { amount: 10 })).body;
  // The order changes in the Tool; the instance takes the result right after.
  let instance = (await mila("GET", `/workflow/instances?filter[businessKey]=order:${order.id}`)).body.data[0];
  for (let attempt = 0; attempt < 200 && instance.status !== "completed"; attempt++) {
    await Bun.sleep(25);
    instance = (await mila("GET", `/workflow/instances/${instance.id}`)).body;
  }
  expect((await mila("GET", `/workflow/instances/${instance.id}`)).body.nodes.Approve).toEqual({ status: "approved", by: "ann" });

  const tools = (await mila("GET", "/workflow/tools")).body.data as { name: string; dryRun: string; input: { schema: { properties: Record<string, unknown> } } }[];
  const tool = tools.find((item) => item.name === "orders.set-status")!;
  expect(tool.dryRun).toBe("unsupported");
  expect(tool.input.schema.properties.orderId).toMatchObject({ type: "string", "x-ref": "orders.order" });
});

test.skipIf(!enabled)("the audit log keeps who did what and from where", async () => {
  const order = (await ann("POST", "/orders", { amount: 5000 })).body;
  const task = await reviewTask(`order:${order.id}`);
  await mila("POST", `/workflow/tasks/${task.id}/complete`, { output: { approved: false } });

  expect((await mila("GET", "/audit")).status).toBe(403);
  const entries = (await root("GET", `/audit?filter[action]=task.completed&filter[target]=${task.id}`)).body;
  expect(entries.meta.total).toBe(1);
  expect(entries.data[0]).toMatchObject({ action: "task.completed", target: task.id, actorId: "mila" });
  expect(entries.data[0].ip).not.toBeNull();

  const instances = (await root("GET", "/audit?filter[action][startsWith]=instance.&page[size]=1")).body;
  expect(instances.data[0]).toMatchObject({ action: "instance.started", actorId: "ann" });
});

test.skipIf(!enabled)("the catalog shows what the modules let an administrator allow", async () => {
  expect((await mila("GET", "/access/catalog")).status).toBe(403);
  const keys = ((await root("GET", "/access/catalog")).body.data as { key: string }[]).map((item) => item.key);
  expect(keys).toEqual(expect.arrayContaining(["orders.read", "workflow.tasks.work"]));
  const processes = (await root("GET", "/access/references/workflow.process")).body.data as { id: string }[];
  expect(processes.map((process) => process.id)).toContain("order-approval");
});
