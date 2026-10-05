/** One cache entry returned by {@link ICache.list}. */
export interface CacheEntry<TValue> {
  readonly key: string;
  readonly value: TValue;
  /** Expiry Unix timestamp (ms); absent means the entry never expires. */
  readonly expiresAt?: number;
}
