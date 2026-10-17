import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestApp, type TestApp } from "@/core/testing";
import { CatalogController, CatalogModule } from "./fixtures/sourceControllers";

// 0.101.0: explicit argument sources. FromQuery/FromHeader/FromBody/FromRoute
// mark where an argument comes from; a query or header model is bound and
// validated like a body, before the action runs.

// The controller is a target-local codegen fixture (bazis.config.json, target
// "test"); its generated bindings are registered before the app starts.
import "../../../../generated/bazis/targets/test/bootstrap";

const TENANT = "0f8fad5b-d9cb-469f-a165-70867728950e";
let app: TestApp;
let ru: TestApp;

beforeAll(async () => {
  app = await startTestApp(CatalogModule);
  ru = await startTestApp(CatalogModule, { language: "ru" });
});
afterAll(async () => {
  await app.stop();
  await ru.stop();
});
beforeEach(() => {
  CatalogController.calls = 0;
});

async function get(path: string, headers?: Record<string, string>, on: TestApp = app): Promise<{ status: number; body: any }> {
  const response = await on.fetch(path, { headers });
  return { status: response.status, body: await response.json() };
}

describe("FromQuery<Model>", () => {
  test("binds declared fields by their wire names, converts types and keeps defaults", async () => {
    expect(await get("/catalog/search?q=dune&page_size=5&tags=a&tags=b&onlyNew=true")).toEqual({
      status: 200,
      body: { q: "dune", pageSize: 5, sort: "new", tags: ["a", "b"], onlyNew: true, isSearchQuery: true },
    });
    expect((await get("/catalog/search?q=du")).body).toEqual({ q: "du", pageSize: 20, sort: "new", tags: [], onlyNew: false, isSearchQuery: true });
  });

  test("every problem in one 400, named as the client sent it, and the action is not called", async () => {
    expect(await get("/catalog/search?q=d&page_size=abc&sort=cheap")).toEqual({
      status: 400,
      body: {
        error: "Validation failed",
        details: [
          { property: "page_size", message: 'Field "page_size" must be of type number, got: string', code: "type" },
          { property: "q", message: 'Field "q" must be at least 2 characters long', code: "minLength" },
          { property: "sort", message: 'Field "sort" must be one of: new, popular, price', code: "enum" },
        ],
      },
    });
    expect((await get("/catalog/search?q=dune&page_size=500")).body.details).toEqual([
      { property: "page_size", message: 'Field "page_size" must be between 1 and 100', code: "range" },
    ]);
    expect((await get("/catalog/search")).body.details).toEqual([{ property: "q", message: 'Field "q" is required', code: "required" }]);
    expect(CatalogController.calls).toBe(0);
  });

  test("a repeated single parameter is refused instead of taking one of the values", async () => {
    expect((await get("/catalog/search?q=dune&page_size=1&page_size=100")).body.details).toEqual([
      { property: "page_size", message: 'Parameter "page_size" must be given once', code: "duplicate" },
    ]);
    expect(CatalogController.calls).toBe(0);
  });

  test("an array field is bounded, then validated", async () => {
    const many = Array.from({ length: 101 }, (_, index) => `tags=t${index}`).join("&");
    expect((await get(`/catalog/search?q=dune&${many}`)).body.details).toEqual([
      { property: "tags", message: 'Parameter "tags" accepts at most 100 values', code: "tooManyValues" },
    ]);
    expect((await get("/catalog/search?q=dune&tags=a&tags=b&tags=c&tags=d")).body.details[0].code).toBe("maxItems");
  });

  test("undeclared parameters and prototype keys are ignored", async () => {
    const { status, body } = await get("/catalog/search?q=dune&admin=true&__proto__=x&constructor=y&pageSize=99");
    expect(status).toBe(200);
    expect(body).toEqual({ q: "dune", pageSize: 20, sort: "new", tags: [], onlyNew: false, isSearchQuery: true });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe("FromHeader", () => {
  test("a header model is matched case-insensitively and validated", async () => {
    expect(await get("/catalog/tenant", { "X-Tenant-Id": TENANT, "x-trace": "t1" })).toEqual({ status: 200, body: { tenantId: TENANT, trace: "t1" } });
    expect(await get("/catalog/tenant")).toEqual({
      status: 400,
      body: { error: "Validation failed", details: [{ property: "x-tenant-id", message: 'Field "x-tenant-id" is required', code: "required" }] },
    });
    expect((await get("/catalog/tenant", { "x-tenant-id": "nope" })).body.details).toEqual([
      { property: "x-tenant-id", message: 'Field "x-tenant-id" must be a valid UUID', code: "uuid" },
    ]);
    expect(CatalogController.calls).toBe(1);
  });

  test("a primitive header, a renamed query parameter and a route parameter", async () => {
    expect((await get("/catalog/items/7?page_size=3", { "x-request-id": "r1" })).body).toEqual({ id: 7, size: 3, requestId: "r1" });
    expect((await get("/catalog/items/7")).body).toEqual({ id: 7, size: 10, requestId: null });
  });

  test("FromBody with a required header: a missing header is a 400 before the body is used", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      app.fetch("/catalog/items", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const missing = await post({}, { title: "Dune" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'Missing required header parameter "x-request-id"' });
    expect(await (await post({ "x-request-id": "r2" }, { title: "Dune" })).json()).toEqual({ title: "Dune", requestId: "r2" });
    expect((await (await post({ "x-request-id": "r2" }, { title: "" })).json()).details[0].code).toBe("minLength");
  });
});

test("messages follow the application language", async () => {
  expect((await get("/catalog/search?q=dune&page_size=1&page_size=2", undefined, ru)).body).toEqual({
    error: "Проверка данных не пройдена",
    details: [{ property: "page_size", message: 'Параметр "page_size" передан несколько раз', code: "duplicate" }],
  });
  expect((await get("/catalog/search?q=dune&page_size=abc", undefined, ru)).body.details).toEqual([
    { property: "page_size", message: 'Поле "page_size": ожидается число, получено: строка', code: "type" },
  ]);
});

test("OpenAPI lists model fields as parameters under their wire names", async () => {
  const document = await (await app.fetch("/docs/openapi.json")).json() as { paths: Record<string, Record<string, { parameters: { name: string; in: string; required: boolean; schema: Record<string, unknown>; description?: string }[] }>> };
  const search = document.paths["/catalog/search"]!.get!.parameters;
  expect(search.map((parameter) => [parameter.name, parameter.in, parameter.required])).toEqual([
    ["q", "query", true], ["page_size", "query", false], ["sort", "query", false], ["tags", "query", false], ["onlyNew", "query", false],
  ]);
  expect(search.find((parameter) => parameter.name === "page_size")).toMatchObject({ description: "Page size, 1–100.", schema: { maximum: 100 } });
  expect(document.paths["/catalog/tenant"]!.get!.parameters.map((parameter) => [parameter.name, parameter.in, parameter.required])).toEqual([
    ["x-tenant-id", "header", true], ["x-trace", "header", false],
  ]);
  expect(document.paths["/catalog/items/{id}"]!.get!.parameters.map((parameter) => [parameter.name, parameter.in])).toEqual([
    ["id", "path"], ["page_size", "query"], ["x-request-id", "header"],
  ]);
});
