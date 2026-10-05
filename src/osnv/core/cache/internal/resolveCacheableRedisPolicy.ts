import { DEFAULT_CACHE_CONNECTION } from "../distributed/IDistributedCache";
import type { CachePolicyRegistry } from "../types/CachePolicy";
import type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
import { resolveCacheOptions } from "./resolveCachePolicy";

/**
 * Сливает inline-опции `@CacheableRedis` с именованной политикой и подставляет
 * `connection` по умолчанию. `seconds` здесь НЕ требуется — её валидирует вызывающий
 * уже после проверки `enabled`/`noStore`, чтобы выключенный кэш без TTL не падал.
 */
export function resolveCacheableRedisOptions(
  inline: CacheableRedisOptions,
  policies: CachePolicyRegistry,
): CacheableRedisOptions & { readonly connection: string } {
  const resolved = resolveCacheOptions(inline, policies) as CacheableRedisOptions;
  return { ...resolved, connection: resolved.connection ?? DEFAULT_CACHE_CONNECTION };
}
