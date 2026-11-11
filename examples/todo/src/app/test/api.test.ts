import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "bazis/core/testing";
import { TodoApp } from "../App";

// End-to-end: starts the application declared in src/app/App.ts against a real
// PostgreSQL and drives it over HTTP. Needs a database: BAZIS_DB__HOST (and
// BAZIS_DB__PORT/... if not default). Without it the test is reported as
// skipped, not passed.
const enabled = Boolean(process.env.BAZIS_DB__HOST);
let app: TestApp | undefined;

beforeAll(async () => {
  if (enabled) app = await startTestApp(TodoApp);
});

afterAll(async () => {
  await app?.stop();
});

interface Report { projects: number; tasks: number; done: number }
interface Item { id: string; done?: boolean }

const send = (method: string, path: string, body?: unknown) =>
  app!.fetch(path, {
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
  const taken = await send("POST", "/projects", { name });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toEqual({ error: "A project with this name already exists", details: { code: "unique", fields: ["name"] } });
  const missing = await send("GET", `/projects/${crypto.randomUUID()}`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Not Found" });

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
