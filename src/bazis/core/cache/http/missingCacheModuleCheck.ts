import { singletonFactoryWithResolver, type InjectionToken, type ProviderDefinition } from "../../di";
import { ROUTE_MIDDLEWARE_COMPOSER, type RouteMiddlewareComposerRegistration } from "../../http";
import { LOGGER } from "../../kernel";
import { outputCacheMetaOf, resolveOutputCacheRequirement } from "../decorators/outputCacheMetadata";
import { outputRedisCacheMetaOf, resolveOutputRedisCacheRequirement } from "../decorators/outputRedisCacheMetadata";
import { ICache } from "../ICache";
import { DISTRIBUTED_OUTPUT_CACHE } from "../tokens/DISTRIBUTED_CACHE";
import type { CachedHttpPayload } from "./CachedHttpPayload";
import { createRouteOutputCacheComposerWithOptions } from "./composeOutputCache";

/** After the authorization checks, like the output cache of the cache module. */
const OUTPUT_CACHE_COMPOSER_ORDER = 100;

/**
 * A route composer the application composition installs next to the HTTP
 * server for applications without a cache module (`cache: memory()`):
 *
 * - `@OutputRedisCache` needs only the distributed backend of `@Infra`, so
 *   the routes are served from Redis; without a backend the start fails and
 *   names the route;
 * - `@OutputCache` needs the in-memory store: the start warns that the
 *   decorator has no effect.
 */
export function missingCacheModuleCheck(): ProviderDefinition {
  return singletonFactoryWithResolver(ROUTE_MIDDLEWARE_COMPOSER, [], (resolver): RouteMiddlewareComposerRegistration => {
    const cacheInstalled = resolver.tryResolve(ICache) !== undefined;
    const logger = resolver.tryResolve(LOGGER);
    const redis = createRouteOutputCacheComposerWithOptions({
      policies: {},
      globalEnabled: true,
      cacheToken: ICache as InjectionToken<ICache<CachedHttpPayload>>,
      securityWarnings: { behavior: "throw" },
      distributedEnabled: resolver.has(DISTRIBUTED_OUTPUT_CACHE),
    });
    return {
      order: OUTPUT_CACHE_COMPOSER_ORDER,
      compose: (controllerClass, methodName, meta, action) => {
        if (cacheInstalled) return [];
        if (resolveOutputRedisCacheRequirement(outputRedisCacheMetaOf(controllerClass), methodName) !== undefined) {
          return redis(controllerClass, methodName, meta, action);
        }
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
