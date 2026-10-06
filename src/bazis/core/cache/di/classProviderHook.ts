import type { Class, ClassProviderHook, Token } from "../../di";
import { cacheableMetaOf, hasCacheableMethods } from "../decorators/cacheableMetadata";
import { cacheableRedisMetaOf, hasCacheableRedisMethods } from "../decorators/cacheableRedisMetadata";
import { cachedScoped, cachedSingleton } from "../providers/cachedProviders";

/**
 * Pure build extension contributed by the cache module to its own container.
 * DI retains construction, lifetime, dependency validation and resource ownership.
 */
export const cacheableClassProviderHook: ClassProviderHook = ({ lifetime, provide, useClass, deps }) => {
  const hasCache =
    hasCacheableMethods(cacheableMetaOf(useClass))
    || hasCacheableRedisMethods(cacheableRedisMetaOf(useClass));
  if (!hasCache) {
    return undefined;
  }
  const token = provide as Token<object>;
  const impl = useClass as Class<object>;
  if (lifetime === "scoped") {
    return cachedScoped(token, impl, deps);
  }
  if (lifetime === "singleton") {
    return cachedSingleton(token, impl, deps);
  }
  return undefined;
};
