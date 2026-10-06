import { registerGeneratedBindings } from "../../../http/Binding/autoBindings";
import { describe, expect, test } from "bun:test";
import { Controller, Get, Put } from "@/core/http";
import { registerGeneratedOpenApiSchemaModel } from "@/core/http/OpenApi/generatedOpenApiRegistry";
import {
  UiProfile,
  compileUiSurfaceV1,
  uiEndpoint,
} from "@/library/ui";
import { resolveUiProfileAuthoringV1 } from "../uiProfileResolver";

class SettingsDocument {
  appName = "";
  locale = "";
}

class UpdateSettingsRequest {
  appName?: string;
  locale?: string;
}

class RuntimeDocument {
  uptimeSeconds = 0;
}

@Controller("admin/settings-test")
class SettingsPageController {
  @Get()
  read(): SettingsDocument {
    return new SettingsDocument();
  }

  @Put()
  update(_request: UpdateSettingsRequest): SettingsDocument {
    return new SettingsDocument();
  }

  @Get("runtime")
  runtime(): RuntimeDocument {
    return new RuntimeDocument();
  }
}
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(SettingsPageController, {
  update: [{source: "body", model: "UpdateSettingsRequest"}],
}, new Map([["UpdateSettingsRequest", UpdateSettingsRequest]]));

@UiProfile({
  surface: "admin",
  customPages: [
    {
      kind: "feature",
      id: "datamanager",
      title: "DataManager",
      renderer: "datamanager.schema/v1",
      navigation: { group: "System", order: 10 },
    },
    {
      kind: "settings",
      id: "settings",
      title: "Settings",
      navigation: { group: "System", order: 20 },
      read: uiEndpoint(SettingsPageController, SettingsPageController.prototype.read, {
        response: SettingsDocument,
      }),
      update: uiEndpoint(SettingsPageController, SettingsPageController.prototype.update, {
        request: UpdateSettingsRequest,
        response: SettingsDocument,
      }),
      form: { title: "Edit settings" },
    },
    {
      kind: "dashboard",
      id: "runtime",
      title: "Runtime",
      blocks: [{
        id: "uptime",
        kind: "metric",
        title: "Uptime",
        load: uiEndpoint(SettingsPageController, SettingsPageController.prototype.runtime, {
          response: RuntimeDocument,
        }),
      }],
    },
  ],
})
class SettingsPagesProfile {}

describe("custom page @UiProfile resolver", () => {
  test("resolves function identities and nominal DTOs without authored operation ids or paths", () => {
    registerGeneratedOpenApiSchemaModel(SettingsDocument, "SettingsDocument");
    registerGeneratedOpenApiSchemaModel(RuntimeDocument, "RuntimeDocument");
    const openApi = document();
    const resolved = resolveUiProfileAuthoringV1({ declaration: SettingsPagesProfile, openApi });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.profiles[0]?.spec.resources).toEqual([]);
    expect(resolved.profiles[0]?.spec.customPages).toMatchObject([
      {
        id: "datamanager",
        kind: "feature",
        renderer: "datamanager.schema/v1",
      },
      {
        id: "settings",
        kind: "settings",
        operations: {
          read: { operationId: "settings.read" },
          update: { operationId: "settings.update" },
        },
      },
      {
        id: "runtime",
        kind: "dashboard",
        blocks: [{ operation: { operationId: "runtime.read" } }],
      },
    ]);

    const compiled = compileUiSurfaceV1({
      surface: "admin",
      profiles: resolved.profiles,
      openApi,
      links: { openapi: "/api/ui/admin/openapi" },
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.document.spec.customPages).toMatchObject([
        {
          id: "datamanager",
          route: "/pages/datamanager",
          kind: "feature",
          renderer: "datamanager.schema/v1",
        },
        { id: "runtime", route: "/pages/runtime", kind: "dashboard" },
        { id: "settings", route: "/pages/settings", kind: "settings" },
      ]);
      expect(compiled.document.spec.navigation).toContainEqual(expect.objectContaining({
        id: "settings",
        page: "settings",
        route: "/pages/settings",
      }));
      expect(compiled.document.spec.requiredRendererCapabilities).toEqual([
        "datamanager.schema/v1",
        "page.dashboard/v1",
        "page.settings/v1",
      ]);
    }
  });
});

function document() {
  const response = (schema: string) => ({
    "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } },
  });
  return {
    openapi: "3.1.0",
    info: { title: "Custom pages", version: "1" },
    paths: {
      "/api/admin/settings-test": {
        get: { operationId: "settings.read", tags: ["admin"], responses: response("SettingsDocument") },
        put: {
          operationId: "settings.update",
          tags: ["admin"],
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateSettingsRequest" } } },
          },
          responses: response("SettingsDocument"),
        },
      },
      "/api/admin/settings-test/runtime": {
        get: { operationId: "runtime.read", tags: ["admin"], responses: response("RuntimeDocument") },
      },
    },
    components: {
      schemas: {
        SettingsDocument: {
          type: "object",
          properties: { appName: { type: "string" }, locale: { type: "string" } },
        },
        UpdateSettingsRequest: {
          type: "object",
          properties: { appName: { type: "string" }, locale: { type: "string" } },
        },
        RuntimeDocument: {
          type: "object",
          properties: { uptimeSeconds: { type: "number" } },
        },
      },
    },
  };
}
