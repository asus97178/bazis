import {
  DI,
  type Class,
  type ProviderDefinition,
  type ProviderDependencyList,
  type ServiceResolver,
  type Token,
} from "../../di";
import { randomUUID } from "node:crypto";
import { ICache } from "../ICache";
import { CACHE_POLICIES } from "../tokens/CACHE_POLICIES";
import { DISTRIBUTED_SERVICE_CACHE } from "../tokens/DISTRIBUTED_CACHE";
import { wrapCachedService } from "../services/cacheProxy";
import type { CachePolicyRegistry } from "../types/CachePolicy";

type CachedLifetime = "singleton" | "scoped";

function cachedProvider<T extends object>(
  lifetime: CachedLifetime,
  provide: Token<T>,
  useClass: Class<T>,
  deps?: ProviderDependencyList,
): ProviderDefinition<T> {
  // Retain a class provider: DI owns constructor binding, arity validation,
  // async dependencies and disposal. Cache only wraps the activated instance.
  const definition = {
    ...DI.classProvider(provide, useClass, deps),
    activation: {
      deps: [ICache, CACHE_POLICIES],
      wrap(instance: T, resolver: ServiceResolver, ...values: unknown[]): T {
        return wrapCachedService(instance, {
          memoryCache: values[0] as ICache,
          policies: values[1] as CachePolicyRegistry,
          serviceCache: resolver.tryResolve(DISTRIBUTED_SERVICE_CACHE),
          className: useClass.name,
          // Every DI instance has its own implicit keys, including distinct
          // singleton registrations of one class. Explicit keys opt into sharing.
          cacheNamespace: randomUUID(),
        });
      },
    },
  };
  return lifetime === "singleton" ? DI.singleton(definition) : DI.scoped(definition);
}

/**
 * Singleton provider that wraps the implementation in a caching proxy.
 *
 * Decorate the **implementation class** (`@Cacheable` / `@CacheableRedis`) and
 * register against the interface token. The distributed tier activates
 * automatically when `redisConnect(...)` is configured.
 */
export function cachedSingleton<T extends object>(
  provide: Token<T>,
  useClass: Class<T>,
  deps?: ProviderDependencyList,
): ProviderDefinition<T> {
  return cachedProvider("singleton", provide, useClass, deps);
}

/** Scoped caching provider (per-request DI scope). See {@link cachedSingleton}. */
export function cachedScoped<T extends object>(
  provide: Token<T>,
  useClass: Class<T>,
  deps?: ProviderDependencyList,
): ProviderDefinition<T> {
  return cachedProvider("scoped", provide, useClass, deps);
}
