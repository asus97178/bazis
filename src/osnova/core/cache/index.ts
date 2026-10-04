/**
 * Osnova cache: in-memory {@link ICache}, HTTP output cache, and service method
 * cache. Use it as a self-installing value: `memory({ ... })`. For multi-instance
 * caching add `redisConnect(redisConfig, { cache: "distributed" })` to your `@Infra` manifest — the
 * distributed backend is then discovered from DI by `@CacheableRedis` / `@OutputRedisCache`.
 */
export { ICache, cacheToken } from "./ICache";
export type { CacheFactory } from "./ICache";
export type { CacheEntry } from "./types/CacheEntry";
export {
  CACHE_OPTIONS,
  DEFAULT_MAX_KEY_LENGTH,
  DEFAULT_MAX_IN_FLIGHT,
  validateCacheOptions,
  type CacheOptions,
  type CacheSetOptions,
} from "./types/CacheOptions";
export type {
  CachePolicy,
  CachePolicyRegistry,
  CacheableOptions,
  CacheablePolicyFields,
  ClientCacheOptions,
  OutputCacheOptions,
  OutputCachePolicyFields,
} from "./types/CachePolicy";
export type {
  OutputRedisCacheOptions,
  ResolvedOutputRedisCacheOptions,
} from "./types/OutputRedisCacheOptions";
export type {
  CacheableRedisOptions,
  ResolvedCacheableRedisOptions,
} from "./types/CacheableRedisOptions";
export { CACHE_POLICIES } from "./tokens/CACHE_POLICIES";
export { MemoryCache } from "./MemoryCache";

// Distributed cache abstraction (backends live in @/core/infra/*).
export {
  DEFAULT_CACHE_CONNECTION,
  DistributedCache,
  NamedCacheRegistry,
  jsonCacheCodec,
  httpPayloadCacheCodec,
  type CacheCodec,
  type DistributedCacheStores,
  type DistributedCacheConfig,
  type DistributedCacheDriver,
  type DistributedCacheFencedWrite,
  type DistributedCacheTagWrite,
  type DistributedCacheVersionCheck,
  type DistributedCachePing,
  type DistributedCacheSetOptions,
  type IDistributedCache,
} from "./distributed";
export {
  DISTRIBUTED_CACHE_BACKEND,
  DISTRIBUTED_OUTPUT_CACHE,
  DISTRIBUTED_SERVICE_CACHE,
} from "./tokens/DISTRIBUTED_CACHE";

export { memory } from "./cacheModule";
/** @internal Advanced builder used by the hosting layer. */
export {
  buildCacheModule,
  type CacheModuleConfig,
  type CacheOutputCacheOptions,
} from "./internal/buildCacheProviders";
export { CacheError, CacheKeyError, CacheValueError, CacheCapacityError } from "./errors/CacheError";

export { OutputCache, type OutputCacheOptions as OutputCacheDecoratorOptions } from "./decorators/OutputCache";
export {
  OutputRedisCache,
  type OutputRedisCacheOptions as OutputRedisCacheDecoratorOptions,
} from "./decorators/OutputRedisCache";
export { Cacheable, type CacheableOptions as CacheableDecoratorOptions } from "./decorators/Cacheable";
export {
  CacheableRedis,
  type CacheableRedisOptions as CacheableRedisDecoratorOptions,
} from "./decorators/CacheableRedis";

export { createRouteOutputCacheComposer, type RouteOutputCacheComposer } from "./http/composeOutputCache";
export {
  guardInsecureOutputCacheRoute,
  warnInsecureOutputCacheRoute,
  type OutputCacheSecurityWarningOptions,
} from "./http/outputCacheSecurityWarning";
export type { CachedHttpPayload } from "./http/CachedHttpPayload";
export {
  DEFAULT_OUTPUT_CACHE_METHODS,
  DEFAULT_OUTPUT_CACHE_STATUS_CODES,
} from "./internal/resolveCachePolicy";
export { buildOutputCacheKey, OUTPUT_CACHE_PRINCIPAL_STATE_KEY } from "./http/buildOutputCacheKey";
export { wrapCachedService, type CacheProxyOptions } from "./services/cacheProxy";
export {
  cachedSingleton,
  cachedScoped,
  autoCachedSingleton,
  autoCachedScoped,
} from "./providers/cachedProviders";
