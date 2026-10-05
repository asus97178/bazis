import { ForbiddenError } from "../Errors/HttpError";
import type { HttpMiddleware } from "../Middleware/types";
import type { RouteMiddlewareComposer } from "../options";
import { resolveAuthorizeMeta } from "./metadata";

/**
 * Встроенный composer для `@Authorize`. HTTP-сервер ставит его первым звеном
 * среди per-route composer'ов. Для маршрутов с требованием авторизации
 * возвращает middleware, который последовательно прогоняет все проверки:
 * любая вернувшая `false` → `403`; проверка может сама бросить `HttpError`
 * (например `UnauthorizedError` → `401`).
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
