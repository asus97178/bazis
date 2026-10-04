import type { RouteMiddlewareComposer } from "./options";

/**
 * Chains multiple route middleware composers (e.g. JWT auth + output cache).
 *
 * ```ts
 * routeMiddlewareComposer: composeRouteMiddlewareComposers(
 *   authorizationComposer,
 *   otherComposer,
 * ),
 * ```
 *
 * Most modules instead self-wire via the `ROUTE_MIDDLEWARE_COMPOSER` DI token,
 * which `httpModule` collects automatically.
 */
export function composeRouteMiddlewareComposers(
  ...composers: readonly RouteMiddlewareComposer[]
): RouteMiddlewareComposer {
  return (controllerClass, methodName, httpMeta, action) =>
    composers.flatMap((composer) => composer(controllerClass, methodName, httpMeta, action));
}
