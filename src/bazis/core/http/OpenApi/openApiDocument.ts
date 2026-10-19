import type { Class } from "../../di";
import { createHash } from "node:crypto";
import {
  buildOpenApiDocument,
  type OpenApiCatalogOperation,
  type OpenApiDocumentBuildInput as LibraryOpenApiDocumentBuildInput,
  type OpenApiParameter,
  type OpenApiSchema,
} from "../../../library/openapi";
import { optionsFromSchema } from "../../../library/jsonapi";
import { resolveAuthorizeMeta, routeAuthorizeChecks, type AuthorizeCheck } from "../Authorization/metadata";
import type { ParameterBinding } from "../Binding/bindings";
import { resolveGeneratedBindings } from "../Binding/autoBindings";
import { controllerMetaOf, type ActionMeta, type ControllerMeta } from "../Decorators/metadata";
import { joinPaths } from "../Routing/template";
import { getGeneratedOpenApiMetadata } from "./generatedOpenApiRegistry";
import type { ApiVersioningOptions } from "../options";
import type { GeneratedOpenApiMetadata } from "../../../library/openapi";

export interface HttpOpenApiDocumentBuildInput {
  readonly controllers: readonly Class<object>[];
  readonly globalPrefix?: string;
  readonly versioning?: ApiVersioningOptions;
  readonly title: string;
  readonly version: string;
  /** Default checks of `runApp({ http: { authorize } })`: such routes are secured too. */
  readonly authorize?: readonly AuthorizeCheck[];
}

/** Body of every error response: `{ "error": "...", "details": ... }` (see Middleware/errorHandler). */
const ERROR_SCHEMA_NAME = "HttpErrorResponse";
const ERROR_SCHEMA: OpenApiSchema = {
  type: "object",
  description: "Error response of the bazis HTTP server.",
  properties: {
    error: { type: "string", description: "Human-readable error message." },
    details: { description: "Error details, for example the list of validation errors." },
  },
  required: ["error"],
};
const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
  413: "Payload Too Large", 415: "Unsupported Media Type", 429: "Too Many Requests",
};

export function buildHttpOpenApiDocument(input: HttpOpenApiDocumentBuildInput): OpenApiSchema {
  const generated = getGeneratedOpenApiMetadata(input.controllers);
  const documentInput: LibraryOpenApiDocumentBuildInput = {
    title: input.title,
    version: input.version,
    schemas: { [ERROR_SCHEMA_NAME]: ERROR_SCHEMA, ...generated.schemas },
    operations: collectOpenApiOperations(input, generated),
    generatedBy: "bazis:di-generate",
  };
  return buildOpenApiDocument(documentInput);
}

function collectOpenApiOperations(
  input: HttpOpenApiDocumentBuildInput,
  generated: GeneratedOpenApiMetadata,
): OpenApiCatalogOperation[] {
  const operations: OpenApiCatalogOperation[] = [];
  for (const controllerClass of input.controllers) {
    const meta = controllerMetaOf(controllerClass);
    if (!meta?.isController) {
      continue;
    }
    for (const [methodName, action] of meta.actions) {
      if (action.routes.length === 0) {
        continue;
      }
      const bindings = resolveGeneratedBindings(controllerClass, methodName) ?? [];
      for (const route of action.routes) {
        operations.push(createOperation({
          controllerClass,
          methodName,
          meta,
          action,
          bindings,
          httpMethod: route.httpMethod,
          path: fullOpenApiPath(input.globalPrefix, input.versioning?.source, meta, action, route.template),
          routeTemplate: joinPaths(meta.prefix, route.template),
          versioning: input.versioning,
          generated,
          defaultChecks: input.authorize ?? [],
        }));
      }
    }
  }
  return operations;
}

interface CreateOperationInput {
  readonly controllerClass: Class<object>;
  readonly methodName: string | symbol;
  readonly meta: ControllerMeta;
  readonly action: ActionMeta;
  readonly bindings: readonly ParameterBinding[];
  readonly httpMethod: string;
  readonly path: string;
  readonly routeTemplate: string;
  readonly versioning?: ApiVersioningOptions;
  readonly generated: GeneratedOpenApiMetadata;
  readonly defaultChecks: readonly AuthorizeCheck[];
}

function createOperation(input: CreateOperationInput): OpenApiCatalogOperation {
  const methodName = String(input.methodName);
  const version = input.action.version ?? input.meta.version;
  const auth = resolveAuthorizeMeta(input.controllerClass, input.methodName);
  const generatedOperation = input.generated.operations[input.controllerClass.name]?.[methodName];
  const status = String(successStatus(input.httpMethod, input.action, generatedOperation?.status));
  const responseSchema = generatedOperation?.response;
  const contentType = input.action.produces ?? "application/json";
  const authorized = routeAuthorizeChecks(input.controllerClass, input.methodName, input.defaultChecks) !== undefined;

  return {
    path: input.path,
    httpMethod: input.httpMethod,
    tag: tagName(input.meta, input.controllerClass),
    operationId: stableHttpOperationId(input.httpMethod, input.path),
    summary: generatedOperation?.summary ?? `${normalizedMethod(input.httpMethod)} ${input.path}`,
    ...(generatedOperation?.description !== undefined ? { description: generatedOperation.description } : {}),
    parameters: collectParameters(
      input.bindings,
      input.versioning,
      version,
      routeParamSchemas(input.routeTemplate),
      input.generated,
    ),
    requestBody: createRequestBody(input.bindings, input.action, input.generated),
    responses: {
      [status]: responseSchema && status !== "204"
        ? {
            description: "Success",
            content: {
              [contentType]: {
                schema: responseSchema,
              },
            },
          }
        : { description: "Success" },
      ...errorResponses(errorStatuses(input.bindings, authorized, generatedOperation?.errors)),
    },
    authorized,
    ...(version !== undefined ? { versions: [version] } : {}),
  };
}

/**
 * Stable transport identity owned by HTTP/OpenAPI. Controller and handler
 * names are intentionally excluded: renaming implementation symbols must not
 * invalidate compiled UI references or generated clients.
 */
function stableHttpOperationId(httpMethod: string, canonicalPath: string): string {
  const method = normalizedMethod(httpMethod).toLowerCase();
  const slug = readableOperationPath(canonicalPath);
  const digest = createHash("sha256")
    .update(JSON.stringify([method, canonicalPath]))
    .digest("hex")
    .slice(0, 32);
  return `http_${method}_${slug}__${digest}`;
}

function readableOperationPath(path: string): string {
  const slug = path
    .replace(/\{([^{}]+)\}/g, " by $1 ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    .replace(/_+$/g, "");
  return slug.length > 0 ? slug : "root";
}

function collectParameters(
  bindings: readonly ParameterBinding[],
  versioning: ApiVersioningOptions | undefined,
  version: string | undefined,
  routeSchemas: Readonly<Record<string, OpenApiSchema>>,
  generated: GeneratedOpenApiMetadata,
): OpenApiParameter[] {
  const parameters: OpenApiParameter[] = [];
  for (const binding of bindings) {
    switch (binding.source) {
      case "route":
        if (binding.name) {
          parameters.push({
            name: binding.name,
            in: "path",
            required: true,
            schema: routeSchemas[binding.name] ?? schemaForValueType(binding.type),
          });
        }
        break;
      case "query":
        if (binding.name) {
          parameters.push({
            name: binding.name,
            in: "query",
            required: binding.array !== true && binding.optional !== true && binding.defaultValue === undefined,
            schema: binding.array ? { type: "array", items: schemaForValueType(binding.type) } : schemaForValueType(binding.type),
          });
        }
        break;
      case "header":
        if (binding.name) {
          parameters.push({
            name: binding.name,
            in: "header",
            required: binding.optional !== true && binding.defaultValue === undefined,
            schema: schemaForValueType(binding.type),
          });
        }
        break;
      case "queryModel":
      case "headerModel":
        parameters.push(...sourceModelParameters(binding, generated));
        break;
      case "list":
        parameters.push(...listParameters(binding));
        break;
      default:
        break;
    }
  }
  if (version !== undefined && versioning !== undefined && versioning.source !== "url") {
    const name = versioning.source === "query" ? (versioning.parameterName ?? "api-version") : (versioning.headerName ?? "x-api-version");
    parameters.push({
      name,
      in: versioning.source,
      required: versioning.defaultVersion === undefined,
      schema: { type: "string", enum: [version] },
    });
  }
  return parameters;
}

/**
 * One parameter per field of a query or header model, under its wire name.
 * Types, rules and descriptions come from the generated schema of the model
 * (the same schema a body model gets), `required` from its `@Validator` rules.
 */
function sourceModelParameters(binding: ParameterBinding, generated: GeneratedOpenApiMetadata): OpenApiParameter[] {
  const schema = binding.model ? generated.schemas[binding.model.name] : undefined;
  const properties = (schema?.properties ?? {}) as Readonly<Record<string, OpenApiSchema>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  const location = binding.source === "headerModel" ? "header" : "query";
  // In the order the class declares its fields, like the body schema.
  const order = Object.keys(properties);
  const position = (property: string) => { const index = order.indexOf(property); return index < 0 ? order.length : index; };
  const fields = [...(binding.fields ?? [])].sort((left, right) => position(left.property) - position(right.property));
  return fields.map((field) => {
    const property = properties[field.property];
    const fallback: OpenApiSchema = field.array ? { type: "array", items: { type: field.type } } : { type: field.type };
    const description = typeof property?.description === "string" ? property.description : undefined;
    return {
      name: field.wire,
      in: location,
      required: required.has(field.property),
      schema: property ?? fallback,
      ...(description !== undefined ? { description } : {}),
      ...(field.array ? { style: "form", explode: true } : {}),
    };
  });
}

function listParameters(binding: ParameterBinding): OpenApiParameter[] {
  const options = binding.listOptions ?? (binding.model ? optionsFromSchema(binding.model) : {});
  const parameters: OpenApiParameter[] = [
    {
      name: "sort", in: "query", required: false, schema: { type: "string" },
      "x-bazis-sort-fields": [...(options.sort ?? [])],
    },
    { name: "page[number]", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
    {
      name: "page[size]",
      in: "query",
      required: false,
      schema: pageSizeSchema(options.page?.maxSize),
    },
  ];
  if (options.include && options.include.length > 0) {
    parameters.push({ name: "include", in: "query", required: false, schema: { type: "string", enum: options.include } });
  }
  for (const [field, operators] of Object.entries(options.filter ?? {})) {
    for (const operator of operators) {
      parameters.push({
        name: `filter[${field}][${operator}]`,
        in: "query",
        required: false,
        schema: { type: "string" },
      });
    }
  }
  return parameters;
}

function pageSizeSchema(maximum: number | undefined): OpenApiSchema {
  return maximum === undefined ? { type: "integer", minimum: 1 } : { type: "integer", minimum: 1, maximum };
}

function createRequestBody(
  bindings: readonly ParameterBinding[],
  action: ActionMeta,
  generated: GeneratedOpenApiMetadata,
): OpenApiSchema | undefined {
  const body = bindings.find((binding) => binding.source === "body");
  if (!body) {
    return undefined;
  }
  const schema = body.model ? schemaForModel(body.model.name, generated) : { type: "object" };
  return {
    required: body.optional !== true,
    content: {
      [action.consumes ?? "application/json"]: {
        schema,
      },
    },
  };
}

function schemaForModel(name: string, generated: GeneratedOpenApiMetadata): OpenApiSchema {
  return generated.schemas[name] !== undefined
    ? { $ref: `#/components/schemas/${name}` }
    : { type: "object", "x-bazis-model": name };
}

function schemaForValueType(type: ParameterBinding["type"]): OpenApiSchema {
  switch (type) {
    case "int":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "bool":
      return { type: "boolean" };
    case "string":
    case undefined:
      return { type: "string" };
  }
}

function routeParamSchemas(template: string): Record<string, OpenApiSchema> {
  const schemas: Record<string, OpenApiSchema> = {};
  for (const segment of template.split("/")) {
    const param = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\(([a-z]+)\))?$/.exec(segment);
    if (param) {
      schemas[param[1] as string] = schemaForConstraint(param[2]);
      continue;
    }
    const wildcard = /^\*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(segment);
    if (wildcard) {
      schemas[(wildcard[1] as string | undefined) ?? "rest"] = { type: "string" };
    }
  }
  return schemas;
}

function schemaForConstraint(constraint: string | undefined): OpenApiSchema {
  switch (constraint) {
    case "int":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "bool":
      return { type: "boolean" };
    case "uuid":
      return { type: "string", format: "uuid" };
    case "alpha":
      return { type: "string", pattern: "^[A-Za-z]+$" };
    default:
      return { type: "string" };
  }
}

function successStatus(method: string, action: ActionMeta, generated: number | undefined): number {
  return action.httpCode ?? generated ?? (method === "DELETE" ? 204 : 200);
}

/**
 * Errors the operation can answer with: 400 when the request carries values
 * that are converted or validated (body, list query, query and header values
 * and models, typed route parameters), 401/403 under @Authorize, and the
 * errors the method body returns or throws itself.
 */
function errorStatuses(
  bindings: readonly ParameterBinding[],
  authorized: boolean,
  generated: readonly number[] | undefined,
): number[] {
  const statuses = new Set(generated ?? []);
  const validated = bindings.some((binding) =>
    binding.source === "body" || binding.source === "list" || binding.source === "query" || binding.source === "header"
    || binding.source === "queryModel" || binding.source === "headerModel"
    || (binding.source === "route" && binding.type !== undefined && binding.type !== "string"));
  if (validated) statuses.add(400);
  if (authorized) {
    statuses.add(401);
    statuses.add(403);
  }
  return [...statuses].sort((a, b) => a - b);
}

function errorResponses(statuses: readonly number[]): Record<string, OpenApiSchema> {
  const responses: Record<string, OpenApiSchema> = {};
  for (const status of statuses) {
    responses[String(status)] = {
      description: ERROR_DESCRIPTIONS[status] ?? "Error",
      content: { "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } } },
    };
  }
  return responses;
}

function tagName(meta: ControllerMeta, controllerClass: Class<object>): string {
  const firstPrefix = meta.prefix?.split("/").find((part) => part.length > 0);
  return firstPrefix ?? controllerClass.name.replace(/Controller$/, "");
}

function fullOpenApiPath(
  globalPrefix: string | undefined,
  versionSource: "url" | "query" | "header" | undefined,
  meta: ControllerMeta,
  action: ActionMeta,
  template: string,
): string {
  const version = action.version ?? meta.version;
  const versionSegment = (versionSource === undefined || versionSource === "url") && version !== undefined ? `v${version}` : undefined;
  const joined = joinPaths(globalPrefix, versionSegment, meta.prefix, template);
  return `/${templateToOpenApiPath(joined)}`;
}

function templateToOpenApiPath(template: string): string {
  if (template === "") {
    return "";
  }
  return template
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(":")) {
        const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(segment);
        return match ? `{${match[1]}}` : segment;
      }
      if (segment.startsWith("*")) {
        const name = segment.length > 1 ? segment.slice(1) : "rest";
        return `{${name}}`;
      }
      return segment;
    })
    .join("/");
}

function normalizedMethod(method: string): string {
  return method === "*" ? "ANY" : method;
}
