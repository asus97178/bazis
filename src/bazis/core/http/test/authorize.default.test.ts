import { afterAll, beforeAll, expect, test } from "bun:test";
import { Module } from "@/core/di";
import { AllowAnonymous, Authorize, Controller, Get, PRINCIPAL_STATE_KEY, UnauthorizedError, type AuthorizeCheck } from "@/core/http";
import { startTestApp, type TestApp } from "@/core/testing";

const calls: string[] = [];
const signedIn: AuthorizeCheck = (ctx) => {
  calls.push("signedIn");
  const header = ctx.header("authorization");
  if (header === undefined) throw new UnauthorizedError();
  ctx.state.set(PRINCIPAL_STATE_KEY, { subject: "ann", role: header === "Bearer admin" ? "admin" : "user" });
  return true;
};
const admin: AuthorizeCheck = (ctx) => {
  calls.push("admin");
  return (ctx.state.get(PRINCIPAL_STATE_KEY) as { role: string }).role === "admin";
};

@Controller("reports")
class ReportsController {
  @Get()
  list() { return ["q1"]; }

  @Get("public")
  @AllowAnonymous()
  open() { return "open"; }

  @Get("admin")
  @Authorize(admin)
  secret() { return "secret"; }

  @Get("twice")
  @Authorize(signedIn)
  twice() { return "once"; }
}

@Module({ controllers: [ReportsController], exports: [] })
class App {}

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp(App, { http: { authorize: signedIn, health: true, docs: true } });
});
afterAll(async () => {
  await app.stop();
});

const get = (path: string, token?: string) => app.fetch(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });

test("http.authorize closes every route that is not @AllowAnonymous", async () => {
  expect((await get("/reports")).status).toBe(401);
  expect((await get("/reports", "ann")).status).toBe(200);
  expect((await get("/reports/public")).status).toBe(200);
  expect((await get("/health")).status).toBe(200);
});

test("a route's own @Authorize runs after the default check; the same check runs once", async () => {
  calls.length = 0;
  expect((await get("/reports/admin", "ann")).status).toBe(403);
  expect(calls).toEqual(["signedIn", "admin"]);
  expect((await get("/reports/admin")).status).toBe(401);
  expect((await get("/reports/admin", "admin")).status).toBe(200);
  calls.length = 0;
  expect((await get("/reports/twice", "ann")).status).toBe(200);
  expect(calls).toEqual(["signedIn"]);
});

test("OpenAPI marks the routes closed by default as secured", async () => {
  const doc = await (await get("/docs/openapi.json")).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
  expect(doc.paths["/reports"]?.get?.security?.length).toBeGreaterThan(0);
  expect(doc.paths["/reports/public"]?.get?.security).toBeUndefined();
});
