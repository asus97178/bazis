import { ListQueryError, parseListQuery } from "../../../library/jsonapi";
import { bindSourceModel } from "./sourceModelBinder";
import { ModelValidationError, UnsupportedMediaTypeError, frameworkBadRequest } from "../Errors/HttpError";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { ParameterBinding } from "./bindings";
import { INVALID, tryConvert, type ValueType } from "./convert";
import type { ModelValidationIssue } from "./modelValidator";
import { bindModelAsync } from "./modelBinder";

/** Per-action constraints affecting binding (from decorators). */
export interface BindingDefaults {
  /** `@Consumes(...)`: required request Content-Type for body access. */
  consumes?: string;
}

const BODILESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `consumes` of a route applies to every request with a body, however the
 * action reads it: a body model, `ctx.formData()`, `ctx.text()` or nothing.
 */
export function assertConsumes(ctx: HttpContext, consumes: string | undefined): void {
  if (consumes === undefined || BODILESS_METHODS.has(ctx.method)) return;
  const contentType = ctx.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(consumes.toLowerCase())) {
    throw new UnsupportedMediaTypeError(consumes);
  }
}

/**
 * One parameter that cannot be bound: an item of the single 400 that lists
 * every binding problem of the request, like model validation errors.
 */
class ParameterIssue extends Error {
  constructor(readonly issue: ModelValidationIssue) {
    super(issue.message);
  }
}

/** Type names in the `type` message: `int` stays, `bool` reads as `boolean`. */
const EXPECTED: Readonly<Record<ValueType, string>> = { string: "string", int: "int", number: "number", bool: "boolean" };

function issueOf(ctx: HttpContext, code: "required" | "type", params: Readonly<Record<string, unknown>>, english: string): ParameterIssue {
  const message = ctx.modelValidator?.message?.(code, params) ?? english;
  return new ParameterIssue({ property: params.property as string, message, code, params });
}

function missing(ctx: HttpContext, name: string): ParameterIssue {
  return issueOf(ctx, "required", { property: name }, `Field "${name}" is required`);
}

/** Converts a raw value or reports it as a `type` issue under the parameter name. */
function converted(ctx: HttpContext, raw: string, type: ValueType, name: string): string | number | boolean {
  const value = tryConvert(raw, type);
  if (value === INVALID) {
    const expected = EXPECTED[type];
    throw issueOf(ctx, "type", { property: name, expected, actual: "string" }, `Field "${name}" must be of type ${expected}, got: string`);
  }
  return value;
}

function bindValue(binding: ParameterBinding, raw: string | undefined, ctx: HttpContext): unknown {
  const name = binding.name ?? "?";
  if (raw === undefined) {
    if (binding.defaultValue !== undefined) {
      return binding.defaultValue;
    }
    if (binding.optional) {
      return undefined;
    }
    throw missing(ctx, name);
  }
  return binding.type && binding.type !== "string" ? converted(ctx, raw, binding.type, name) : raw;
}

/**
 * `?tag=a&tag=b` → `["a", "b"]`, each value converted by the element type.
 * Without the parameter: the default, `undefined` for `tag?: string[]`, or `[]`.
 */
function bindArray(binding: ParameterBinding, ctx: HttpContext): unknown {
  const raw = ctx.url.searchParams.getAll(binding.name ?? "");
  if (raw.length === 0) {
    if (binding.defaultValue !== undefined) return binding.defaultValue;
    return binding.optional ? undefined : [];
  }
  return binding.type && binding.type !== "string"
    ? raw.map((value) => converted(ctx, value, binding.type!, binding.name ?? "?"))
    : raw;
}

/**
 * Resolves generated binding descriptors into the action's argument list.
 * Every argument is bound even when an earlier one fails: missing or invalid
 * route, query and header values and the validation errors of body, query and
 * header models come together in one 400 (`Validation failed` with
 * `details`), like ASP.NET model state. Errors of the request itself
 * (malformed JSON, wrong media type, too large) stop at once.
 */
export async function bindArguments(
  bindings: readonly ParameterBinding[],
  ctx: HttpContext,
  defaults: BindingDefaults,
): Promise<unknown[]> {
  const args: unknown[] = new Array(bindings.length);
  const issues: ModelValidationIssue[] = [];
  let title: string | undefined;
  for (let index = 0; index < bindings.length; index += 1) {
    try {
      args[index] = await bindOne(bindings[index]!, ctx, defaults);
    } catch (error) {
      if (error instanceof ParameterIssue) {
        issues.push(error.issue);
      } else if (error instanceof ModelValidationError) {
        issues.push(...error.errors);
        title ??= error.message;
      } else {
        throw error;
      }
    }
  }
  if (issues.length > 0) {
    throw new ModelValidationError(issues, title ?? ctx.modelValidator?.message?.("validationFailed", {}) ?? "Validation failed");
  }
  return args;
}

/** One argument; a parameter problem is thrown as ParameterIssue or ModelValidationError. */
async function bindOne(binding: ParameterBinding, ctx: HttpContext, defaults: BindingDefaults): Promise<unknown> {
  switch (binding.source) {
    case "route": {
      const value = binding.name !== undefined ? ctx.params[binding.name] : undefined;
      // Route params are already constraint-converted; re-convert only when
      // the binding asks for a different primitive type.
      if (value === undefined) return bindValue(binding, undefined, ctx);
      if (binding.type && binding.type !== "string" && typeof value === "string") return converted(ctx, value, binding.type, binding.name ?? "?");
      return value;
    }
    case "query":
      return binding.array ? bindArray(binding, ctx) : bindValue(binding, ctx.query(binding.name ?? ""), ctx);
    case "header":
      return bindValue(binding, ctx.header(binding.name ?? ""), ctx);
    case "queryModel":
    case "headerModel":
      return bindSourceModel(binding, ctx);
    case "body": {
      const contentType = ctx.header("content-type") ?? "";
      if (defaults.consumes) {
        if (!contentType.toLowerCase().startsWith(defaults.consumes.toLowerCase())) {
          throw new UnsupportedMediaTypeError(defaults.consumes);
        }
      } else if (!isJsonMediaType(contentType)) {
        // Convention-based body-model binding is a JSON boundary. Requiring
        // a non-simple media type also prevents cross-origin text/plain POSTs
        // from bypassing the browser's CORS preflight.
        throw new UnsupportedMediaTypeError("application/json");
      }
      const data = await ctx.json();
      return binding.model ? bindModelAsync(binding.model, data, ctx.modelValidator, { primitiveTypes: true }) : data;
    }
    case "request":
      return ctx.request;
    case "response":
      return ctx.res;
    case "context":
      return ctx;
    case "list": {
      let parsed;
      try {
        parsed = parseListQuery(ctx.url.searchParams, binding.listOptions);
      } catch (error) {
        if (error instanceof ListQueryError) {
          throw frameworkBadRequest("invalidListQuery", undefined, error.problems);
        }
        throw error;
      }
      // Class-based list request (extends ListRequest): instantiate and
      // populate the parsed sort/filters/page so the action gets a typed object.
      return binding.model ? Object.assign(new (binding.model as new () => object)(), parsed) : parsed;
    }
  }
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}
