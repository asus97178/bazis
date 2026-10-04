import { describe, expect, test } from "bun:test";
import {
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  canonicalUiJson,
  compileUiSurfaceV1,
  defineUiProfile,
  type UiProfileV1,
} from "../index";

describe("compileUiSurfaceV1", () => {
  test("compiles a transport-free feature page and requires its exact renderer capability", () => {
    const feature = defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "datamanager", surface: "admin", owner: "DataManagerModule" },
      spec: {
        resources: [],
        customPages: [{
          id: "datamanager",
          title: "DataManager",
          kind: "feature",
          renderer: "datamanager.schema/v1",
          navigation: { group: "System" },
        }],
      },
    });
    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [feature],
      openApi: { openapi: "3.1.0", info: { title: "Empty", version: "1" }, paths: {} },
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.spec.customPages).toEqual([{
      id: "datamanager",
      title: "DataManager",
      route: "/pages/datamanager",
      kind: "feature",
      renderer: "datamanager.schema/v1",
    }]);
    expect(result.document.spec.requiredRendererCapabilities).toEqual(["datamanager.schema/v1"]);
    expect(result.document.spec.navigation).toEqual([expect.objectContaining({
      id: "datamanager",
      page: "datamanager",
      route: "/pages/datamanager",
    })]);
  });

  test("compiles a surface from stable OpenAPI operation references", () => {
    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [profile()],
      openApi: productOpenApi(),
      links: { openapi: "/api/ui/admin/openapi", session: "/api/ui/admin/session" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.diagnostics).toEqual([]);
    expect(result.document.metadata.surface).toBe("admin");
    expect(result.document.metadata.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.document.spec.navigation).toEqual([{
      id: "products",
      title: "Products",
      route: "/resources/products",
      resource: "products",
      group: "Catalog",
      order: 10,
    }]);
    expect(result.document.spec.resources[0]?.operations).toEqual({
      create: { operationId: "products.create" },
      list: { operationId: "products.list" },
      read: { operationId: "products.get" },
    });
    expect(result.document.spec.resources[0]?.keyField).toBe("id");
    expect(canonicalUiJson(result.document)).not.toContain("permissions");
    expect(canonicalUiJson(result.document)).not.toContain("controller");
  });

  test("isolates profiles by surface and creates a deterministic revision", () => {
    const options = {
      surface: "admin",
      profiles: [profile(), defineUiProfile({
        apiVersion: UI_PROFILE_V1_API_VERSION,
        kind: UI_PROFILE_V1_KIND,
        metadata: { name: "employee", surface: "employee", owner: "ProductModule" },
        spec: { resources: [{ id: "employee-products" }] },
      })],
      openApi: productOpenApi(),
      links: { openapi: "/api/ui/admin/openapi" },
    } as const;

    const first = compileUiSurfaceV1(options);
    const second = compileUiSurfaceV1(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.document.spec.resources.map((resource) => resource.id)).toEqual(["products"]);
    expect(first.document.metadata.revision).toBe(second.document.metadata.revision);
  });

  test("uses canonical filter extensions and limit.maximum for generic list transports", () => {
    const openApi = productOpenApi();
    const list = openApi.paths["/api/products"].get as Record<string, unknown>;
    list.parameters = [
      { name: "sort", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer", maximum: 25 } },
      { name: "filter", in: "query", style: "form", explode: true, schema: { type: "array" } },
    ];
    list["x-osnova-list-filters"] = { name: ["contains", "eq"] };

    const valid = compileUiSurfaceV1({
      surface: "admin",
      profiles: [profile()],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(valid.ok).toBe(true);

    const oversized = defineUiProfile({
      ...profile(),
      metadata: { name: "oversized", surface: "admin", owner: "ProductModule" },
      spec: {
        resources: [{
          ...profile().spec.resources[0]!,
          id: "oversized",
          list: { ...profile().spec.resources[0]!.list, pageSize: 26 },
        }],
      },
    });
    const invalid = compileUiSurfaceV1({
      surface: "admin",
      profiles: [oversized],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.some((item) => item.code === "UIV1_PAGE_SIZE_EXCEEDS_API_MAXIMUM")).toBe(true);
  });

  test("resolves an entity schema from a top-level array response", () => {
    const openApi = productOpenApi();
    const list = openApi.paths["/api/products"].get;
    const media = list.responses["200"].content["application/json"] as { schema: Record<string, unknown> };
    media.schema = {
      type: "array",
      items: { $ref: "#/components/schemas/Product" },
    };

    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [profile()],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(true);
  });

  test("validates a natural key from an items list response without a read operation", () => {
    const listOnly = defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "settings-admin", surface: "admin", owner: "SettingsModule" },
      spec: {
        resources: [{
          id: "settings",
          keyField: "code",
          operations: { list: { operationId: "settings.list" } },
          list: { columns: ["code", "value"] },
        }],
      },
    });
    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [listOnly],
      openApi: {
        openapi: "3.1.0",
        paths: {
          "/api/settings": {
            get: {
              operationId: "settings.list",
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          items: {
                            type: "array",
                            items: { $ref: "#/components/schemas/Setting" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Setting: {
              type: "object",
              properties: {
                code: { type: "string" },
                value: {},
              },
              required: ["code", "value"],
            },
          },
        },
      },
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.spec.resources[0]?.keyField).toBe("code");
    }
  });

  test("returns stable diagnostics instead of guessing missing facts", () => {
    const invalid = defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "invalid", surface: "admin", owner: "ProductModule" },
      spec: {
        resources: [{
          id: "products",
          operations: {
            list: { operationId: "products.missing" },
            create: { operationId: "products.create" },
          },
          list: {
            columns: ["unknown"],
            selectionFields: ["unknown"],
            defaultSort: "unknown",
            pageSize: 1000,
          },
          forms: {
            create: {
              uiSchema: {
                type: "Control",
                scope: "#/properties/unknown",
              },
            },
          },
        }],
      },
    });

    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [invalid],
      openApi: productOpenApi(),
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "UIV1_OPERATION_NOT_FOUND",
      "UIV1_RESPONSE_SCHEMA_MISSING",
      "UIV1_FILTER_NOT_SUPPORTED",
      "UIV1_SORT_NOT_SUPPORTED",
      "UIV1_FORM_FIELD_NOT_FOUND",
    ]);
  });

  test("rejects a key field that is absent from the response schema", () => {
    const invalid = defineUiProfile({
      ...profile(),
      metadata: { name: "invalid-key", surface: "admin", owner: "ProductModule" },
      spec: {
        resources: [{ ...profile().spec.resources[0]!, keyField: "missing" }],
      },
    });

    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [invalid],
      openApi: productOpenApi(),
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "UIV1_KEY_FIELD_NOT_FOUND",
      resource: "products",
      path: "keyField",
    }));
  });

  test("rejects duplicate logical resource identities", () => {
    const duplicate = defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: "duplicate", surface: "admin", owner: "OtherModule" },
      spec: { resources: [{ id: "products" }] },
    });

    const result = compileUiSurfaceV1({
      surface: "admin",
      profiles: [profile(), duplicate],
      openApi: productOpenApi(),
      links: { openapi: "/api/ui/admin/openapi" },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.at(-1)?.code).toBe("UIV1_DUPLICATE_RESOURCE");
  });

  test("keeps generic actions bodyless with an unambiguous record or list context", () => {
    const openApi = {
      openapi: "3.1.0",
      paths: {
        "/api/products/{id}/archive": {
          delete: {
            operationId: "actions.archive",
            parameters: [{ name: "id", in: "path", required: true }],
          },
        },
        "/api/products/export": {
          post: {
            operationId: "actions.export",
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
        "/api/products/{id}/publish": {
          post: { operationId: "actions.publish" },
        },
        "/api/products/rebuild": {
          post: {
            operationId: "actions.rebuild",
            parameters: [{ name: "force", in: "query", required: true }],
          },
        },
      },
    };

    expect(compileUiSurfaceV1({
      surface: "admin",
      profiles: [actionProfile("actions.archive", ["list.row", "detail.header"])],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    }).ok).toBe(true);

    const body = compileUiSurfaceV1({
      surface: "admin",
      profiles: [actionProfile("actions.export", ["list.header"])],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(body.diagnostics).toContainEqual(expect.objectContaining({
      code: "UIV1_ACTION_REQUEST_BODY_UNSUPPORTED",
    }));

    const path = compileUiSurfaceV1({
      surface: "admin",
      profiles: [actionProfile("actions.publish", ["list.header"])],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(path.diagnostics).toContainEqual(expect.objectContaining({
      code: "UIV1_ACTION_PATH_SHAPE_UNSUPPORTED",
    }));

    const parameter = compileUiSurfaceV1({
      surface: "admin",
      profiles: [actionProfile("actions.rebuild", ["list.header"])],
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(parameter.diagnostics).toContainEqual(expect.objectContaining({
      code: "UIV1_ACTION_REQUIRED_PARAMETER_UNSUPPORTED",
    }));
  });
});

function actionProfile(
  operationId: string,
  placements: readonly ("list.header" | "list.row" | "detail.header")[],
): UiProfileV1 {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: { name: `action-${operationId}`, surface: "admin", owner: "test" },
    spec: {
      resources: [{
        id: "products",
        actions: [{ id: "action", title: "Action", operation: { operationId }, placements }],
      }],
    },
  });
}

function profile(): UiProfileV1 {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: { name: "product-admin", surface: "admin", owner: "ProductModule" },
    spec: {
      resources: [{
        id: "products",
        title: "Products",
        keyField: "id",
        navigation: { group: "Catalog", order: 10 },
        operations: {
          list: { operationId: "products.list" },
          read: { operationId: "products.get" },
          create: { operationId: "products.create" },
        },
        list: {
          columns: ["id", "name"],
          selectionFields: ["name"],
          defaultSort: "name",
          pageSize: 20,
        },
        forms: {
          create: {
            uiSchema: {
              type: "VerticalLayout",
              elements: [{ type: "Control", scope: "#/properties/name" }],
            },
          },
        },
      }],
    },
  });
}

function productOpenApi() {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/products": {
        get: {
          operationId: "products.list",
          parameters: [
            { name: "sort", in: "query", schema: { type: "string" } },
            { name: "page[size]", in: "query", schema: { type: "integer", maximum: 100 } },
            { name: "filter[name][contains]", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Product" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "products.create",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateProduct" },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Product" },
                },
              },
            },
          },
        },
      },
      "/api/products/{id}": {
        get: {
          operationId: "products.get",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Product" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Product: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
          required: ["id", "name"],
        },
        CreateProduct: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2 },
          },
          required: ["name"],
        },
      },
    },
  };
}
