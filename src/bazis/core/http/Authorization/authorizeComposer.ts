import { ForbiddenError } from "../Errors/HttpError";
import type { HttpMiddleware } from "../Middleware/types";
import type { RouteMiddlewareComposer } from "../options";
import { resolveAuthorizeMeta } from "./metadata";

/**
 * Built-in composer for `@Authorize`. The HTTP server puts it first among
 * the per-route composers. For routes that require authorization it returns
 * middleware that runs all checks in order: any that returns `false` → `403`;
 * a check may throw an `HttpError` itself (for example
 * `UnauthorizedError` → `401`).
 */
export function createAuthorizeComposer(): RouteMiddlewareComposer {
  return (controllerClass, methodName) => {
    const meta = resolveAuthorizeMeta(controllerClass, methodName);
    if (meta.allowAnonymous || meta.authorize === undefined) {
      return [];
    }

    const { checks } = meta.authorize;
    const middleware: HttpMiddleware = async (ctx, next) => {
      for (const check of checks) {
        if (!(await check(ctx))) {
          throw new ForbiddenError();
        }
      }
      await next();
    };
    return [middleware];
  };
}
