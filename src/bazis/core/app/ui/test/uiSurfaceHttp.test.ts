import { describe, expect, test } from "bun:test";
import type { HttpContext } from "@/core/http";
import {
  COMPILED_UI_SURFACE_V1_API_VERSION,
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  defineUiProfile,
} from "@/library/ui";
import type { OpenApiSchema } from "@/library/openapi";
import type { RunAppUiSurfaceOptions, UiSurfaceHostingOptions } from "../uiSurfaceHosting";
import { UiProfileV1Registry } from "../uiProfileResolver";
import {
  UiSurfaceDocumentProvider,
  UiSurfaceHttpController,
  type UiSurfacePolicyDecision,
} from "../uiSurfaceHttp";

describe("compiled UI surface hosting", () => {
  test("applies monotonic operation/action decisions and publishes prefix-derived links", async () => {
    const policy: UiSurfacePolicyDecision = {
      resources: [{
        resource: "products",
        visible: true,
        operations: { list: true, read: true },
        actions: [],
      }],
    };
    const provider = providerFor(policy);
    const document = await provider.effective(context("admin"));
    const product = document.spec.resources[0];

    expect(document.apiVersion).toBe(COMPILED_UI_SURFACE_V1_API_VERSION);
    expect(document.links).toEqual({
      openapi: "/v2/api/ui/admin/openapi",
      session: "/v2/api/ui/admin/session",
    });
    expect(product?.operations).toEqual({
      list: { operationId: "products.list" },
      read: { operationId: "products.read" },
    });
    expect(product?.keyField).toBe("id");
    expect(product?.actions).toEqual([]);
    expect(product?.forms).toBeUndefined();
  });

  test("defaults missing resource decisions to deny and checks unknown surface before auth", async () => {
    let authorizationChecks = 0;
    const provider = providerFor({ resources: [] }, () => {
      authorizationChecks += 1;
      return true;
    });

    expect((await provider.effective(context("admin"))).spec.resources).toEqual([]);
    await expect(provider.effective(context("unknown"))).rejects.toThrow("not found");
    expect(authorizationChecks).toBe(1);
  });

  test("does not evaluate policy when surface authorization is denied", async () => {
    let policyChecks = 0;
    const surface: RunAppUiSurfaceOptions = {
      surface: "admin",
      authorize: () => false,
      policy: () => {
        policyChecks += 1;
        return { resources: [] };
      },
      session: () => ({ id: "a1", kind: "admin", displayName: "Admin" }),
    };
    const provider = new UiSurfaceDocumentProvider(
      { ...baseOptions(), surfaces: [surface] },
      new UiProfileV1Registry([productProfile()]),
      openApi(),
    );

    await expect(provider.effective(context("admin"))).rejects.toMatchObject({ status: 403 });
    expect(policyChecks).toBe(0);
  });

  test("filters OpenAPI by effective operation ids and strips unsafe session properties", async () => {
    const provider = providerFor({
      resources: [{
        resource: "products",
        visible: true,
        operations: { list: true },
      }],
    });
    const openApi = await provider.openApi(context("admin"));
    const paths = openApi.paths as Record<string, Record<string, unknown>>;
    const schemas = (openApi.components as Record<string, Record<string, unknown>>).schemas;
    const session = await provider.session(context("admin"));

    expect(Object.keys(paths)).toEqual(["/api/products"]);
    expect(Object.keys(paths["/api/products"] ?? {})).toEqual(["get"]);
    expect(Object.keys(schemas ?? {}).sort()).toEqual(["Product", "ProductList"]);
    expect(session.metadata.surface).toBe("admin");
    expect(session.currentUser).toEqual({ id: "a1", kind: "admin", displayName: "Admin" });
    expect("claims" in session.currentUser).toBe(false);
    expect(session).not.toHaveProperty("capabilities");
  });

  test("returns private ETags and honors If-None-Match", async () => {
    const provider = providerFor({ resources: [] });
    const controller = new UiSurfaceHttpController(provider);
    const first = await controller.surface(context("admin"));
    const etag = first.headers.get("etag");
    const notModified = await controller.surface(context("admin", { "if-none-match": etag ?? "" }));

    expect(etag).toMatch(/^"sha256:[a-f0-9]{64}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toBe("Authorization");
    expect(notModified.status).toBe(304);
  });

  test("projects custom pages and every page operation monotonically", async () => {
    const provider = new UiSurfaceDocumentProvider(
      { ...baseOptions(), surfaces: [{
        surface: "admin",
        authorize: () => true,
        policy: () => ({
          resources: [],
          pages: [{ page: "settings", visible: true, operations: { read: true, update: false } }],
        }),
        session: () => ({ id: "a1", kind: "admin", displayName: "Admin" }),
      }] },
      new UiProfileV1Registry([customPageProfile()]),
      openApi(),
    );

    const effective = await provider.effective(context("admin"));
    const page = effective.spec.customPages?.[0];
    const protectedOpenApi = await provider.openApi(context("admin"));
    const operations = Object.values(protectedOpenApi.paths as Record<string, Record<string, { operationId?: string }>>)
      .flatMap((path) => Object.values(path).map((operation) => operation.operationId));

    expect(page).toMatchObject({
      id: "settings",
      kind: "settings",
      operations: { read: { operationId: "products.list" } },
    });
    expect((page as { readonly operations?: { readonly update?: unknown } })?.operations?.update).toBeUndefined();
    expect((page as { readonly form?: unknown })?.form).toBeUndefined();
    expect(effective.spec.navigation).toContainEqual(expect.objectContaining({ page: "settings" }));
    expect(operations).toEqual(["products.list"]);
  });

  test("projects a visible feature page without inventing transport operation slots", async () => {
    let policyPages: readonly { readonly id: string; readonly operations: readonly string[] }[] = [];
    const provider = new UiSurfaceDocumentProvider(
      { ...baseOptions(), surfaces: [{
        surface: "admin",
        authorize: () => true,
        policy: (_ctx, input) => {
          policyPages = input.pages;
          return { resources: [], pages: [{ page: "datamanager", visible: true }] };
        },
        session: () => ({ id: "a1", kind: "admin", displayName: "Admin" }),
      }] },
      new UiProfileV1Registry([featurePageProfile()]),
      openApi(),
    );

    const effective = await provider.effective(context("admin"));
    const protectedOpenApi = await provider.openApi(context("admin"));

    expect(policyPages).toEqual([{ id: "datamanager", operations: [] }]);
    expect(effective.spec.customPages).toEqual([{
      id: "datamanager",
      title: "DataManager",
      route: "/pages/datamanager",
      kind: "feature",
      renderer: "datamanager.schema/v1",
    }]);
    expect(effective.spec.navigation).toContainEqual(expect.objectContaining({ page: "datamanager" }));
    expect(effective.spec.requiredRendererCapabilities).toEqual(["datamanager.schema/v1"]);
    expect(protectedOpenApi.paths).toEqual({});
  });

  test("drops a hidden feature renderer capability but preserves unrelated requirements", async () => {
    const provider = new UiSurfaceDocumentProvider(
      { ...baseOptions(), surfaces: [{
        surface: "admin",
        authorize: () => true,
        policy: () => ({
          resources: [],
          pages: [{ page: "datamanager", visible: false }],
        }),
        session: () => ({ id: "a1", kind: "admin", displayName: "Admin" }),
      }] },
      new UiProfileV1Registry([featurePageProfile(["field.email/v1"])]),
      openApi(),
    );

    const effective = await provider.effective(context("admin"));

    expect(effective.spec.customPages).toBeUndefined();
    expect(effective.spec.navigation).toEqual([]);
    expect(effective.spec.requiredRendererCapabilities).toEqual(["field.email/v1"]);
  });
});

function providerFor(
  decision: UiSurfacePolicyDecision,
  authorize: () => boolean = () => true,
): UiSurfaceDocumentProvider {
  const surface: RunAppUiSurfaceOptions = {
    surface: "admin",
    authorize,
    policy: () => decision,
    session: () => ({
      id: "a1",
      kind: "admin",
      displayName: "Admin",
      roles: ["admin"],
      claims: { secret: true },
    }),
  };
  const options: UiSurfaceHostingOptions = { ...baseOptions(), surfaces: [surface] };
  return new UiSurfaceDocumentProvider(
    options,
    new UiProfileV1Registry([productProfile()]),
    openApi(),
  );
}

function baseOptions(): Omit<UiSurfaceHostingOptions, "surfaces"> {
  return {
    app: { name: "Admin", version: "1" },
    apiBasePath: "/v2/api",
  };
}

function context(surface: string, headers: Record<string, string> = {}): HttpContext {
  const requestHeaders = new Headers(headers);
  return {
    params: { surface },
    header: (name: string) => requestHeaders.get(name) ?? undefined,
    state: new Map<string, unknown>(),
    services: { resolveAll: () => [] },
  } as unknown as HttpContext;
}

function productProfile() {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: { name: "products-admin", surface: "admin", owner: "Products" },
    spec: {
      resources: [{
        id: "products",
        title: "Products",
        keyField: "id",
        operations: {
          list: { operationId: "products.list" },
          read: { operationId: "products.read" },
          create: { operationId: "products.create" },
          update: { operationId: "products.update" },
          delete: { operationId: "products.delete" },
        },
        forms: {
          create: { title: "Create", uiSchema: { type: "Control", scope: "#/properties/name" } },
          edit: { title: "Edit", uiSchema: { type: "Control", scope: "#/properties/name" } },
        },
        actions: [{
          id: "delete",
          title: "Delete",
          operation: { operationId: "products.delete" },
          placements: ["detail.header"],
        }],
      }],
    },
  });
}

function customPageProfile() {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: { name: "settings-admin", surface: "admin", owner: "Settings" },
    spec: {
      resources: [],
      customPages: [{
        id: "settings",
        title: "Settings",
        kind: "settings",
        navigation: { group: "System" },
        operations: {
          read: { operationId: "products.list" },
          update: { operationId: "products.update" },
        },
        form: {
          uiSchema: { type: "Control", scope: "#/properties/name" },
        },
      }],
    },
  });
}

function featurePageProfile(requiredRendererCapabilities: readonly string[] = []) {
  return defineUiProfile({
    apiVersion: UI_PROFILE_V1_API_VERSION,
    kind: UI_PROFILE_V1_KIND,
    metadata: { name: "datamanager-admin", surface: "admin", owner: "DataManager" },
    spec: {
      resources: [],
      ...(requiredRendererCapabilities.length > 0 ? { requiredRendererCapabilities } : {}),
      customPages: [{
        id: "datamanager",
        title: "DataManager",
        kind: "feature",
        renderer: "datamanager.schema/v1",
        navigation: { group: "System" },
      }],
    },
  });
}

function openApi(): OpenApiSchema {
  return {
    openapi: "3.1.0",
    info: { title: "UI", version: "1" },
    paths: {
      "/api/products": {
        get: operation("products.list", "#/components/schemas/ProductList"),
        post: requestOperation("products.create", "#/components/schemas/ProductCreate", "#/components/schemas/Product"),
      },
      "/api/products/{id}": {
        get: operation("products.read", "#/components/schemas/Product"),
        put: requestOperation("products.update", "#/components/schemas/ProductUpdate", "#/components/schemas/Product"),
        delete: { operationId: "products.delete", responses: { "204": { description: "Deleted" } } },
      },
      "/api/private": {
        get: operation("Private_list", "#/components/schemas/Private"),
      },
    },
    components: {
      schemas: {
        ProductList: { type: "array", items: { $ref: "#/components/schemas/Product" } },
        Product: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
        ProductCreate: { type: "object", properties: { name: { type: "string" } } },
        ProductUpdate: { type: "object", properties: { name: { type: "string" } } },
        Private: { type: "object", properties: { secret: { type: "string" } } },
      },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  };
}

function operation(operationId: string, response: string) {
  return {
    operationId,
    responses: {
      "200": { content: { "application/json": { schema: { $ref: response } } } },
    },
  };
}

function requestOperation(operationId: string, request: string, response: string) {
  return {
    ...operation(operationId, response),
    requestBody: {
      content: { "application/json": { schema: { $ref: request } } },
    },
  };
}
