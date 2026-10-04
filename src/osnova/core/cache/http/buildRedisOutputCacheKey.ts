import type { HttpContext } from "../../http";
import { buildOutputCacheKey } from "./buildOutputCacheKey";
import type { ResolvedOutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";

/** Builds Redis storage key (connection prefix applied separately in {@link RedisOutputCache}). */
export function buildRedisOutputCacheKey(
  ctx: HttpContext,
  routeName: string,
  options: ResolvedOutputRedisCacheOptions,
): string {
  const base = buildOutputCacheKey(ctx, routeName, options);
  if (options.keyPrefix === undefined || options.keyPrefix.length === 0) {
    return base;
  }
  return `${options.keyPrefix}${base}`;
}
