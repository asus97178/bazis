import type { CachePolicyBase, CacheablePolicyFields } from "./CachePolicy";

/** Redis-specific options for {@link CacheableRedis}. */
export interface CacheableRedisPolicyFields {
  /** Named connection of the distributed backend. Default `default`. */
  readonly connection?: string;
  /** Override distributed lock TTL for anti-stampede across pods. */
  readonly lockSeconds?: number;
}

/** Options for {@link CacheableRedis} decorator. */
export type CacheableRedisOptions = CachePolicyBase &
  CacheablePolicyFields &
  CacheableRedisPolicyFields & {
    readonly policy?: string;
  };

export type ResolvedCacheableRedisOptions = CacheableRedisOptions & {
  readonly seconds: number;
  readonly connection: string;
  /** Lock TTL override; when absent the store's default is used. */
  readonly lockSeconds?: number;
};
