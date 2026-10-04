import type { OpenApiSchema } from "../../openapi";
import { uiDiagnosticV1, type UiDiagnosticV1 } from "../diagnostics-v1";

export type UiOpenApiHttpMethodV1 = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface UiOpenApiOperationV1 {
  readonly operationId: string;
  readonly method: UiOpenApiHttpMethodV1;
  readonly path: string;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly requestSchema?: OpenApiSchema;
  readonly responseSchema?: OpenApiSchema;
}

export interface UiOpenApiIndexV1 {
  readonly operations: ReadonlyMap<string, UiOpenApiOperationV1>;
  readonly schemas: Readonly<Record<string, OpenApiSchema>>;
}

export interface UiOpenApiIndexResultV1 {
  readonly index: UiOpenApiIndexV1;
  readonly diagnostics: readonly UiDiagnosticV1[];
}

const METHODS: Readonly<Record<string, UiOpenApiHttpMethodV1>> = Object.freeze({
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
});

export function indexOpenApiV1(document: OpenApiSchema): UiOpenApiIndexResultV1 {
  const diagnostics: UiDiagnosticV1[] = [];
  const operations = new Map<string, UiOpenApiOperationV1>();
  const paths = asRecord(document["paths"]);

  for (const path of Object.keys(paths).sort()) {
    const pathItem = asRecord(paths[path]);
    for (const [methodName, method] of Object.entries(METHODS)) {
      const operation = asRecord(pathItem[methodName]);
      if (Object.keys(operation).length === 0) {
        continue;
      }
      const operationId = operation["operationId"];
      if (typeof operationId !== "string" || operationId.trim().length === 0) {
        continue;
      }
      if (operations.has(operationId)) {
        diagnostics.push(uiDiagnosticV1(
          "error",
          "UIV1_OPENAPI_DUPLICATE_OPERATION_ID",
          "OpenAPI operationId " + operationId + " is declared more than once.",
          { path: path + "." + methodName },
        ));
        continue;
      }

      operations.set(operationId, Object.freeze({
        operationId,
        method,
        path,
        operation,
        requestSchema: requestSchemaOf(operation),
        responseSchema: responseSchemaOf(operation),
      }));
    }
  }

  return {
    index: Object.freeze({
      operations,
      schemas: schemasOf(document),
    }),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function resolveSchemaV1(
  index: UiOpenApiIndexV1,
  schema: OpenApiSchema | undefined,
): OpenApiSchema | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const ref = schema["$ref"];
  if (typeof ref !== "string") {
    return schema;
  }
  const prefix = "#/components/schemas/";
  return ref.startsWith(prefix) ? index.schemas[ref.slice(prefix.length)] : undefined;
}

export function responseEntitySchemaV1(
  index: UiOpenApiIndexV1,
  operation: UiOpenApiOperationV1 | undefined,
): OpenApiSchema | undefined {
  const response = resolveSchemaV1(index, operation?.responseSchema);
  if (response === undefined) {
    return undefined;
  }

  if (response["type"] === "array") {
    const items = asRecord(response["items"]);
    return Object.keys(items).length > 0 ? resolveSchemaV1(index, items) : undefined;
  }

  const properties = asRecord(response["properties"]);
  for (const collectionField of ["data", "items"] as const) {
    const collection = asRecord(properties[collectionField]);
    const items = asRecord(collection["items"]);
    if (Object.keys(items).length > 0) {
      return resolveSchemaV1(index, items);
    }
  }
  return response;
}

export function requestEntitySchemaV1(
  index: UiOpenApiIndexV1,
  operation: UiOpenApiOperationV1 | undefined,
): OpenApiSchema | undefined {
  return resolveSchemaV1(index, operation?.requestSchema);
}

export function schemaPropertyNamesV1(schema: OpenApiSchema | undefined): ReadonlySet<string> {
  return new Set(Object.keys(asRecord(schema?.["properties"])));
}

export function listFilterCapabilitiesV1(
  operation: UiOpenApiOperationV1 | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const filters = new Map<string, Set<string>>();
  for (const parameter of operationParameters(operation)) {
    if (parameter["in"] !== "query" || typeof parameter["name"] !== "string") {
      continue;
    }
    const match = /^filter\[([^\]]+)\]\[([^\]]+)\]$/.exec(parameter["name"]);
    if (match === null) {
      continue;
    }
    const field = match[1] as string;
    const operator = match[2] as string;
    const operators = filters.get(field) ?? new Set<string>();
    operators.add(operator);
    filters.set(field, operators);
  }
  const declared = hasQueryParameterV1(operation, "filter")
    ? asRecord(operation?.operation["x-osnova-list-filters"])
    : {};
  for (const [field, value] of Object.entries(declared)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const operators = filters.get(field) ?? new Set<string>();
    for (const operator of value) {
      if (typeof operator === "string" && operator.trim().length > 0) {
        operators.add(operator.trim());
      }
    }
    if (operators.size > 0) {
      filters.set(field, operators);
    }
  }
  return filters;
}

export function listMaxPageSizeV1(operation: UiOpenApiOperationV1 | undefined): number | undefined {
  const maxima: number[] = [];
  for (const parameter of operationParameters(operation)) {
    if (
      parameter["in"] !== "query"
      || (parameter["name"] !== "page[size]" && parameter["name"] !== "limit")
    ) {
      continue;
    }
    const maximum = asRecord(parameter["schema"])["maximum"];
    if (typeof maximum === "number" && Number.isFinite(maximum)) {
      maxima.push(maximum);
    }
  }
  return maxima.length === 0 ? undefined : Math.min(...maxima);
}

export function hasQueryParameterV1(
  operation: UiOpenApiOperationV1 | undefined,
  name: string,
): boolean {
  return operationParameters(operation).some(
    (parameter) => parameter["in"] === "query" && parameter["name"] === name,
  );
}

function requestSchemaOf(operation: Readonly<Record<string, unknown>>): OpenApiSchema | undefined {
  const requestBody = asRecord(operation["requestBody"]);
  return schemaFromContent(requestBody["content"]);
}

function responseSchemaOf(operation: Readonly<Record<string, unknown>>): OpenApiSchema | undefined {
  const responses = asRecord(operation["responses"]);
  const successCode = Object.keys(responses)
    .filter((code) => /^2[0-9][0-9]$/.test(code))
    .sort()[0];
  if (successCode === undefined) {
    return undefined;
  }
  const response = asRecord(responses[successCode]);
  return schemaFromContent(response["content"]);
}

function schemaFromContent(contentValue: unknown): OpenApiSchema | undefined {
  const content = asRecord(contentValue);
  const mediaType = asRecord(content["application/json"]);
  const schema = asRecord(mediaType["schema"]);
  return Object.keys(schema).length === 0 ? undefined : schema;
}

function operationParameters(
  operation: UiOpenApiOperationV1 | undefined,
): readonly Readonly<Record<string, unknown>>[] {
  const parameters = operation?.operation["parameters"];
  if (!Array.isArray(parameters)) {
    return [];
  }
  return parameters.map(asRecord).filter((parameter) => Object.keys(parameter).length > 0);
}

function schemasOf(document: OpenApiSchema): Readonly<Record<string, OpenApiSchema>> {
  const components = asRecord(document["components"]);
  const schemas = asRecord(components["schemas"]);
  const out: Record<string, OpenApiSchema> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (isRecord(schema)) {
      out[name] = schema;
    }
  }
  return Object.freeze(out);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
