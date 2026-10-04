import { resolveGeneratedBindings } from "../../http/Binding/autoBindings";
import type { ParameterBinding } from "../../http/Binding/bindings";
import {
  controllerMetaOf,
  type ActionMeta,
  type ControllerMeta,
  type RouteDeclaration,
} from "../../http/Decorators/metadata";
import { getGeneratedOpenApiSchemaName } from "../../http/OpenApi/generatedOpenApiRegistry";
import type { OpenApiSchema } from "../../../library/openapi";
import {
  listFilterCapabilitiesV1,
  requestEntitySchemaV1,
  responseEntitySchemaV1,
} from "../../../library/ui/compiler/openApiIndex";
import {
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  compileUiSurfaceV1,
  defineUiProfile,
  indexOpenApiV1,
  normalizeUiJsonObject,
  uiDiagnosticV1,
  uiProfileAuthoringMetadataOf,
  type AnyUiProfileAuthoringOptions,
  type UiCustomPageAuthoring,
  type UiCustomPagesProfileAuthoringOptions,
  type UiControllerClass,
  type UiEndpointReference,
  type UiDiagnosticV1,
  type UiFieldSelection,
  type UiFormFieldMap,
  type UiProfileAuthoringOptions,
  type UiFieldProfileV1,
  type UiOpenApiIndexV1,
  type UiOpenApiOperationV1,
  type UiProfileV1,
  type CompiledUiSurfaceLinksV1,
  type CompiledUiSurfaceV1,
  type UiSchemaElementV1,
} from "../../../library/ui";

export interface ResolveUiProfileAuthoringV1Options {
  readonly declaration: object;
  readonly openApi: OpenApiSchema;
}

export type ResolveUiProfileAuthoringV1Result =
  | {
      readonly ok: true;
      readonly profiles: readonly UiProfileV1[];
      readonly diagnostics: readonly UiDiagnosticV1[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly UiDiagnosticV1[];
    };

/** @internal Resolved, JSON-safe profiles collected from the active module graph. */
export class UiProfileV1Registry {
  readonly #profiles: readonly UiProfileV1[];
  readonly #openApi?: OpenApiSchema;

  public constructor(profiles: readonly UiProfileV1[] = [], openApi?: OpenApiSchema) {
    this.#profiles = Object.freeze([...profiles]);
    this.#openApi = openApi;
  }

  public bySurface(surface: string): readonly UiProfileV1[] {
    return this.#profiles.filter((profile) => profile.metadata.surface === surface);
  }

  /** Canonical OpenAPI projection used to resolve these profiles. */
  public openApi(): OpenApiSchema {
    if (this.#openApi === undefined) {
      throw new TypeError("UiProfileV1Registry has no HTTP OpenAPI catalog in worker mode.");
    }
    return this.#openApi;
  }

  /** Compiles a deterministic static surface without applying request policy. */
  public compile(
    surface: string,
    links: CompiledUiSurfaceLinksV1,
    openApi: OpenApiSchema = this.openApi(),
  ): CompiledUiSurfaceV1 {
    const result = compileUiSurfaceV1({
      surface,
      profiles: this.bySurface(surface),
      openApi,
      links,
    });
    if (!result.ok) {
      const details = result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");
      throw new TypeError(`UI surface ${surface} compilation failed:\n${details}`);
    }
    return result.document;
  }
}

type CrudRole = "list" | "read" | "create" | "update" | "delete";

interface ResolvedUiAction {
  readonly role: CrudRole;
  readonly controller: UiControllerClass;
  readonly methodName: string | symbol;
  readonly action: ActionMeta;
  readonly route: RouteDeclaration;
  readonly operation: UiOpenApiOperationV1;
}

type UiActionCandidate = Omit<ResolvedUiAction, "controller" | "operation">;

const CRUD_ROLES: readonly CrudRole[] = Object.freeze([
  "list",
  "read",
  "create",
  "update",
  "delete",
]);

/**
 * Resolves a process-local @UiProfile declaration into the JSON-safe V1 IR.
 * Controller/model references are consumed here and never reach the wire.
 */
export function resolveUiProfileAuthoringV1(
  options: ResolveUiProfileAuthoringV1Options,
): ResolveUiProfileAuthoringV1Result {
  const diagnostics: UiDiagnosticV1[] = [];
  const metadata = uiProfileAuthoringMetadataOf(options.declaration);
  if (metadata === undefined) {
    return failure([
      uiDiagnosticV1(
        "error",
        "UIV1_AUTHORING_DECLARATION_REQUIRED",
        "UI profile declaration must be a class decorated with @UiProfile().",
      ),
    ]);
  }

  const authoring = metadata.profile;
  if (isCustomPagesAuthoring(authoring)) {
    return resolveCustomPagesAuthoring(metadata.targetName, authoring, options.openApi);
  }
  const resourceAuthoring = authoring as UiProfileAuthoringOptions<any, any, any, any, any>;
  const controllerMeta = controllerMetaOf(resourceAuthoring.controller);
  if (!controllerMeta?.isController) {
    return failure([
      uiDiagnosticV1(
        "error",
        "UIV1_CONTROLLER_REQUIRED",
        `${metadata.targetName} references a class that is not decorated with @Controller().`,
        { profile: metadata.targetName },
      ),
    ]);
  }

  const openApiResult = indexOpenApiV1(options.openApi);
  diagnostics.push(...openApiResult.diagnostics);
  const resolvedActions = resolveCrudActions(
    metadata.targetName,
    resourceAuthoring,
    controllerMeta,
    openApiResult.index,
    diagnostics,
  );

  const responseSchema = resolveAndValidateResponseSchema(
    metadata.targetName,
    resourceAuthoring,
    resolvedActions,
    openApiResult.index,
    diagnostics,
  );

  validateRequestAssertions(metadata.targetName, resourceAuthoring, resolvedActions, diagnostics);
  if (hasErrors(diagnostics)) {
    return failure(diagnostics);
  }

  const surface = normalizeSurface(resourceAuthoring.surface, metadata.targetName, diagnostics);
  const resourceId = resourceIdOf(resourceAuthoring.id, controllerMeta, metadata.targetName, diagnostics);
  if (hasErrors(diagnostics) || surface === undefined || resourceId === undefined) {
    return failure(diagnostics);
  }

  const responseFields = readableScalarFields(responseSchema, openApiResult.index);
  const columns = resourceAuthoring.list?.columns === undefined
    ? responseFields
    : authoringFields(resourceAuthoring.list.columns);

  const listAction = resolvedActions.get("list");
  const createAction = resolvedActions.get("create");
  const updateAction = resolvedActions.get("update");
  const readAction = resolvedActions.get("read");
  const deleteAction = resolvedActions.get("delete");
  const listFilters = listAction === undefined
    ? []
    : [...listFilterCapabilitiesV1(listAction.operation).keys()].sort();

  const profiles: UiProfileV1[] = [];
  for (const targetSurface of [surface]) {
    const profile = defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: {
        name: `${metadata.targetName}:${targetSurface}`,
        surface: targetSurface,
        owner: metadata.targetName,
      },
      spec: {
        resources: [{
          id: resourceId,
          ...(resourceAuthoring.title !== undefined ? { title: resourceAuthoring.title } : {}),
          ...(resourceAuthoring.singularTitle !== undefined ? { singularTitle: resourceAuthoring.singularTitle } : {}),
          ...(resourceAuthoring.navigation !== undefined ? { navigation: resourceAuthoring.navigation } : {}),
          operations: {
            ...(listAction !== undefined ? { list: operationRef(listAction) } : {}),
            ...(readAction !== undefined ? { read: operationRef(readAction) } : {}),
            ...(createAction !== undefined ? { create: operationRef(createAction) } : {}),
            ...(updateAction !== undefined ? { update: operationRef(updateAction) } : {}),
            ...(deleteAction !== undefined ? { delete: operationRef(deleteAction) } : {}),
          },
          ...(listAction !== undefined
            ? {
                list: {
                  columns,
                  ...(resourceAuthoring.list?.filters !== undefined
                    ? { selectionFields: visibleAuthoringFieldNames(resourceAuthoring.list.filters) }
                    : listFilters.length > 0 ? { selectionFields: listFilters } : {}),
                  ...(resourceAuthoring.list?.defaultSort !== undefined
                    ? { defaultSort: resourceAuthoring.list.defaultSort }
                    : {}),
                  pageSize: resourceAuthoring.list?.pageSize ?? listDefaultPageSize(listAction) ?? 20,
                  ...(resourceAuthoring.list?.title !== undefined ? { title: resourceAuthoring.list.title } : {}),
                },
              }
            : {}),
          ...((readAction !== undefined || listAction !== undefined) && responseFields.length > 0
            ? {
                detail: {
                  ...(defaultTitleField(responseFields) !== undefined
                    ? { titleField: defaultTitleField(responseFields) }
                    : {}),
                  sections: [{ id: "main", title: "Основное", fields: responseFields }],
                },
              }
            : {}),
          ...((createAction !== undefined || updateAction !== undefined)
            ? {
                forms: {
                  ...(createAction !== undefined
                    ? {
                        create: {
                          title: resourceAuthoring.create?.title
                            ?? `Создать ${lowercaseTitle(resourceAuthoring.singularTitle ?? resourceAuthoring.title ?? resourceId)}`,
                          uiSchema: formUiSchema(
                            resourceAuthoring.create?.fields,
                            requestEntitySchemaV1(openApiResult.index, createAction.operation),
                          ),
                        },
                      }
                    : {}),
                  ...(updateAction !== undefined
                    ? {
                        edit: {
                          title: resourceAuthoring.edit?.title
                            ?? `Редактировать ${lowercaseTitle(resourceAuthoring.singularTitle ?? resourceAuthoring.title ?? resourceId)}`,
                          uiSchema: formUiSchema(
                            resourceAuthoring.edit?.fields,
                            requestEntitySchemaV1(openApiResult.index, updateAction.operation),
                          ),
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(deleteAction !== undefined && resourceAuthoring.delete?.hidden !== true
            ? {
                actions: [{
                  id: "delete",
                  title: resourceAuthoring.delete?.title ?? "Удалить",
                  operation: operationRef(deleteAction),
                  placements: resourceAuthoring.delete?.placements ?? ["list.row", "detail.header"],
                  intent: resourceAuthoring.delete?.intent ?? "danger",
                  confirm: resourceAuthoring.delete?.confirm
                    ?? `Удалить ${lowercaseTitle(resourceAuthoring.singularTitle ?? resourceAuthoring.title ?? resourceId)}?`,
                  refresh: resourceAuthoring.delete?.refresh ?? "resource",
                }],
              }
            : {}),
        }],
      },
    });
    profiles.push(profile);
  }

  return Object.freeze({
    ok: true,
    profiles: Object.freeze(profiles),
    diagnostics: Object.freeze(diagnostics),
  });
}

function isCustomPagesAuthoring(
  authoring: AnyUiProfileAuthoringOptions,
): authoring is UiCustomPagesProfileAuthoringOptions {
  return authoring.customPages !== undefined;
}

function resolveCustomPagesAuthoring(
  profileName: string,
  authoring: UiCustomPagesProfileAuthoringOptions,
  openApi: OpenApiSchema,
): ResolveUiProfileAuthoringV1Result {
  const diagnostics: UiDiagnosticV1[] = [];
  const indexed = indexOpenApiV1(openApi);
  diagnostics.push(...indexed.diagnostics);
  const pages = authoring.customPages.map((page) =>
    resolveCustomPage(profileName, page, indexed.index, diagnostics));
  if (hasErrors(diagnostics)) {
    return failure(diagnostics);
  }
  const surface = normalizeSurface(authoring.surface, profileName, diagnostics);
  if (hasErrors(diagnostics) || surface === undefined) {
    return failure(diagnostics);
  }
  const profiles: UiProfileV1[] = [];
  for (const targetSurface of [surface]) {
    profiles.push(defineUiProfile({
      apiVersion: UI_PROFILE_V1_API_VERSION,
      kind: UI_PROFILE_V1_KIND,
      metadata: { name: `${profileName}:${targetSurface}`, surface: targetSurface, owner: profileName },
      spec: {
        resources: [],
        customPages: pages,
      },
    }));
  }
  return Object.freeze({
    ok: true,
    profiles: Object.freeze(profiles),
    diagnostics: Object.freeze(diagnostics),
  });
}

function resolveCustomPage(
  profileName: string,
  page: UiCustomPageAuthoring,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): NonNullable<UiProfileV1["spec"]["customPages"]>[number] {
  const base = {
    id: page.id,
    title: page.title,
    ...(page.navigation !== undefined ? { navigation: page.navigation } : {}),
  };
  switch (page.kind) {
    case "feature":
      return { ...base, kind: page.kind, renderer: page.renderer };
    case "settings": {
      const read = resolveEndpoint(profileName, page.id, "read", page.read, ["GET"], index, diagnostics);
      const update = resolveEndpoint(profileName, page.id, "update", page.update, ["PUT", "PATCH"], index, diagnostics);
      return {
        ...base,
        kind: page.kind,
        operations: {
          read: endpointOperationRef(read),
          update: endpointOperationRef(update),
        },
        ...(page.form !== undefined || update !== undefined
          ? {
              form: {
                ...(page.form?.title !== undefined ? { title: page.form.title } : {}),
                uiSchema: formUiSchema(page.form?.fields, requestEntitySchemaV1(index, update?.operation)),
              },
            }
          : {}),
      };
    }
    case "document": {
      const load = resolveEndpoint(profileName, page.id, "load", page.load, ["GET"], index, diagnostics);
      return { ...base, kind: page.kind, operation: endpointOperationRef(load) };
    }
    case "dashboard":
      return {
        ...base,
        kind: page.kind,
        blocks: page.blocks.map((block) => {
          const load = resolveEndpoint(
            profileName,
            page.id,
            `blocks.${block.id}`,
            block.load,
            ["GET"],
            index,
            diagnostics,
          );
          return {
            id: block.id,
            kind: block.kind,
            title: block.title,
            operation: endpointOperationRef(load),
          };
        }),
      };
    default:
      return assertNeverCustomPageAuthoring(page);
  }
}

function assertNeverCustomPageAuthoring(value: never): never {
  throw new TypeError(`Unsupported UI custom page authoring declaration: ${String(value)}`);
}

interface ResolvedUiEndpoint extends UiActionCandidate {
  readonly controller: UiEndpointReference["controller"];
  readonly operation: UiOpenApiOperationV1;
}

function resolveEndpoint(
  profileName: string,
  pageId: string,
  slot: string,
  endpoint: UiEndpointReference,
  methods: readonly string[],
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): ResolvedUiEndpoint | undefined {
  const controllerMeta = controllerMetaOf(endpoint.controller);
  const path = `customPages.${pageId}.${slot}`;
  if (!controllerMeta?.isController) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ENDPOINT_CONTROLLER_REQUIRED",
      `${profileName} ${path} references a class that is not an HTTP controller.`,
      { profile: profileName, path },
    ));
    return undefined;
  }
  const methodName = controllerMethodName(endpoint.controller, controllerMeta, endpoint);
  const action = methodName === undefined ? undefined : controllerMeta.actions.get(methodName);
  if (methodName === undefined || action === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ENDPOINT_ACTION_MISSING",
      `${profileName} ${path} does not reference an action on its controller.`,
      { profile: profileName, path },
    ));
    return undefined;
  }
  const routes = action.routes.filter((route) => methods.includes(route.httpMethod));
  if (routes.length !== 1) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ENDPOINT_ROUTE_AMBIGUOUS",
      `${profileName} ${path} must resolve to exactly one ${methods.join(" or ")} route.`,
      { profile: profileName, path },
    ));
    return undefined;
  }
  const candidate: UiActionCandidate = {
    role: methods.includes("GET") ? "read" : "update",
    methodName,
    action,
    route: routes[0] as RouteDeclaration,
  };
  const operation = openApiOperationFor(candidate, controllerMeta, index);
  if (operation === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_HTTP_CATALOG_OPERATION_MISSING",
      `${profileName} ${path} is missing from the OpenAPI projection.`,
      { profile: profileName, path },
    ));
    return undefined;
  }
  const resolved = { ...candidate, controller: endpoint.controller, operation };
  validateEndpointAssertions(profileName, path, endpoint, resolved, index, diagnostics);
  return resolved;
}

function validateEndpointAssertions(
  profileName: string,
  path: string,
  endpoint: UiEndpointReference,
  resolved: ResolvedUiEndpoint,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  if (endpoint.request !== undefined) {
    const binding = (resolveGeneratedBindings(resolved.controller, resolved.methodName)
      ?? [])
      .find((item) => item.source === "body" || item.source === "list");
    if (binding?.model !== endpoint.request) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_ENDPOINT_REQUEST_MODEL_MISMATCH",
        `${profileName} ${path} request class is not bound to the controller action.`,
        { profile: profileName, path: path + ".request" },
      ));
    }
  }
  if (typeof endpoint.response === "function") {
    const schemaName = getGeneratedOpenApiSchemaName(endpoint.response as abstract new (...args: any[]) => object);
    const expected = schemaName === undefined ? undefined : index.schemas[schemaName];
    const actual = responseEntitySchemaV1(index, resolved.operation);
    if (schemaName === undefined || expected === undefined) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_ENDPOINT_RESPONSE_MODEL_NOT_REGISTERED",
        `${profileName} ${path} response class is not bound to a generated OpenAPI schema.`,
        { profile: profileName, path: path + ".response" },
      ));
    } else if (actual !== expected) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_ENDPOINT_RESPONSE_MODEL_MISMATCH",
        `${profileName} ${path} response class does not match the controller action response.`,
        { profile: profileName, path: path + ".response" },
      ));
    }
  }
}

function controllerMethodName(
  controller: UiEndpointReference["controller"],
  meta: ControllerMeta,
  reference: { readonly action: (...args: any[]) => unknown },
): string | symbol | undefined {
  const matches = [...meta.actions.keys()].filter((methodName) =>
    (controller.prototype as Record<string | symbol, unknown>)[methodName] === reference.action);
  return matches.length === 1 ? matches[0] : undefined;
}

function endpointOperationRef(endpoint: ResolvedUiEndpoint | undefined): { readonly operationId: string } {
  return { operationId: endpoint?.operation.operationId ?? "<unresolved>" };
}

function resolveCrudActions(
  profileName: string,
  authoring: UiProfileAuthoringOptions<any, any, any, any, any>,
  controllerMeta: ControllerMeta,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): ReadonlyMap<CrudRole, ResolvedUiAction> {
  const out = new Map<CrudRole, ResolvedUiAction>();
  for (const role of CRUD_ROLES) {
    if (authoring.readonly === true && role !== "list" && role !== "read") {
      continue;
    }
    const explicit = authoring.operations?.[role];
    const candidates = explicit === undefined
      ? conventionalCandidates(role, controllerMeta)
      : explicitCandidates(profileName, role, authoring, controllerMeta, explicit, diagnostics);
    if (candidates.length === 0) {
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_CRUD_OPERATION_AMBIGUOUS",
        `${profileName} has ${candidates.length} candidates for ${role}; declare an explicit uiOperation().`,
        { profile: profileName, path: `operations.${role}` },
      ));
      continue;
    }
    const candidate = candidates[0] as UiActionCandidate;
    const operation = openApiOperationFor(candidate, controllerMeta, index);
    if (operation === undefined) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_HTTP_CATALOG_OPERATION_MISSING",
        `OpenAPI projection is missing the resolved ${role} controller action.`,
        { profile: profileName, path: `operations.${role}` },
      ));
      continue;
    }
    out.set(role, Object.freeze({ ...candidate, controller: authoring.controller, operation }));
  }
  return out;
}

function conventionalCandidates(
  role: CrudRole,
  controllerMeta: ControllerMeta,
): UiActionCandidate[] {
  const candidates: UiActionCandidate[] = [];
  for (const [methodName, action] of controllerMeta.actions) {
    for (const route of action.routes) {
      if (routeMatchesRole(route, role)) {
        candidates.push({ role, methodName, action, route });
      }
    }
  }
  return candidates;
}

function explicitCandidates(
  profileName: string,
  role: CrudRole,
  authoring: UiProfileAuthoringOptions<any, any, any, any, any>,
  controllerMeta: ControllerMeta,
  explicit: {
    readonly controller: UiEndpointReference["controller"];
    readonly action: (...args: any[]) => unknown;
  },
  diagnostics: UiDiagnosticV1[],
): UiActionCandidate[] {
  if (explicit.controller !== authoring.controller) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_OPERATION_CONTROLLER_MISMATCH",
      `${profileName} ${role} operation references another controller.`,
      { profile: profileName, path: `operations.${role}` },
    ));
    return [];
  }
  const methodName = controllerMethodName(explicit.controller, controllerMeta, explicit);
  const action = methodName === undefined ? undefined : controllerMeta.actions.get(methodName);
  if (action === undefined || action.routes.length === 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_CONTROLLER_ACTION_MISSING",
      `${profileName} references a controller action without an HTTP route.`,
      { profile: profileName, path: `operations.${role}` },
    ));
    return [];
  }
  const routes = action.routes.filter((route) => methodAllowedForRole(route.httpMethod, role));
  if (routes.length === 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_CONTROLLER_ACTION_METHOD_MISMATCH",
      `${profileName} action ${String(methodName)} has no HTTP method compatible with ${role}.`,
      { profile: profileName, path: `operations.${role}` },
    ));
  }
  return routes.map((route) => ({ role, methodName: methodName as string | symbol, action, route }));
}

function routeMatchesRole(route: RouteDeclaration, role: CrudRole): boolean {
  const itemRoute = route.template.split("/").some((segment) => segment.startsWith(":") || segment.startsWith("*"));
  switch (role) {
    case "list": return route.httpMethod === "GET" && !itemRoute;
    case "read": return route.httpMethod === "GET" && itemRoute;
    case "create": return route.httpMethod === "POST" && !itemRoute;
    case "update": return (route.httpMethod === "PUT" || route.httpMethod === "PATCH") && itemRoute;
    case "delete": return route.httpMethod === "DELETE" && itemRoute;
  }
}

function methodAllowedForRole(method: string, role: CrudRole): boolean {
  return routeMatchesRole({ httpMethod: method, template: role === "list" || role === "create" ? "" : ":id" }, role);
}

function openApiOperationFor(
  action: UiActionCandidate,
  controllerMeta: ControllerMeta,
  index: UiOpenApiIndexV1,
): UiOpenApiOperationV1 | undefined {
  const suffix = openApiPathSuffix(controllerMeta.prefix, action.route.template);
  const expectedTag = controllerMeta.prefix?.split("/").find((segment) => segment.length > 0);
  const matches = [...index.operations.values()].filter((operation) =>
    operation.method === action.route.httpMethod
      && (operation.path === suffix || operation.path.endsWith(suffix))
      && (expectedTag === undefined || operationTags(operation).includes(expectedTag)));
  return matches.length === 1 ? matches[0] : undefined;
}

function operationTags(operation: UiOpenApiOperationV1): readonly string[] {
  const tags = operation.operation["tags"];
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function openApiPathSuffix(prefix: string | undefined, template: string): string {
  const segments = [prefix ?? "", template]
    .join("/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const route = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]+\))?$/.exec(segment);
      if (route !== null) {
        return `{${route[1] as string}}`;
      }
      const wildcard = /^\*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(segment);
      return wildcard === null ? segment : `{${(wildcard[1] as string | undefined) ?? "rest"}}`;
    });
  return `/${segments.join("/")}`;
}

function resolveAndValidateResponseSchema(
  profileName: string,
  authoring: UiProfileAuthoringOptions<any, any, any, any, any>,
  actions: ReadonlyMap<CrudRole, ResolvedUiAction>,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): OpenApiSchema | undefined {
  const sourceAction = actions.get("read") ?? actions.get("list") ?? actions.get("create") ?? actions.get("update");
  const actual = responseEntitySchemaV1(index, sourceAction?.operation);
  const response = authoring.response;
  if (typeof response !== "function") {
    return actual;
  }
  const schemaName = getGeneratedOpenApiSchemaName(response);
  if (schemaName === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_RESPONSE_MODEL_NOT_REGISTERED",
      `${profileName} response class is not bound to a generated OpenAPI schema. Run bun run di:generate.`,
      { profile: profileName, path: "response" },
    ));
    return actual;
  }
  const expected = index.schemas[schemaName];
  if (expected === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_RESPONSE_SCHEMA_MISSING",
      `${profileName} generated response schema ${schemaName} is absent from this OpenAPI document.`,
      { profile: profileName, path: "response" },
    ));
    return actual;
  }
  for (const role of ["list", "read", "create", "update"] as const) {
    const action = actions.get(role);
    const roleSchema = responseEntitySchemaV1(index, action?.operation);
    if (roleSchema !== undefined && roleSchema !== expected) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_RESPONSE_MODEL_MISMATCH",
        `${profileName} response class does not match the resolved ${role} response schema.`,
        { profile: profileName, path: `operations.${role}.response` },
      ));
    }
  }
  return expected;
}

function validateRequestAssertions(
  profileName: string,
  authoring: UiProfileAuthoringOptions<any, any, any, any, any>,
  actions: ReadonlyMap<CrudRole, ResolvedUiAction>,
  diagnostics: UiDiagnosticV1[],
): void {
  validateRequestAssertion(profileName, "list", "list", authoring.list?.request, actions.get("list"), diagnostics);
  validateRequestAssertion(profileName, "create", "body", authoring.create?.request, actions.get("create"), diagnostics);
  validateRequestAssertion(profileName, "edit", "body", authoring.edit?.request, actions.get("update"), diagnostics);
}

function validateRequestAssertion(
  profileName: string,
  path: string,
  source: "list" | "body",
  expected: unknown,
  action: ResolvedUiAction | undefined,
  diagnostics: UiDiagnosticV1[],
): void {
  if (expected === undefined || action === undefined) {
    return;
  }
  const binding = bindingsOf(action).find((item) => item.source === source);
  if (binding?.model !== expected) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_REQUEST_MODEL_MISMATCH",
      `${profileName} ${path} request class is not the model bound to the resolved controller action.`,
      { profile: profileName, path: `${path}.request` },
    ));
  }
}

function bindingsOf(action: ResolvedUiAction): readonly ParameterBinding[] {
  return resolveGeneratedBindings(action.controller, action.methodName)
    ?? [];
}

function readableScalarFields(
  schema: OpenApiSchema | undefined,
  index: UiOpenApiIndexV1,
): string[] {
  const properties = record(schema?.["properties"]);
  return Object.keys(properties).filter((name) => {
    const property = resolvePropertySchema(record(properties[name]), index);
    if (property["writeOnly"] === true) {
      return false;
    }
    const type = property["type"];
    return type === "string" || type === "number" || type === "integer" || type === "boolean";
  });
}

function resolvePropertySchema(
  property: Readonly<Record<string, unknown>>,
  index: UiOpenApiIndexV1,
): Readonly<Record<string, unknown>> {
  const ref = property["$ref"];
  const prefix = "#/components/schemas/";
  return typeof ref === "string" && ref.startsWith(prefix)
    ? record(index.schemas[ref.slice(prefix.length)])
    : property;
}

function authoringFields(
  fields: UiFieldSelection<any>,
): UiFieldProfileV1[] {
  return visibleAuthoringFieldNames(fields);
}

function visibleAuthoringFieldNames(fields: UiFieldSelection<any> | UiFormFieldMap<any>): string[] {
  return Object.entries(fields)
    .filter(([, override]) => record(override)["hidden"] !== true)
    .map(([field]) => field);
}

function formUiSchema(
  fields: UiFormFieldMap<any> | undefined,
  schema: OpenApiSchema | undefined,
): UiSchemaElementV1 {
  const names = fields === undefined
    ? Object.keys(record(schema?.["properties"]))
    : visibleAuthoringFieldNames(fields);
  return {
    type: "VerticalLayout",
    elements: names.map((name) => {
      const override = fields === undefined ? {} : record(fields[name]);
      return {
        type: "Control" as const,
        scope: `#/properties/${name}`,
        ...(typeof override["label"] === "string" ? { label: override["label"] } : {}),
        ...(override["options"] !== undefined
          ? { options: normalizeUiJsonObject(record(override["options"]), `uiForm.${name}.options`) }
          : {}),
      };
    }),
  };
}

function listDefaultPageSize(action: ResolvedUiAction): number | undefined {
  const binding = bindingsOf(action).find((item) => item.source === "list");
  return binding?.listOptions?.page?.defaultSize;
}

function operationRef(action: ResolvedUiAction): { readonly operationId: string } {
  return { operationId: action.operation.operationId };
}

function defaultTitleField(fields: readonly string[]): string | undefined {
  for (const candidate of ["name", "title", "label", "id"]) {
    if (fields.includes(candidate)) {
      return candidate;
    }
  }
  return fields[0];
}

function normalizeSurface(
  value: string,
  profileName: string,
  diagnostics: UiDiagnosticV1[],
): string | undefined {
  const surface = value.trim();
  if (surface.length === 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_SURFACE_REQUIRED",
      `${profileName} must declare one non-empty surface.`,
      { profile: profileName, path: "surface" },
    ));
    return undefined;
  }
  return surface;
}

function resourceIdOf(
  explicit: string | undefined,
  controllerMeta: ControllerMeta,
  profileName: string,
  diagnostics: UiDiagnosticV1[],
): string | undefined {
  if (explicit !== undefined) {
    const normalized = explicit.trim();
    if (normalized.length > 0) {
      return normalized;
    }
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_RESOURCE_ID_INVALID",
      `${profileName} resource id must not be empty.`,
      { profile: profileName, path: "id" },
    ));
    return undefined;
  }
  const id = controllerMeta.prefix?.split("/").filter((segment) =>
    segment.length > 0 && !segment.startsWith(":") && !segment.startsWith("*")).at(-1);
  if (id === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_RESOURCE_ID_NOT_INFERRED",
      `${profileName} controller prefix has no stable resource segment.`,
      { profile: profileName, path: "controller" },
    ));
  }
  return id;
}

function lowercaseTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "ресурс" : `${trimmed[0]?.toLocaleLowerCase("ru-RU") ?? ""}${trimmed.slice(1)}`;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function hasErrors(diagnostics: readonly UiDiagnosticV1[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function failure(diagnostics: readonly UiDiagnosticV1[]): ResolveUiProfileAuthoringV1Result {
  return Object.freeze({
    ok: false,
    diagnostics: Object.freeze([...diagnostics]),
  });
}
