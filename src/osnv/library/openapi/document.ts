import type { OpenApiCatalogOperation, OpenApiDocumentBuildInput, OpenApiParameter, OpenApiSchema } from "./types";

type OpenApiOperation = {
  tags: string[];
  operationId: string;
  summary: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiSchema;
  responses: Record<string, OpenApiSchema>;
  security?: readonly OpenApiSchema[];
  [extension: `x-${string}`]: unknown;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const HTTP_METHOD_KEYS = new Set([...HTTP_METHODS].map((method) => method.toLowerCase()));

export function buildOpenApiDocument(input: OpenApiDocumentBuildInput): OpenApiSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  let hasSecurity = false;

  for (const item of input.operations) {
    const operation = operationFromCatalog(item);
    if (operation.security !== undefined) {
      hasSecurity = true;
    }
    addOperation(paths, item.path, item.httpMethod, operation);
  }

  const components: Record<string, unknown> = { schemas: schemasForPaths(input.schemas, paths) };
  if (hasSecurity) {
    components.securitySchemes = {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: input.title,
      version: input.version,
      ...(input.generatedBy !== undefined ? { "x-generated-by": input.generatedBy } : {}),
    },
    paths,
    components,
  };
}

/**
 * Creates the least-privilege OpenAPI view for an effective UI surface.
 * Only explicitly allowed operations and the schemas reachable from them are
 * retained. A missing operation is a server configuration error, never a
 * reason to silently publish a broader document.
 */
export function projectOpenApiByOperationIds(
  document: OpenApiSchema,
  operationIds: ReadonlySet<string> | readonly string[],
): OpenApiSchema {
  const requested = operationIds instanceof Set ? operationIds : new Set(operationIds);
  const found = new Set<string>();
  const projectedPaths: Record<string, Record<string, unknown>> = {};
  const sourcePaths = isRecord(document.paths) ? document.paths : {};

  for (const [path, sourceItem] of Object.entries(sourcePaths)) {
    if (!isRecord(sourceItem)) {
      continue;
    }
    const projectedItem: Record<string, unknown> = {};
    let hasOperation = false;
    for (const [key, value] of Object.entries(sourceItem)) {
      if (HTTP_METHOD_KEYS.has(key)) {
        if (isRequestedOperation(value, requested, found)) {
          projectedItem[key] = value;
          hasOperation = true;
        }
        continue;
      }
      if (key === "x-osnv-any-method") {
        const projected = requestedAnyMethodOperations(value, requested, found);
        if (projected !== undefined) {
          projectedItem[key] = projected;
          hasOperation = true;
        }
        continue;
      }
      projectedItem[key] = value;
    }
    if (hasOperation) {
      projectedPaths[path] = projectedItem;
    }
  }

  const missing = [...requested].filter((operationId) => !found.has(operationId)).sort();
  if (missing.length > 0) {
    throw new TypeError(`OpenAPI operations not found: ${missing.join(", ")}.`);
  }

  const sourceComponents = isRecord(document.components) ? document.components : {};
  const sourceSchemas = isRecord(sourceComponents.schemas)
    ? sourceComponents.schemas as Readonly<Record<string, OpenApiSchema>>
    : {};
  const components: Record<string, unknown> = {
    schemas: schemasForPaths(sourceSchemas, projectedPaths),
  };
  if (sourceComponents.securitySchemes !== undefined) {
    components.securitySchemes = sourceComponents.securitySchemes;
  }

  return {
    ...(document.openapi !== undefined ? { openapi: document.openapi } : {}),
    ...(document.info !== undefined ? { info: document.info } : {}),
    ...(document.jsonSchemaDialect !== undefined ? { jsonSchemaDialect: document.jsonSchemaDialect } : {}),
    ...(document.servers !== undefined ? { servers: document.servers } : {}),
    ...(document.security !== undefined ? { security: document.security } : {}),
    ...(document.externalDocs !== undefined ? { externalDocs: document.externalDocs } : {}),
    paths: projectedPaths,
    components,
  };
}

function isRequestedOperation(
  value: unknown,
  requested: ReadonlySet<string>,
  found: Set<string>,
): boolean {
  if (!isRecord(value) || typeof value.operationId !== "string" || !requested.has(value.operationId)) {
    return false;
  }
  found.add(value.operationId);
  return true;
}

function requestedAnyMethodOperations(
  value: unknown,
  requested: ReadonlySet<string>,
  found: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    const operations = value.filter((item) => isRequestedOperation(item, requested, found));
    return operations.length === 0 ? undefined : operations;
  }
  return isRequestedOperation(value, requested, found) ? value : undefined;
}

function operationFromCatalog(item: OpenApiCatalogOperation): OpenApiOperation {
  const operation: OpenApiOperation = {
    tags: [item.tag],
    operationId: item.operationId,
    summary: item.summary ?? `${normalizedMethod(item.httpMethod)} ${item.path}`,
    responses: { ...item.responses },
  };
  const parameters = mergeParameters(item.parameters ?? []);
  if (parameters.length > 0) {
    operation.parameters = parameters;
  }
  if (item.requestBody !== undefined) {
    operation.requestBody = item.requestBody;
  }
  if (item.authorized === true) {
    operation.security = [{ bearerAuth: [] }];
  }
  if (item.versions !== undefined && item.versions.length > 0) {
    operation["x-osnv-versions"] = uniqueStrings(item.versions);
  }
  return operation;
}

function addOperation(
  paths: Record<string, Record<string, unknown>>,
  path: string,
  httpMethod: string,
  operation: OpenApiOperation,
): void {
  const item = (paths[path] ??= {});
  if (httpMethod === "*") {
    const existing = item["x-osnv-any-method"];
    item["x-osnv-any-method"] = mergeAnyMethod(existing, operation);
    return;
  }
  if (!HTTP_METHODS.has(httpMethod)) {
    return;
  }
  const key = httpMethod.toLowerCase();
  const existing = item[key];
  item[key] = existing && isRecord(existing) ? mergeOperations(existing, operation) : operation;
}

function mergeAnyMethod(existing: unknown, operation: OpenApiOperation): OpenApiOperation | OpenApiOperation[] {
  if (existing === undefined) {
    return operation;
  }
  return Array.isArray(existing) ? [...existing, operation] : [existing as OpenApiOperation, operation];
}

function mergeOperations(existing: Record<string, unknown>, next: OpenApiOperation): OpenApiOperation {
  const existingOperationId = String(existing.operationId ?? next.operationId);
  const versions = uniqueStrings([
    ...readStringArray(existing["x-osnv-versions"]),
    ...readStringArray(next["x-osnv-versions"]),
  ]);
  const parameters = mergeParameters([
    ...readParameters(existing.parameters),
    ...(next.parameters ?? []),
  ]);
  return {
    ...next,
    operationId: existingOperationId === next.operationId
      ? existingOperationId
      : `${existingOperationId}_${next.operationId}`,
    parameters: parameters.length > 0 ? parameters : undefined,
    responses: { ...(existing.responses as Record<string, OpenApiSchema> | undefined), ...next.responses },
    ...(versions.length > 0 ? { "x-osnv-versions": versions } : {}),
  };
}

function mergeParameters(parameters: readonly OpenApiParameter[]): OpenApiParameter[] {
  const out: OpenApiParameter[] = [];
  for (const parameter of parameters) {
    const existingIndex = out.findIndex((item) => item.in === parameter.in && item.name === parameter.name);
    if (existingIndex < 0) {
      out.push({ ...parameter });
      continue;
    }
    const existing = out[existingIndex] as OpenApiParameter;
    out[existingIndex] = {
      ...existing,
      required: existing.required === true || parameter.required === true,
      schema: mergeParameterSchema(existing.schema, parameter.schema),
      // One projected operation may cover multiple query/header versions.
      // Only their common fields are safe to offer without selecting a version.
      ...(existing["x-osnv-sort-fields"] !== undefined || parameter["x-osnv-sort-fields"] !== undefined
        ? { "x-osnv-sort-fields": (existing["x-osnv-sort-fields"] ?? []).filter(
            (field) => parameter["x-osnv-sort-fields"]?.includes(field),
          ) }
        : {}),
    };
  }
  return out;
}

function mergeParameterSchema(left: OpenApiSchema | undefined, right: OpenApiSchema | undefined): OpenApiSchema | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftEnum = readStringArray(left.enum);
  const rightEnum = readStringArray(right.enum);
  if (leftEnum.length === 0 && rightEnum.length === 0) {
    return left;
  }
  return { ...left, enum: uniqueStrings([...leftEnum, ...rightEnum]) };
}

function schemasForPaths(
  schemas: Readonly<Record<string, OpenApiSchema>>,
  paths: Record<string, Record<string, unknown>>,
): Record<string, OpenApiSchema> {
  const out: Record<string, OpenApiSchema> = {};
  const seen = new Set<string>();
  const queue: string[] = [];
  const add = (name: string): void => {
    if (seen.has(name) || schemas[name] === undefined) {
      return;
    }
    seen.add(name);
    queue.push(name);
  };
  collectRefs(paths, add);
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index] as string;
    const schema = schemas[name] as OpenApiSchema;
    out[name] = schema;
    collectRefs(schema, add);
  }
  return out;
}

function collectRefs(value: unknown, add: (name: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, add);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (value.$ref.startsWith(prefix)) {
      add(value.$ref.slice(prefix.length));
    }
  }
  for (const item of Object.values(value)) {
    collectRefs(item, add);
  }
}

function normalizedMethod(method: string): string {
  return method === "*" ? "ANY" : method;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readParameters(value: unknown): OpenApiParameter[] {
  return Array.isArray(value) ? value.filter(isOpenApiParameter) : [];
}

function isOpenApiParameter(value: unknown): value is OpenApiParameter {
  return isRecord(value) && typeof value.name === "string" && (value.in === "path" || value.in === "query" || value.in === "header");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
