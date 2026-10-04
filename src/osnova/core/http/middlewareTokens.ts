import { createToken } from "../di";
import type { HttpContext } from "./HttpContext/HttpContext";
import type { HttpMiddleware } from "./Middleware/types";
import type { RouteMiddlewareComposer } from "./options";

/**
 * Server-wide middleware contributed through DI (self-wiring): a module just
 * registers a {@link SERVER_MIDDLEWARE} provider and `httpModule` collects all
 * of them via `resolveAll` — no return values threaded by hand.
 */
export interface ServerMiddlewareRegistration {
  /** Lower runs more outer/earlier (default 0). */
  readonly order?: number;
  readonly middleware: HttpMiddleware;
}

/** Per-route middleware composer contributed through DI (self-wiring). */
export interface RouteMiddlewareComposerRegistration {
  /** Lower runs first (default 0). */
  readonly order?: number;
  readonly compose: RouteMiddlewareComposer;
}

/** Enumerable token: register any number of server middleware contributions. */
export const SERVER_MIDDLEWARE = createToken<ServerMiddlewareRegistration>("OsnovaServerMiddleware");

/** Enumerable token: register any number of route middleware composers. */
export const ROUTE_MIDDLEWARE_COMPOSER = createToken<RouteMiddlewareComposerRegistration>(
  "OsnovaRouteMiddlewareComposer",
);

/**
 * Hook invoked by the built-in error boundary on a non-{@link HttpError}
 * failure. Self-wiring: e.g. the logging module registers one to record the
 * error, keeping `@/core/http` free of logging imports. Collected via `resolveAll`.
 */
export type HttpErrorHook = (ctx: HttpContext, error: unknown) => void;

/** Enumerable token: register any number of unexpected-error hooks. */
export const HTTP_ERROR_HOOK = createToken<HttpErrorHook>("OsnovaHttpErrorHook");

/** Stable order by `order ?? 0` (registration order preserved within a tier). */
export function sortByOrder<T extends { readonly order?: number }>(items: readonly T[]): T[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
    .map(({ item }) => item);
}
