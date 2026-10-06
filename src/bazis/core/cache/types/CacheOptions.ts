import { createOptionsToken } from "../../di";

/** In-memory cache options. */
export interface CacheOptions {
  /** Maximum number of entries; the LRU entry is evicted when full. */
  readonly maxEntries?: number;
  /** Maximum number of factories running at once; 1024 by default.
   * When full, a new cache miss gets CacheCapacityError before the factory starts.
   */
  readonly maxInFlight?: number;
  /** Default TTL for {@link ICache.set} (seconds). */
  readonly defaultTtlSeconds?: number;
  /** Maximum key length (characters). 256 by default. */
  readonly maxKeyLength?: number;
  /** Size limit of a string value (UTF-8 bytes). Unset means no limit. */
  readonly maxValueBytes?: number;
}

/** Per-entry write options. */
export interface CacheSetOptions {
  /** TTL of this entry (seconds); overrides the default from {@link CacheOptions}. */
  readonly ttlSeconds?: number;
  /** Tags for group invalidation via {@link ICache.evictByTag}. */
  readonly tags?: readonly string[];
}

export const DEFAULT_MAX_KEY_LENGTH = 256;
export const DEFAULT_MAX_IN_FLIGHT = 1024;

/** DI token of the validated cache options. */
export const CACHE_OPTIONS = createOptionsToken<CacheOptions>("Cache");

export function validateCacheOptions(options: CacheOptions): readonly string[] {
  const issues: string[] = [];
  if (options.maxInFlight !== undefined && (!Number.isSafeInteger(options.maxInFlight) || options.maxInFlight < 1)) {
    issues.push("maxInFlight must be a positive safe integer");
  }
  if (options.maxEntries !== undefined && (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)) {
    issues.push("maxEntries must be a positive integer");
  }
  if (
    options.defaultTtlSeconds !== undefined
    && (!Number.isFinite(options.defaultTtlSeconds) || options.defaultTtlSeconds <= 0)
  ) {
    issues.push("defaultTtlSeconds must be a positive number");
  }
  if (
    options.maxKeyLength !== undefined
    && (!Number.isInteger(options.maxKeyLength) || options.maxKeyLength < 1)
  ) {
    issues.push("maxKeyLength must be a positive integer");
  }
  if (
    options.maxValueBytes !== undefined
    && (!Number.isInteger(options.maxValueBytes) || options.maxValueBytes < 1)
  ) {
    issues.push("maxValueBytes must be a positive integer");
  }
  return issues;
}
