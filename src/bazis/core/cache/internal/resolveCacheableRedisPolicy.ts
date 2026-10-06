import { DEFAULT_CACHE_CONNECTION } from "../distributed/IDistributedCache";
import type { CachePolicyRegistry } from "../types/CachePolicy";
import type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
import { resolveCacheOptions } from "./resolveCachePolicy";

/**
 * Merges inline `@CacheableRedis` options with the named policy and fills in the
 * default `connection`. `seconds` is NOT required here: the caller validates it
 * after checking `enabled`/`noStore`, so a disabled cache without a TTL does not fail.
 */
export function resolveCacheableRedisOptions(
  inline: CacheableRedisOptions,
  policies: CachePolicyRegistry,
): CacheableRedisOptions & { readonly connection: string } {
  const resolved = resolveCacheOptions(inline, policies) as CacheableRedisOptions;
  return { ...resolved, connection: resolved.connection ?? DEFAULT_CACHE_CONNECTION };
}
