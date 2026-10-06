import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import { HttpServer, httpModule, useModelValidator } from "@/core/http";
import { modelValidatorAdapter } from "@/library/validation";
import { ConventionController } from "./fixtures/conventionControllers";

// The controller is an explicitly declared target-local codegen fixture. Its
// generated descriptor is registered before the test host creates routes.
import "../../../../generated/bazis/targets/test/bootstrap";

let container: DiContainer;
let server: HttpServer;
let base: string;

beforeAll(async () => {
  useModelValidator(modelValidatorAdapter);

  @Module({
    imports: [httpModule({ controllers: [ConventionController], port: 0, docs: true })],
  })
  class ConventionsAppModule {}

  container = createContainer(ConventionsAppModule, { validateOnBuild: true });
  server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  await container.dispose();
});

describe("binding conventions (codegen, by signature)", () => {
  test("route parameter by name with constraint conversion", async () => {
    const response = await fetch(`${base}/conv/items/42`);
    expect(await response.json()).toEqual({ code: 42, flag: false, codeType: "number" });
  });

  test("query bool with a default value and no type annotation", async () => {
    const response = await fetch(`${base}/conv/items/42?flag=true`);
    expect(await response.json()).toEqual({ code: 42, flag: true, codeType: "number" });
  });

  test("required query primitive: missing -> 400", async () => {
    const ok = await fetch(`${base}/conv/search?q=phone&page=2`);
    expect(await ok.json()).toEqual({ q: "phone", page: 2 });

    const optional = await fetch(`${base}/conv/search?q=phone`);
    expect(await optional.json()).toEqual({ q: "phone", page: null });

    const missing = await fetch(`${base}/conv/search`);
    expect(missing.status).toBe(400);
  });

  test("class with @RequestModel -> request body + validation -> 400", async () => {
    const created = await fetch(`${base}/conv/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: "table", quantity: 2 }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ accepted: "table", quantity: 2 });

    const invalid = await fetch(`${base}/conv/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: "x", quantity: -1 }),
    });
    expect(invalid.status).toBe(400);
    const payload = (await invalid.json()) as { details: { property: string }[] };
    expect(payload.details.map((d) => d.property).sort()).toEqual(["product", "quantity"]);
  });

  test("HttpContext and ResponseBuilder are recognized by parameter type", async () => {
    const response = await fetch(`${base}/conv/special/world`);
    expect(response.headers.get("x-conv")).toBe("yes");
    expect(await response.json()).toEqual({ name: "world", path: "/conv/special/world" });
  });

  test("generated OpenAPI docs describe convention bindings and request models", async () => {
    const response = await fetch(`${base}/docs/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi: string;
      paths: Record<string, Record<string, {
        parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }[];
        requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> };
      }>>;
      components: { schemas: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
    };

    expect(spec.openapi).toBe("3.1.0");
    const item = spec.paths["/conv/items/{code}"]?.get;
    expect(item?.parameters).toContainEqual({
      name: "code",
      in: "path",
      required: true,
      schema: { type: "integer" },
    });
    expect(item?.parameters).toContainEqual({
      name: "flag",
      in: "query",
      required: false,
      schema: { type: "boolean" },
    });

    const create = spec.paths["/conv/orders"]?.post;
    expect(create?.requestBody?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/ConventionOrderDto",
    });
    expect(spec.components.schemas.ConventionOrderDto?.properties?.product?.minLength).toBe(2);
    expect(spec.components.schemas.ConventionOrderDto?.properties?.quantity?.exclusiveMinimum).toBe(0);
  });

  test("generated API docs UI is served without external assets", async () => {
    const response = await fetch(`${base}/docs`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("/docs/openapi.json");
    expect(html).toContain("fetch(specPath)");
  });
});
