import { afterAll, beforeAll, expect, test } from "bun:test";

// End-to-end: starts the app from source against a real PostgreSQL and drives
// it over HTTP. Needs a database: BAZIS_DB__HOST (and BAZIS_DB__PORT/... if not
// default). Without it the test is reported as skipped, not passed.
const enabled = Boolean(process.env.BAZIS_DB__HOST);
const port = String(20000 + Math.floor(Math.random() * 20000));
const base = `http://127.0.0.1:${port}`;
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

interface Report { projects: number; tasks: number; done: number }
interface Item { id: string; done?: boolean }

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(response: Promise<Response> | Response) => await (await response).json() as T;

test.skipIf(!enabled)("projects, tasks and the report work together", async () => {
  const name = `Website ${crypto.randomUUID()}`;
  const before = await json<Report>(send("GET", "/report"));

  const created = await send("POST", "/projects", { name });
  expect(created.status).toBe(201);
  const project = await json<Item>(created);
  expect((await send("POST", "/projects", { name })).status).toBe(409);

  // The unique index decides under concurrency: exactly one request wins.
  const racing = `Race ${crypto.randomUUID()}`;
  const statuses = await Promise.all([1, 2, 3].map(() => send("POST", "/projects", { name: racing }).then((response) => response.status)));
  expect(statuses.sort()).toEqual([201, 409, 409]);

  const first = await json<Item>(send("POST", "/tasks", { projectId: project.id, title: "Write landing copy" }));
  const second = await json<Item>(send("POST", "/tasks", { projectId: project.id, title: "Ship it" }));
  expect((await json<Item>(send("PUT", `/tasks/${second.id}`, { done: true }))).done).toBe(true);

  const open = await json<{ data: Item[] }>(send("GET", `/tasks?filter[projectId]=${project.id}&filter[done]=false`));
  expect(open.data.map((task) => task.id)).toEqual([first.id]);

  expect((await send("POST", "/tasks", { projectId: crypto.randomUUID(), title: "Orphan" })).status).toBe(400);
  expect((await send("POST", "/tasks", { projectId: "not-a-uuid", title: "" })).status).toBe(400);
  expect((await send("PUT", `/tasks/${first.id}`, { done: "yes" })).status).toBe(400);

  expect(await json<Report>(send("GET", "/report"))).toEqual({
    projects: before.projects + 2,
    tasks: before.tasks + 2,
    done: before.done + 1,
  });
});
