import { DEFAULT_CACHE_CONNECTION } from "../distributed/IDistributedCache";
import type { CachePolicyRegistry } from "../types/CachePolicy";
import type { OutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
import { resolveCacheOptions } from "./resolveCachePolicy";

/**
 * Merges inline `@OutputRedisCache` options with the named policy and fills in the
 * default `connection`. The caller validates `seconds` after checking
 * `enabled`/`noStore` (a disabled cache without a TTL must not fail at startup).
 */
export function resolveOutputRedisCacheOptions(
  inline: OutputRedisCacheOptions,
  policies: CachePolicyRegistry,
): OutputRedisCacheOptions & { readonly connection: string } {
  const resolved = resolveCacheOptions(inline, policies) as OutputRedisCacheOptions;
  return { ...resolved, connection: resolved.connection ?? DEFAULT_CACHE_CONNECTION };
}
