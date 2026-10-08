import type { HttpMiddleware } from "../Middleware/types";
import { HttpSetupError } from "../Errors/HttpError";
import { ownActionMeta, ownRoutes } from "./metadata";

type MethodDecorator = (value: (...args: never[]) => unknown, context: ClassMethodDecoratorContext) => void;

/**
 * Inline action options: the equivalent of separate attribute decorators
 * gathered into one object (the `@Validator({...})` style):
 *
 * ```ts
 * @Post(":id(int)", { code: 201, produces: "application/json" })
 * update(id: number) { ... }
 *
 * @Post({ code: 202 })          // empty path: options as the first argument
 * enqueue() { ... }
 * ```
 */
export interface RouteOptions {
  /** Status of a successful response (= `@HttpCode`). */
  readonly code?: number;
  /** Response Content-Type for plain results (= `@Produces`). */
  readonly produces?: string;
  /** Required request Content-Type for body bindings (= `@Consumes`). */
  readonly consumes?: string;
  /** API version of the action (= `@ApiVersion` on the method). */
  readonly version?: string;
  /** Route middleware (= `@Middleware` on the method). */
  readonly middleware?: readonly HttpMiddleware[];
  /** Maximum body size: an integer and a binary unit together, for example `4mb`. */
  readonly maxBodySize?: `${bigint}${"b" | "kb" | "mb" | "gb"}`;
}

function route(httpMethod: string, templateOrOptions?: string | RouteOptions, maybeOptions?: RouteOptions): MethodDecorator {
  const template = typeof templateOrOptions === "string" ? templateOrOptions : "";
  const options = typeof templateOrOptions === "object" ? templateOrOptions : maybeOptions;
  return (_value, context) => {
    if (context.static || context.private) {
      throw new Error(`HTTP route decorators support public instance methods only ("${String(context.name)}").`);
    }
    const action = ownActionMeta(context.metadata, context.name);
    ownRoutes(action).push({ httpMethod, template });
    if (options) {
      // Options apply to the whole action (like attribute decorators); with
      // several route decorators scalar fields are overwritten and
      // middleware accumulates.
      if (options.code !== undefined) {
        action.httpCode = options.code;
      }
      if (options.produces !== undefined) {
        action.produces = options.produces;
      }
      if (options.consumes !== undefined) {
        action.consumes = options.consumes;
      }
      if (options.version !== undefined) {
        action.version = options.version;
      }
      if (options.middleware !== undefined) {
        action.middleware.push(...options.middleware);
      }
      if (options.maxBodySize !== undefined) {
        const maxBodyBytes = parseRouteMaxBodySize(options.maxBodySize);
        if (action.maxBodyBytes !== undefined && action.maxBodyBytes !== maxBodyBytes) {
          throw new HttpSetupError(
            "HTTP route decorators on one action must resolve maxBodySize to the same byte limit.",
          );
        }
        action.maxBodyBytes = maxBodyBytes;
      }
    }
  };
}

function parseRouteMaxBodySize(input: unknown): number {
  const formatError = () => new HttpSetupError(
    "HTTP route maxBodySize must match '<positive integer><b|kb|mb|gb>' (e.g. '4mb').",
  );
  if (typeof input !== "string" || input.length > 18) {
    throw formatError();
  }
  const match = /^([1-9][0-9]{0,15})(b|kb|mb|gb)$/.exec(input);
  if (match === null || match[0] !== input) {
    throw formatError();
  }
  const multiplier = match[2] === "gb"
    ? 1_073_741_824n
    : match[2] === "mb"
      ? 1_048_576n
      : match[2] === "kb"
        ? 1_024n
        : 1n;
  const bytes = BigInt(match[1]!) * multiplier;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpSetupError("HTTP route maxBodySize exceeds Number.MAX_SAFE_INTEGER bytes.");
  }
  return Number(bytes);
}

type RouteFactory = {
  (template?: string, options?: RouteOptions): MethodDecorator;
  (options: RouteOptions): MethodDecorator;
};

function createRouteFactory(httpMethod: string): RouteFactory {
  return ((templateOrOptions?: string | RouteOptions, maybeOptions?: RouteOptions) =>
    route(httpMethod, templateOrOptions, maybeOptions)) as RouteFactory;
}

/**
 * Route decorators. The template is relative to the controller prefix and
 * supports constrained parameters and a trailing wildcard:
 *
 * - `":id"`: a string parameter;
 * - `":id(int)"`, `":n(number)"`, `":f(bool)"`, `":u(uuid)"`, `":a(alpha)"`:
 *   a constrained parameter with auto-conversion (a mismatch -> the route does not match);
 * - `"*rest"`: catch-all, captures the rest of the path (last segment only).
 *
 * The second argument (or the first, if the path is empty) takes inline action
 * options, see {@link RouteOptions}. A method may have several route
 * decorators; the action is reachable through all of them.
 */
export const Get = createRouteFactory("GET");
export const Post = createRouteFactory("POST");
export const Put = createRouteFactory("PUT");
export const Patch = createRouteFactory("PATCH");
export const Delete = createRouteFactory("DELETE");
export const Options = createRouteFactory("OPTIONS");
export const Head = createRouteFactory("HEAD");
/** Matches any HTTP method (lowest priority when choosing). */
export const All = createRouteFactory("*");
