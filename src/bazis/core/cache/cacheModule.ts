import type { BazisModuleRef } from "../di";
import { buildCacheModule } from "./internal/buildCacheProviders";
import type { CacheOptions } from "./types/CacheOptions";

/**
 * In-memory cache as a one-line value. Inject {@link ICache} anywhere; decorate
 * methods with `@Cacheable` or routes with `@OutputCache`.
 *
 * ```ts
 * createApp({ cache: memory({ maxEntries: 1000 }) });
 * // or, inside a module: imports: [memory()]
 * ```
 *
 * Options are just the in-memory knobs (`maxEntries`, `defaultTtlSeconds`, …).
 * For multi-instance caching keep `memory()` and add a distributed backend in your
 * `@Infra` manifest via `redisConnect(redisConfig, { cache: "distributed" })`; `@CacheableRedis` /
 * `@OutputRedisCache` then pick the backend up from DI automatically.
 */
export function memory(options: CacheOptions = {}): BazisModuleRef {
  return buildCacheModule(options);
}
