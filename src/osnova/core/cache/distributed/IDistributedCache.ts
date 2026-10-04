import type { CacheSetOptions } from "../types/CacheOptions";

/** Default named connection used when a decorator omits `connection`. */
export const DEFAULT_CACHE_CONNECTION = "default";

/** Per-entry options for distributed stores (adds distributed lock TTL). */
export interface DistributedCacheSetOptions extends CacheSetOptions {
  /** TTL of the anti-stampede lock acquired on a miss. */
  readonly lockSeconds?: number;
}

/**
 * Backend-agnostic distributed cache contract (analogous to .NET `IDistributedCache`).
 *
 * The framework depends only on this interface; concrete backends (Redis, …) live in
 * `@/core/infra/*` and are plugged in via {@link DistributedCacheStores}.
 */
export interface IDistributedCache<TValue = unknown> {
  readonly connectionName: string;
  readonly keyPrefix: string;

  /** Reads a value; `undefined` when absent or unreadable. */
  get<T = TValue>(key: string): Promise<T | undefined>;

  /**
   * Returns a cached value or produces it via `factory` with cross-process
   * anti-stampede (distributed lock + in-process dedup). `undefined` is not stored.
   */
  getOrCreateAsync<T = TValue>(
    key: string,
    factory: () => Promise<T | undefined>,
    options: DistributedCacheSetOptions,
  ): Promise<T | undefined>;

  /** Removes one entry; `true` when it existed. */
  remove(key: string): Promise<boolean>;

  /** Removes all entries carrying `tag`; returns the number removed. */
  evictByTag(tag: string): Promise<number>;
}
