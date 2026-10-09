import type { BazisModuleRef } from "../di";
import { buildCacheModule, type CacheOutputCacheOptions } from "./internal/buildCacheProviders";
import type { CacheOptions } from "./types/CacheOptions";
import type { CachePolicyRegistry } from "./types/CachePolicy";

/** Options of {@link memory}: the in-memory store plus named policies and output-cache settings. */
export interface MemoryCacheOptions extends CacheOptions {
  /** Named policies shared by `@OutputCache({ policy })` and `@Cacheable({ policy })`. */
  readonly policies?: CachePolicyRegistry;
  /** HTTP output cache settings: global switch and the check of authorized routes. */
  readonly outputCache?: CacheOutputCacheOptions;
}

/**
 * In-memory cache as a one-line value. Inject {@link ICache} anywhere; decorate
 * methods with `@Cacheable` or routes with `@OutputCache`.
 *
 * ```ts
 * await runApp(AppModule, {
 *   cache: memory({ maxEntries: 1000, policies: { catalog: { seconds: 60, tags: ["catalog"] } } }),
 *   http: { port: 3000 },
 * });
 * // or, inside a module: imports: [memory()]
 * ```
 *
 * For multi-instance caching keep `memory()` and add a distributed backend in your
 * `@Infra` manifest via `redisConnect(redisConfig, { cache: "distributed" })`; `@CacheableRedis` /
 * `@OutputRedisCache` then pick the backend up from DI automatically.
 */
export function memory(options: MemoryCacheOptions = {}): BazisModuleRef {
  return buildCacheModule(options);
}
