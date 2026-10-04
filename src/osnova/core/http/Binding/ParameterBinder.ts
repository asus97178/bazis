import { ListQueryError, parseListQuery } from "../../../library/jsonapi";
import { BadRequestError, UnsupportedMediaTypeError } from "../Errors/HttpError";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { ParameterBinding } from "./bindings";
import { convertOr400 } from "./convert";
import { bindModel } from "./modelBinder";

/** Per-action constraints affecting binding (from decorators). */
export interface BindingDefaults {
  /** `@Consumes(...)`: required request Content-Type for body access. */
  consumes?: string;
}

function bindValue(binding: ParameterBinding, raw: string | undefined, kind: string): unknown {
  if (raw === undefined) {
    if (binding.defaultValue !== undefined) {
      return binding.defaultValue;
    }
    if (binding.optional) {
      return undefined;
    }
    throw new BadRequestError(`Missing required ${kind} parameter "${binding.name}"`);
  }
  return binding.type && binding.type !== "string" ? convertOr400(raw, binding.type, binding.name ?? "?") : raw;
}

/**
 * Resolves generated binding descriptors into the action's argument list.
 * All conversions fail with 400 (never 500); body parse errors and model
 * validation are handled by the body branch.
 */
export async function bindArguments(
  bindings: readonly ParameterBinding[],
  ctx: HttpContext,
  defaults: BindingDefaults,
): Promise<unknown[]> {
  const args: unknown[] = new Array(bindings.length);
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    switch (binding.source) {
      case "route": {
        const value = binding.name !== undefined ? ctx.params[binding.name] : undefined;
        // Route params are already constraint-converted; re-convert only when
        // the binding asks for a different primitive type.
        if (value === undefined) {
          args[index] = bindValue(binding, undefined, "route");
        } else if (binding.type && binding.type !== "string" && typeof value === "string") {
          args[index] = convertOr400(value, binding.type, binding.name ?? "?");
        } else {
          args[index] = value;
        }
        break;
      }
      case "query":
        args[index] = bindValue(binding, ctx.query(binding.name ?? ""), "query");
        break;
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
        args[index] = binding.model ? bindModel(binding.model, data, ctx.modelValidator) : data;
        break;
      }
      case "request":
        args[index] = ctx.request;
        break;
      case "response":
        args[index] = ctx.res;
        break;
      case "context":
        args[index] = ctx;
        break;
      case "list": {
        let parsed;
        try {
          parsed = parseListQuery(ctx.url.searchParams, binding.listOptions);
        } catch (error) {
          if (error instanceof ListQueryError) {
            throw new BadRequestError("Invalid list query", error.problems);
          }
          throw error;
        }
        if (binding.model) {
          // Class-based list request (extends ListRequest): instantiate and
          // populate the parsed sort/filters/page so the action gets a typed object.
          args[index] = Object.assign(new (binding.model as new () => object)(), parsed);
        } else {
          args[index] = parsed;
        }
        break;
      }
    }
  }
  return args;
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}
