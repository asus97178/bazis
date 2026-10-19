import { JwtError } from "../../../library/jwt/errors";
import { ForbiddenError, UnauthorizedError } from "../Errors/HttpError";
import type { HttpMiddleware } from "../Middleware/types";
import type { RouteMiddlewareComposer } from "../options";
import { routeAuthorizeChecks, type AuthorizeCheck } from "./metadata";

/**
 * Built-in composer for `@Authorize`. The HTTP server puts it first among
 * the per-route composers. For routes that require authorization it returns
 * middleware that runs all checks in order: any that returns `false` → `403`;
 * a check may throw an `HttpError` itself (for example
 * `UnauthorizedError` → `401`). A `JwtError` (missing, malformed, expired or
 * forged token) escaping a check is a 401 as well, not a server error.
 */
export function createAuthorizeComposer(defaults: readonly AuthorizeCheck[] = []): RouteMiddlewareComposer {
  return (controllerClass, methodName) => {
    const checks = routeAuthorizeChecks(controllerClass, methodName, defaults);
    if (checks === undefined) {
      return [];
    }

    const middleware: HttpMiddleware = async (ctx, next) => {
      for (const check of checks) {
        let allowed: boolean;
        try {
          allowed = await check(ctx);
        } catch (error) {
          if (error instanceof JwtError) {
            const unauthorized = new UnauthorizedError();
            Object.defineProperty(unauthorized, "cause", { value: error, configurable: true, writable: true });
            throw unauthorized;
          }
          throw error;
        }
        if (!allowed) {
          throw new ForbiddenError();
        }
      }
      await next();
    };
    return [middleware];
  };
}
