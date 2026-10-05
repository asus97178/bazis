import { DEFAULT_CACHE_CONNECTION } from "../distributed/IDistributedCache";
import type { CachePolicyRegistry } from "../types/CachePolicy";
import type { OutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
import { resolveCacheOptions } from "./resolveCachePolicy";

/**
 * Сливает inline-опции `@OutputRedisCache` с именованной политикой и подставляет
 * `connection` по умолчанию. `seconds` валидирует вызывающий уже после проверки
 * `enabled`/`noStore` (выключенный кэш без TTL не должен падать на старте).
 */
export function resolveOutputRedisCacheOptions(
  inline: OutputRedisCacheOptions,
  policies: CachePolicyRegistry,
): OutputRedisCacheOptions & { readonly connection: string } {
  const resolved = resolveCacheOptions(inline, policies) as OutputRedisCacheOptions;
  return { ...resolved, connection: resolved.connection ?? DEFAULT_CACHE_CONNECTION };
}
