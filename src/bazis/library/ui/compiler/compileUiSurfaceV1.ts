import {
  COMPILED_UI_SURFACE_V1_API_VERSION,
  COMPILED_UI_SURFACE_V1_KIND,
  type CompiledUiActionV1,
  type CompiledUiCustomPageV1,
  type CompiledUiNavigationItemV1,
  type CompiledUiResourceOperationsV1,
  type CompiledUiResourceV1,
  type CompiledUiSurfaceV1,
} from "../compiled-v1";
import { defineUiProfile } from "../defineUiProfile";
import { uiDiagnosticV1, type UiDiagnosticV1 } from "../diagnostics-v1";
import {
  UI_PROFILE_V1_API_VERSION,
  UI_PROFILE_V1_KIND,
  type UiFieldProfileV1,
  type UiCustomPageProfileV1,
  type UiOperationRefV1,
  type UiProfileV1,
  type UiResourceProfileV1,
  type UiSchemaElementV1,
} from "../profile-v1";
import { normalizeUiJsonObject, uiDocumentRevision } from "../serialization";
import type {
  CompileUiSurfaceV1Options,
  CompileUiSurfaceV1Result,
} from "./contracts-v1";
import {
  hasQueryParameterV1,
  indexOpenApiV1,
  listFilterCapabilitiesV1,
  listMaxPageSizeV1,
  requestEntitySchemaV1,
  responseEntitySchemaV1,
  schemaPropertyNamesV1,
  type UiOpenApiHttpMethodV1,
  type UiOpenApiIndexV1,
  type UiOpenApiOperationV1,
} from "./openApiIndex";

const OPERATION_ROLES = Object.freeze([
  ["list", ["GET"]],
  ["read", ["GET"]],
  ["create", ["POST"]],
  ["update", ["PUT", "PATCH"]],
  ["delete", ["DELETE"]],
] as const);

export function compileUiSurfaceV1(options: CompileUiSurfaceV1Options): CompileUiSurfaceV1Result {
  const diagnostics: UiDiagnosticV1[] = [];
  const surface = requiredText(options.surface, "surface");
  const openApiResult = indexOpenApiV1(options.openApi);
  diagnostics.push(...openApiResult.diagnostics);

  const resources: CompiledUiResourceV1[] = [];
  const customPages: CompiledUiCustomPageV1[] = [];
  const navigation: CompiledUiNavigationItemV1[] = [];
  const rendererCapabilities = new Set<string>();
  const seenProfiles = new Set<string>();
  const seenResources = new Set<string>();
  const seenPages = new Set<string>();

  for (const sourceProfile of options.profiles) {
    let profile: UiProfileV1;
    try {
      profile = defineUiProfile(sourceProfile);
    } catch (error) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_PROFILE_NOT_JSON_SAFE",
        errorMessage(error),
      ));
      continue;
    }

    if (profile.apiVersion !== UI_PROFILE_V1_API_VERSION || profile.kind !== UI_PROFILE_V1_KIND) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_PROFILE_VERSION_UNSUPPORTED",
        "Only UiProfileV1 declarations are supported.",
      ));
      continue;
    }
    if (profile.metadata.surface !== surface) {
      continue;
    }
    if (seenProfiles.has(profile.metadata.name)) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_DUPLICATE_PROFILE",
        "UI profile " + profile.metadata.name + " is declared more than once for surface " + surface + ".",
        { profile: profile.metadata.name },
      ));
      continue;
    }
    seenProfiles.add(profile.metadata.name);

    for (const capability of profile.spec.requiredRendererCapabilities ?? []) {
      rendererCapabilities.add(capability);
    }

    for (const resource of profile.spec.resources) {
      if (seenResources.has(resource.id)) {
        diagnostics.push(uiDiagnosticV1(
          "error",
          "UIV1_DUPLICATE_RESOURCE",
          "UI resource " + resource.id + " is declared more than once for surface " + surface + ".",
          { profile: profile.metadata.name, resource: resource.id },
        ));
        continue;
      }
      seenResources.add(resource.id);

      validateResource(
        profile.metadata.name,
        resource,
        openApiResult.index,
        diagnostics,
      );
      const compiled = compileResource(resource);
      resources.push(compiled);
      if (resource.navigation?.hidden !== true) {
        navigation.push(compileNavigation(resource, compiled));
      }
    }

    for (const page of profile.spec.customPages ?? []) {
      if (seenPages.has(page.id)) {
        diagnostics.push(uiDiagnosticV1(
          "error",
          "UIV1_DUPLICATE_CUSTOM_PAGE",
          "UI custom page " + page.id + " is declared more than once for surface " + surface + ".",
          { profile: profile.metadata.name, path: "customPages." + page.id },
        ));
        continue;
      }
      seenPages.add(page.id);
      validateCustomPage(profile.metadata.name, page, openApiResult.index, diagnostics);
      const compiled = compileCustomPage(page);
      customPages.push(compiled);
      rendererCapabilities.add(page.kind === "feature" ? page.renderer : "page." + page.kind + "/v1");
      if (page.navigation?.hidden !== true) {
        navigation.push(compilePageNavigation(page, compiled));
      }
    }
  }

  if (hasErrors(diagnostics)) {
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  navigation.sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0)
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id),
  );
  resources.sort((left, right) => left.id.localeCompare(right.id));
  customPages.sort((left, right) => left.id.localeCompare(right.id));

  const semanticDocument = {
    apiVersion: COMPILED_UI_SURFACE_V1_API_VERSION,
    kind: COMPILED_UI_SURFACE_V1_KIND,
    metadata: { surface },
    links: options.links,
    spec: {
      navigation,
      resources,
      ...(customPages.length > 0 ? { customPages } : {}),
      requiredRendererCapabilities: [...rendererCapabilities].sort(),
    },
  };
  const revision = uiDocumentRevision(semanticDocument);
  const document = normalizeUiJsonObject({
    ...semanticDocument,
    metadata: { surface, revision },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  }, "compiledUiSurface") as unknown as CompiledUiSurfaceV1;

  return Object.freeze({
    ok: true,
    document,
    diagnostics: Object.freeze(diagnostics),
  });
}

function validateCustomPage(
  profileName: string,
  page: UiCustomPageProfileV1,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  switch (page.kind) {
    case "feature":
      return;
    case "settings":
      validatePageOperation(profileName, page.id, "read", page.operations.read, ["GET"], index, diagnostics);
      validatePageOperation(profileName, page.id, "update", page.operations.update, ["PUT", "PATCH"], index, diagnostics);
      validateForm(
        profileName,
        page.id,
        "edit",
        page.form?.uiSchema,
        operationOf(index, page.operations.update),
        index,
        diagnostics,
      );
      return;
    case "document":
      validatePageOperation(profileName, page.id, "load", page.operation, ["GET"], index, diagnostics);
      return;
    case "dashboard":
      for (const block of page.blocks) {
        validatePageOperation(
          profileName,
          page.id,
          "blocks." + block.id,
          block.operation,
          ["GET"],
          index,
          diagnostics,
        );
      }
      return;
    default:
      return assertNeverCustomPage(page);
  }
}

function validatePageOperation(
  profileName: string,
  pageId: string,
  slot: string,
  reference: UiOperationRefV1,
  methods: readonly UiOpenApiHttpMethodV1[],
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  const operation = index.operations.get(reference.operationId);
  if (operation === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_CUSTOM_PAGE_OPERATION_NOT_FOUND",
      "OpenAPI operation " + reference.operationId + " was not found.",
      { profile: profileName, path: "customPages." + pageId + "." + slot },
    ));
    return;
  }
  if (!methods.includes(operation.method)) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_CUSTOM_PAGE_OPERATION_METHOD_MISMATCH",
      "Operation " + reference.operationId + " uses " + operation.method
        + " but custom page slot " + slot + " expects " + methods.join(" or ") + ".",
      { profile: profileName, path: "customPages." + pageId + "." + slot },
    ));
  }
}

function compileCustomPage(page: UiCustomPageProfileV1): CompiledUiCustomPageV1 {
  const base = {
    id: page.id,
    title: page.title,
    route: "/pages/" + encodeURIComponent(page.id),
  };
  switch (page.kind) {
    case "feature":
      return Object.freeze({ ...base, kind: page.kind, renderer: page.renderer });
    case "settings":
      return Object.freeze({
        ...base,
        kind: page.kind,
        operations: page.operations,
        ...(page.form !== undefined ? { form: page.form } : {}),
      });
    case "document":
      return Object.freeze({ ...base, kind: page.kind, operation: page.operation });
    case "dashboard":
      return Object.freeze({
        ...base,
        kind: page.kind,
        blocks: Object.freeze(page.blocks.map((block) => Object.freeze({ ...block }))),
      });
    default:
      return assertNeverCustomPage(page);
  }
}

function assertNeverCustomPage(value: never): never {
  throw new TypeError(`Unsupported compiled UI custom page: ${String(value)}`);
}

function compilePageNavigation(
  page: UiCustomPageProfileV1,
  compiled: CompiledUiCustomPageV1,
): CompiledUiNavigationItemV1 {
  return Object.freeze({
    id: page.id,
    title: page.navigation?.title ?? page.title,
    route: compiled.route,
    page: page.id,
    ...(page.navigation?.group !== undefined ? { group: page.navigation.group } : {}),
    ...(page.navigation?.icon !== undefined ? { icon: page.navigation.icon } : {}),
    ...(page.navigation?.order !== undefined ? { order: page.navigation.order } : {}),
  });
}

function validateResource(
  profileName: string,
  resource: UiResourceProfileV1,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  const operations = resource.operations;
  for (const [role, expectedMethods] of OPERATION_ROLES) {
    validateOperation(
      profileName,
      resource.id,
      role,
      operations?.[role],
      expectedMethods,
      index,
      diagnostics,
    );
  }

  const readOperation = operationOf(index, operations?.read);
  const listOperation = operationOf(index, operations?.list);
  const responseSchema =
    responseEntitySchemaV1(index, readOperation)
    ?? responseEntitySchemaV1(index, listOperation);
  const responseFields = schemaPropertyNamesV1(responseSchema);

  if (resource.keyField !== undefined && !responseFields.has(resource.keyField)) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_KEY_FIELD_NOT_FOUND",
      "Key field " + resource.keyField + " is not present in the resolved response schema.",
      { profile: profileName, resource: resource.id, path: "keyField" },
    ));
  }

  validateFields(
    profileName,
    resource.id,
    resource.list?.columns,
    responseFields,
    "list.columns",
    diagnostics,
  );
  validateFields(
    profileName,
    resource.id,
    detailFields(resource),
    responseFields,
    "detail",
    diagnostics,
  );

  if (resource.list?.selectionFields !== undefined) {
    const filters = listFilterCapabilitiesV1(listOperation);
    for (const field of resource.list.selectionFields) {
      const name = fieldName(field);
      if (!filters.has(name)) {
        diagnostics.push(uiDiagnosticV1(
          "error",
          "UIV1_FILTER_NOT_SUPPORTED",
          "Field " + name + " is not exposed as an OpenAPI list filter.",
          { profile: profileName, resource: resource.id, path: "list.selectionFields" },
        ));
      }
    }
  }

  if (resource.list?.defaultSort !== undefined && !hasQueryParameterV1(listOperation, "sort")) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_SORT_NOT_SUPPORTED",
      "Resource " + resource.id + " declares defaultSort but its list operation has no sort parameter.",
      { profile: profileName, resource: resource.id, path: "list.defaultSort" },
    ));
  }

  const maximum = listMaxPageSizeV1(listOperation);
  if (
    maximum !== undefined
    && resource.list?.pageSize !== undefined
    && resource.list.pageSize > maximum
  ) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_PAGE_SIZE_EXCEEDS_API_MAXIMUM",
      "Configured pageSize " + resource.list.pageSize + " exceeds OpenAPI maximum " + maximum + ".",
      { profile: profileName, resource: resource.id, path: "list.pageSize" },
    ));
  }

  validateForm(
    profileName,
    resource.id,
    "create",
    resource.forms?.create?.uiSchema,
    operationOf(index, operations?.create),
    index,
    diagnostics,
  );
  validateForm(
    profileName,
    resource.id,
    "edit",
    resource.forms?.edit?.uiSchema,
    operationOf(index, operations?.update),
    index,
    diagnostics,
  );

  for (const action of resource.actions ?? []) {
    const operation = index.operations.get(action.operation.operationId);
    if (operation === undefined) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_ACTION_OPERATION_NOT_FOUND",
        "Action " + action.id + " references missing OpenAPI operation " + action.operation.operationId + ".",
        { profile: profileName, resource: resource.id, path: "actions." + action.id },
      ));
      continue;
    }
    validateActionOperation(profileName, resource.id, action, operation, diagnostics);
  }
}

function validateActionOperation(
  profileName: string,
  resourceId: string,
  action: NonNullable<UiResourceProfileV1["actions"]>[number],
  operation: UiOpenApiOperationV1,
  diagnostics: UiDiagnosticV1[],
): void {
  const path = "actions." + action.id;
  if (operation.operation["requestBody"] !== undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ACTION_REQUEST_BODY_UNSUPPORTED",
      "Generic action " + action.id + " cannot require a request body; use an explicit feature renderer.",
      { profile: profileName, resource: resourceId, path },
    ));
  }

  const recordPlacements = action.placements.filter((placement) =>
    placement === "list.row" || placement === "detail.header");
  const pagePlacements = action.placements.filter((placement) => placement === "list.header");
  const pathParameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  const validPathShape = recordPlacements.length > 0 && pagePlacements.length === 0
    ? pathParameters.length === 1
    : pagePlacements.length > 0 && recordPlacements.length === 0
      ? pathParameters.length === 0
      : false;
  if (!validPathShape) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ACTION_PATH_SHAPE_UNSUPPORTED",
      "Generic action " + action.id
        + " must be either a record action with one path parameter or a list-header action without path parameters.",
      { profile: profileName, resource: resourceId, path },
    ));
  }

  const parameters = Array.isArray(operation.operation["parameters"])
    ? operation.operation["parameters"] as readonly unknown[]
    : [];
  const required = parameters.filter((value) => {
    const parameter = asRecord(value);
    return parameter["required"] === true && parameter["in"] !== "path";
  });
  if (required.length > 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_ACTION_REQUIRED_PARAMETER_UNSUPPORTED",
      "Generic action " + action.id + " cannot require query, header or cookie parameters.",
      { profile: profileName, resource: resourceId, path },
    ));
  }
}

function validateOperation(
  profileName: string,
  resourceId: string,
  role: string,
  reference: UiOperationRefV1 | undefined,
  expectedMethods: readonly UiOpenApiHttpMethodV1[],
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  if (reference === undefined) {
    return;
  }
  const operation = index.operations.get(reference.operationId);
  if (operation === undefined) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_OPERATION_NOT_FOUND",
      "OpenAPI operation " + reference.operationId + " was not found.",
      { profile: profileName, resource: resourceId, path: "operations." + role },
    ));
    return;
  }
  if (!expectedMethods.includes(operation.method)) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_OPERATION_METHOD_MISMATCH",
      "Operation " + reference.operationId + " uses " + operation.method
        + " but role " + role + " expects " + expectedMethods.join(" or ") + ".",
      { profile: profileName, resource: resourceId, path: "operations." + role },
    ));
  }
}

function validateFields(
  profileName: string,
  resourceId: string,
  fields: readonly UiFieldProfileV1[] | undefined,
  available: ReadonlySet<string>,
  path: string,
  diagnostics: UiDiagnosticV1[],
): void {
  if (fields === undefined) {
    return;
  }
  if (available.size === 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_RESPONSE_SCHEMA_MISSING",
      "Resource " + resourceId + " declares " + path + " but no response entity schema can be resolved.",
      { profile: profileName, resource: resourceId, path },
    ));
    return;
  }
  for (const field of fields) {
    const name = fieldName(field);
    if (!available.has(name)) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_RESPONSE_FIELD_NOT_FOUND",
        "Field " + name + " is not present in the resolved response schema.",
        { profile: profileName, resource: resourceId, path },
      ));
    }
  }
}

function validateForm(
  profileName: string,
  resourceId: string,
  form: "create" | "edit",
  uiSchema: UiSchemaElementV1 | undefined,
  operation: UiOpenApiOperationV1 | undefined,
  index: UiOpenApiIndexV1,
  diagnostics: UiDiagnosticV1[],
): void {
  if (uiSchema === undefined) {
    return;
  }
  const schema = requestEntitySchemaV1(index, operation);
  const fields = schemaPropertyNamesV1(schema);
  if (fields.size === 0) {
    diagnostics.push(uiDiagnosticV1(
      "error",
      "UIV1_FORM_SCHEMA_MISSING",
      "The " + form + " form has no resolvable OpenAPI request schema.",
      { profile: profileName, resource: resourceId, path: "forms." + form },
    ));
    return;
  }
  for (const scope of controlScopes(uiSchema)) {
    const field = directPropertyFromScope(scope);
    if (field === undefined || !fields.has(field)) {
      diagnostics.push(uiDiagnosticV1(
        "error",
        "UIV1_FORM_FIELD_NOT_FOUND",
        "UI Schema scope " + scope + " is not present in the " + form + " request schema.",
        { profile: profileName, resource: resourceId, path: "forms." + form },
      ));
    }
  }
}

function compileResource(resource: UiResourceProfileV1): CompiledUiResourceV1 {
  return Object.freeze({
    id: resource.id,
    title: resource.title ?? resource.id,
    ...(resource.singularTitle !== undefined ? { singularTitle: resource.singularTitle } : {}),
    ...(resource.keyField !== undefined ? { keyField: resource.keyField } : {}),
    route: "/resources/" + encodeURIComponent(resource.id),
    operations: compileOperations(resource),
    ...(resource.list !== undefined ? { list: resource.list } : {}),
    ...(resource.detail !== undefined ? { detail: resource.detail } : {}),
    ...(resource.forms !== undefined ? { forms: resource.forms } : {}),
    actions: Object.freeze((resource.actions ?? []).map(compileAction)),
    ...(resource.extensions !== undefined ? { extensions: resource.extensions } : {}),
  });
}

function compileOperations(resource: UiResourceProfileV1): CompiledUiResourceOperationsV1 {
  const operations = resource.operations;
  return Object.freeze({
    ...(operations?.list !== undefined ? { list: operations.list } : {}),
    ...(operations?.read !== undefined ? { read: operations.read } : {}),
    ...(operations?.create !== undefined ? { create: operations.create } : {}),
    ...(operations?.update !== undefined ? { update: operations.update } : {}),
    ...(operations?.delete !== undefined ? { delete: operations.delete } : {}),
  });
}

function compileAction(action: NonNullable<UiResourceProfileV1["actions"]>[number]): CompiledUiActionV1 {
  return Object.freeze({
    id: action.id,
    title: action.title,
    operation: action.operation,
    placements: action.placements,
    ...(action.intent !== undefined ? { intent: action.intent } : {}),
    ...(action.confirm !== undefined ? { confirm: action.confirm } : {}),
    ...(action.refresh !== undefined ? { refresh: action.refresh } : {}),
    ...(action.extensions !== undefined ? { extensions: action.extensions } : {}),
  });
}

function compileNavigation(
  resource: UiResourceProfileV1,
  compiled: CompiledUiResourceV1,
): CompiledUiNavigationItemV1 {
  const navigation = resource.navigation;
  return Object.freeze({
    id: resource.id,
    title: navigation?.title ?? compiled.title,
    route: compiled.route,
    resource: resource.id,
    ...(navigation?.group !== undefined ? { group: navigation.group } : {}),
    ...(navigation?.icon !== undefined ? { icon: navigation.icon } : {}),
    ...(navigation?.order !== undefined ? { order: navigation.order } : {}),
  });
}

function detailFields(resource: UiResourceProfileV1): readonly UiFieldProfileV1[] | undefined {
  const fields = resource.detail?.sections?.flatMap((section) => section.fields);
  if (fields !== undefined && fields.length > 0) {
    return fields;
  }
  const direct = [
    resource.detail?.titleField,
    resource.detail?.subtitleField,
    resource.detail?.statusField,
  ].filter((field): field is string => field !== undefined);
  return direct.length > 0 ? direct : undefined;
}

function operationOf(
  index: UiOpenApiIndexV1,
  reference: UiOperationRefV1 | undefined,
): UiOpenApiOperationV1 | undefined {
  return reference === undefined ? undefined : index.operations.get(reference.operationId);
}

function fieldName(field: UiFieldProfileV1): string {
  return field;
}

function controlScopes(element: UiSchemaElementV1): readonly string[] {
  switch (element.type) {
    case "Control":
      return [element.scope];
    case "Label":
      return [];
    case "Categorization":
    case "Category":
    case "VerticalLayout":
    case "HorizontalLayout":
    case "Group":
      return element.elements.flatMap(controlScopes);
  }
}

function directPropertyFromScope(scope: string): string | undefined {
  const prefix = "#/properties/";
  if (!scope.startsWith(prefix)) {
    return undefined;
  }
  const segment = scope.slice(prefix.length);
  if (segment.length === 0 || segment.includes("/")) {
    return undefined;
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(field + " must be a non-empty string.");
  }
  return normalized;
}

function hasErrors(diagnostics: readonly UiDiagnosticV1[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UI profile is not JSON-safe.";
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}
