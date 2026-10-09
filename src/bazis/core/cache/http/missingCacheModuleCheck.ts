import { singletonFactoryWithResolver, type ProviderDefinition } from "../../di";
import { ROUTE_MIDDLEWARE_COMPOSER, type RouteMiddlewareComposerRegistration } from "../../http";
import { LOGGER } from "../../kernel";
import { outputCacheMetaOf, resolveOutputCacheRequirement } from "../decorators/outputCacheMetadata";
import { ICache } from "../ICache";

/**
 * A route composer the application composition installs next to the HTTP
 * server: it adds no middleware and only warns at startup about each
 * `@OutputCache` route when no cache module is installed — then the decorator
 * does nothing and every request runs the action.
 */
export function missingCacheModuleCheck(): ProviderDefinition {
  return singletonFactoryWithResolver(ROUTE_MIDDLEWARE_COMPOSER, [], (resolver): RouteMiddlewareComposerRegistration => {
    const cacheInstalled = resolver.tryResolve(ICache) !== undefined;
    const logger = resolver.tryResolve(LOGGER);
    return {
      order: 0,
      compose: (controllerClass, methodName) => {
        if (cacheInstalled) return [];
        const requirement = resolveOutputCacheRequirement(outputCacheMetaOf(controllerClass), methodName);
        if (requirement === undefined || requirement.enabled === false) return [];
        const message = `[cache] @OutputCache on ${controllerClass.name}.${String(methodName)} has no effect: `
          + "no cache module is installed, so every request runs the action. "
          + "Add `cache: memory()` to the runApp options.";
        if (logger) logger.warn(message);
        else console.warn(message);
        return [];
      },
    };
  });
}
