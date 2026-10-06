import type { CachePolicyBase, OutputCachePolicyFields } from "./CachePolicy";

/** Redis-specific options for {@link OutputRedisCache}. */
export interface OutputRedisCachePolicyFields {
  /** Named connection of the distributed backend. Default `default`. */
  readonly connection?: string;
  /** Extra key prefix for this route (after connection prefix). */
  readonly keyPrefix?: string;
  /** Override connection lock TTL for anti-stampede across pods. */
  readonly lockSeconds?: number;
}

/** Options for {@link OutputRedisCache} decorator. */
export type OutputRedisCacheOptions = CachePolicyBase &
  OutputCachePolicyFields &
  OutputRedisCachePolicyFields & {
    readonly policy?: string;
  };

export type ResolvedOutputRedisCacheOptions = OutputRedisCacheOptions & {
  readonly seconds: number;
  readonly connection: string;
  /** Lock TTL override; when absent the store's default is used. */
  readonly lockSeconds?: number;
};
