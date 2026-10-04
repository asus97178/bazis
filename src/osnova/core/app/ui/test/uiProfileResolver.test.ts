import { describe, expect, test } from "bun:test";
import { Module, collectModuleUiProfiles } from "@/core/di";
import { Controller, Get } from "@/core/http";
import { buildHttpOpenApiDocument } from "@/core/http/OpenApi/openApiDocument";
import { UiProfile, uiOperation } from "@/library/ui";
import { resolveUiProfiles } from "../../runApp";
import { resolveUiProfileAuthoringV1 } from "../uiProfileResolver";

@Controller("reports")
class ReportsController {
  @Get()
  list(): readonly object[] {
    return [];
  }

  @Get("search")
  search(): readonly object[] {
    return [];
  }
}

@UiProfile({
  surface: "admin",
  controller: ReportsController,
  title: "Reports",
  readonly: true,
})
class AmbiguousReportsProfile {}

@UiProfile({
  surface: "admin",
  controller: ReportsController,
  title: "Reports",
  readonly: true,
  operations: {
    list: uiOperation(ReportsController, ReportsController.prototype.list),
  },
})
class ExplicitReportsProfile {}

class PlainClass {}

@UiProfile({
  surface: "admin",
  controller: PlainClass,
})
class InvalidControllerProfile {}

@Module({
  controllers: [ReportsController],
  uiProfiles: [ExplicitReportsProfile],
})
class ReportsModule {}

describe("@UiProfile core resolver", () => {
  test("fails instead of guessing between conventional CRUD candidates", () => {
    const result = resolveUiProfileAuthoringV1({
      declaration: AmbiguousReportsProfile,
      openApi: reportsOpenApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "UIV1_CRUD_OPERATION_AMBIGUOUS")).toBe(true);
  });

  test("uses a controller-scoped explicit action reference as the escape hatch", () => {
    const openApi = reportsOpenApi();
    const result = resolveUiProfileAuthoringV1({
      declaration: ExplicitReportsProfile,
      openApi,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.profiles[0]?.spec.resources[0]?.operations).toEqual({
      list: operationRefAt(openApi, "/reports", "get"),
    });
  });

  test("rejects a source that is not an HTTP controller", () => {
    const result = resolveUiProfileAuthoringV1({
      declaration: InvalidControllerProfile,
      openApi: reportsOpenApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("UIV1_CONTROLLER_REQUIRED");
  });

  test("runApp composition collects and resolves only @UiProfile declarations", () => {
    const declarations = collectModuleUiProfiles([ReportsModule]);
    const resolved = resolveUiProfiles(ReportsModule, declarations, {});

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.metadata.surface).toBe("admin");
  });

  test("runApp rejects opaque module values that are not @UiProfile classes", () => {
    expect(() => resolveUiProfiles(ReportsModule, [PlainClass], {}, reportsOpenApi())).toThrow(
      "uiProfiles declaration PlainClass must use @UiProfile()",
    );
  });
});

function reportsOpenApi() {
  return buildHttpOpenApiDocument({
    controllers: [ReportsController],
    title: "UI resolver tests",
    version: "1",
  });
}

function operationRefAt(
  openApi: ReturnType<typeof reportsOpenApi>,
  path: string,
  method: string,
): { readonly operationId: string } {
  const paths = openApi["paths"] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const operation = paths[path]?.[method] as Readonly<Record<string, unknown>> | undefined;
  const operationId = operation?.["operationId"];
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new TypeError(`OpenAPI operation ${method.toUpperCase()} ${path} has no operationId.`);
  }
  return { operationId };
}
