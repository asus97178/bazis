import { createToken, type InjectionToken } from "../di";
import type { CacheEntry } from "./types/CacheEntry";
import type { CacheSetOptions } from "./types/CacheOptions";

/** Factory for {@link ICache.getOrCreate} / {@link ICache.getOrCreateAsync}. */
export type CacheFactory<TValue> = () => TValue | Promise<TValue | undefined> | undefined;

/**
 * Key-value cache contract.
 *
 * Implementations must:
 * - validate keys (a non-empty string, no `__proto__` and the like);
 * - return a cache miss when there is no value; never hide input or factory errors;
 * - treat expired entries as absent when a TTL is set.
 */
export interface ICache<TValue = unknown> {
  /** Reads one entry; `undefined` if missing or its TTL expired. */
  get(key: string): TValue | undefined;

  /** Snapshot of all current entries (expired ones excluded). */
  list(): readonly CacheEntry<TValue>[];

  /** Writes a value; evicts the LRU entry when full. */
  set(key: string, value: TValue, options?: CacheSetOptions): void;

  /**
   * Returns the cached value or creates it through `factory`.
   * `undefined` from the factory is not stored.
   * MemoryCache throws CacheCapacityError before starting a new factory once
   * maxInFlight is reached; cache hits and joining running work are allowed.
   */
  getOrCreate(
    key: string,
    factory: CacheFactory<TValue>,
    options?: CacheSetOptions,
  ): TValue | Promise<TValue | undefined> | undefined;

  /**
   * Async version with per-key in-flight request dedup (anti-stampede).
   * `undefined` from the factory is not stored.
   * Input and admission checks may throw synchronously before a Promise is returned.
   */
  getOrCreateAsync(
    key: string,
    factory: () => Promise<TValue | undefined>,
    options?: CacheSetOptions,
  ): Promise<TValue | undefined>;

  /** Removes one entry; `true` if the entry existed. */
  remove(key: string): boolean;

  /** Removes all entries. */
  clear(): void;

  /**
   * Removes all entries with the given tag.
   * @returns the number of removed entries.
   */
  evictByTag(tag: string): number;

  /** Number of current entries (after lazy TTL cleanup). */
  readonly size: number;
}

/** Default cache DI token. */
export const ICache = createToken<ICache>("ICache") as InjectionToken<ICache<unknown>>;

/** Typed token for a specific value type. */
export function cacheToken<TValue>(name: string): InjectionToken<ICache<TValue>> {
  return createToken<ICache<TValue>>(`ICache<${name}>`);
}
