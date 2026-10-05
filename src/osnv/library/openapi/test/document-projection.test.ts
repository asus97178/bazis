import { describe, expect, test } from "bun:test";
import { projectOpenApiByOperationIds } from "../document";

describe("projectOpenApiByOperationIds", () => {
  test("keeps only allowed paths and their transitive schemas", () => {
    const projected = projectOpenApiByOperationIds(document(), ["products.list"]);
    const paths = projected.paths as Record<string, Record<string, unknown>>;
    const components = projected.components as Record<string, Record<string, unknown>>;

    expect(Object.keys(paths)).toEqual(["/api/products"]);
    expect(Object.keys(paths["/api/products"] ?? {})).toEqual(["get"]);
    expect(Object.keys(components.schemas ?? {}).sort()).toEqual(["Product", "ProductList"]);
    expect(components.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
  });

  test("fails closed when an allowed operation does not exist", () => {
    expect(() => projectOpenApiByOperationIds(document(), ["missing.operation"]))
      .toThrow("OpenAPI operations not found: missing.operation");
  });
});

function document() {
  return {
    openapi: "3.1.0",
    info: { title: "Projection", version: "1" },
    paths: {
      "/api/products": {
        get: {
          operationId: "products.list",
          responses: {
            "200": {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ProductList" } },
              },
            },
          },
        },
        post: { operationId: "products.create", responses: { "201": { description: "Created" } } },
      },
      "/api/admins": {
        get: {
          operationId: "admins.list",
          responses: {
            "200": {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Admin" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ProductList: { type: "array", items: { $ref: "#/components/schemas/Product" } },
        Product: { type: "object", properties: { id: { type: "integer" } } },
        Admin: { type: "object", properties: { secret: { type: "string" } } },
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  };
}
