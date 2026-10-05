import { describe, expect, test } from "bun:test";
import { ApiVersion, Controller, Get } from "../index";
import { buildHttpOpenApiDocument } from "../OpenApi/openApiDocument";

@Controller("catalog")
class OriginalCatalogController {
  @Get("items/:id")
  findItem(): object {
    return {};
  }
}

@Controller("catalog")
class RenamedCatalogController {
  @Get("items/:id")
  loadRenamed(): object {
    return {};
  }
}

@Controller("catalog")
class SlugCollisionController {
  @Get("items/a-b")
  dash(): object {
    return {};
  }

  @Get("items/a_b")
  underscore(): object {
    return {};
  }
}

@ApiVersion("1")
@Controller("status")
class StatusV1Controller {
  @Get()
  readV1(): object {
    return {};
  }
}

@ApiVersion("2")
@Controller("status")
class StatusV2Controller {
  @Get()
  readV2(): object {
    return {};
  }
}

describe("HTTP OpenAPI operation identity", () => {
  test("is deterministic and stable across controller and handler renames", () => {
    const original = operationIdAt(document([OriginalCatalogController]), "/api/catalog/items/{id}", "get");
    const renamed = operationIdAt(document([RenamedCatalogController]), "/api/catalog/items/{id}", "get");

    expect(original).toBe(renamed);
    expect(original).toMatch(/^http_get_api_catalog_items_by_id__[a-f0-9]{32}$/);
    expect(original).not.toContain("Controller");
    expect(original).not.toContain("findItem");
  });

  test("uses the digest to distinguish paths with the same readable slug", () => {
    const openApi = document([SlugCollisionController]);
    const dash = operationIdAt(openApi, "/api/catalog/items/a-b", "get");
    const underscore = operationIdAt(openApi, "/api/catalog/items/a_b", "get");

    expect(dash).toMatch(/^http_get_api_catalog_items_a_b__[a-f0-9]{32}$/);
    expect(underscore).toMatch(/^http_get_api_catalog_items_a_b__[a-f0-9]{32}$/);
    expect(dash).not.toBe(underscore);
  });

  test("keeps one identity when query-versioned operations share a method and path", () => {
    const openApi = buildHttpOpenApiDocument({
      controllers: [StatusV1Controller, StatusV2Controller],
      globalPrefix: "api",
      versioning: { source: "query", parameterName: "v" },
      title: "Stable operation ids",
      version: "1",
    });
    const operation = operationAt(openApi, "/api/status", "get");

    expect(operation["operationId"]).toMatch(/^http_get_api_status__[a-f0-9]{32}$/);
    expect(operation["x-osnv-versions"]).toEqual(["1", "2"]);
  });
});

function document(controllers: Parameters<typeof buildHttpOpenApiDocument>[0]["controllers"]) {
  return buildHttpOpenApiDocument({
    controllers,
    globalPrefix: "api",
    title: "Stable operation ids",
    version: "1",
  });
}

function operationIdAt(
  openApi: ReturnType<typeof buildHttpOpenApiDocument>,
  path: string,
  method: string,
): string {
  const operationId = operationAt(openApi, path, method)["operationId"];
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new TypeError(`OpenAPI operation ${method.toUpperCase()} ${path} has no operationId.`);
  }
  return operationId;
}

function operationAt(
  openApi: ReturnType<typeof buildHttpOpenApiDocument>,
  path: string,
  method: string,
): Readonly<Record<string, unknown>> {
  const paths = openApi["paths"] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const operation = paths[path]?.[method];
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    throw new TypeError(`OpenAPI operation ${method.toUpperCase()} ${path} was not found.`);
  }
  return operation as Readonly<Record<string, unknown>>;
}
