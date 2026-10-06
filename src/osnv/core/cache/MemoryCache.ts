import type { Options } from "../di";
import { CacheCapacityError, CacheValueError } from "./errors/CacheError";
import { assertCacheKey, measureValueBytes } from "./internal/CacheKeyGuard";
import type { CacheFactory, ICache } from "./ICache";
import type { CacheEntry } from "./types/CacheEntry";
import type { CacheOptions, CacheSetOptions } from "./types/CacheOptions";
import { DEFAULT_MAX_IN_FLIGHT, DEFAULT_MAX_KEY_LENGTH, validateCacheOptions } from "./types/CacheOptions";

interface StoredEntry<TValue> {
  readonly value: TValue;
  readonly expiresAt?: number;
  readonly tags?: readonly string[];
}

interface InFlightEntry<TValue> {
  readonly promise: Promise<TValue | undefined>;
  readonly tags: readonly string[];
}

interface FactorySnapshot {
  readonly clear: number;
  readonly key: number;
  readonly tags: ReadonlyMap<string, number>;
}

/**
 * In-memory implementation of {@link ICache}.
 *
 * - O(1) get/set/remove through a `Map`;
 * - LRU through Map insertion order (moved on read);
 * - lazy TTL on get/list/size;
 * - in-flight dedup in {@link getOrCreateAsync};
 * - `dispose()` clears the cache on DI shutdown.
 */
export class MemoryCache<TValue = unknown> implements ICache<TValue> {
  private readonly store = new Map<string, StoredEntry<TValue>>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, InFlightEntry<TValue>>();
  private readonly keyEpochs = new Map<string, number>();
  private readonly tagEpochs = new Map<string, number>();
  private readonly keySnapshotRefs = new Map<string, number>();
  private readonly tagSnapshotRefs = new Map<string, number>();
  private readonly maxEntries?: number;
  private readonly maxInFlight: number;
  // Invalidating a key detaches deduplication, but cannot cancel its factory.
  private activeFactories = 0;
  private readonly defaultTtlMs?: number;
  private readonly maxKeyLength: number;
  private readonly maxValueBytes?: number;
  private clearEpoch = 0;
  private disposed = false;

  public constructor(options: Options<CacheOptions> | CacheOptions = {}) {
    const value = "value" in options ? options.value : options;
    const issues = validateCacheOptions(value);
    if (issues.length > 0) {
      throw new CacheValueError(`Invalid memory cache options: ${issues.join("; ")}`);
    }
    this.maxEntries = value.maxEntries;
    this.maxInFlight = value.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.defaultTtlMs = value.defaultTtlSeconds !== undefined ? value.defaultTtlSeconds * 1000 : undefined;
    this.maxKeyLength = value.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
    this.maxValueBytes = value.maxValueBytes;
  }

  public get size(): number {
    this.purgeExpired();
    return this.store.size;
  }

  public get(key: string): TValue | undefined {
    assertCacheKey(key, this.maxKeyLength);
    if (this.disposed) {
      return undefined;
    }
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.removeStored(key);
      return undefined;
    }
    this.touch(key, entry);
    return entry.value;
  }

  public list(): readonly CacheEntry<TValue>[] {
    this.purgeExpired();
    const snapshot: CacheEntry<TValue>[] = [];
    for (const [key, entry] of this.store) {
      snapshot.push({
        key,
        value: entry.value,
        expiresAt: entry.expiresAt,
      });
    }
    return snapshot;
  }

  public getOrCreate(
    key: string,
    factory: CacheFactory<TValue>,
    options?: CacheSetOptions,
  ): TValue | Promise<TValue | undefined> | undefined {
    const normalizedOptions = this.normalizeSetOptions(options);
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit;
    }

    const inflight = this.inFlight.get(key);
    if (inflight !== undefined) {
      return inflight.promise;
    }

    if (this.activeFactories >= this.maxInFlight) {
      throw new CacheCapacityError(`Memory cache reached maxInFlight=${this.maxInFlight}`);
    }
    this.activeFactories += 1;
    const snapshot = this.factorySnapshot(key, normalizedOptions?.tags);
    let result: ReturnType<CacheFactory<TValue>>;
    try {
      result = factory();
    } catch (error) {
      this.activeFactories -= 1;
      this.releaseSnapshot(key, snapshot);
      throw error;
    }
    if (result instanceof Promise) {
      const pending = result
        .then((value) => {
          if (value !== undefined && !this.disposed && this.snapshotIsCurrent(key, snapshot)) {
            this.trySetFromFactory(key, value, normalizedOptions);
          }
          return value;
        })
        .finally(() => {
          this.activeFactories -= 1;
          this.releaseSnapshot(key, snapshot);
          if (this.inFlight.get(key)?.promise === pending) {
            this.inFlight.delete(key);
          }
        });
      this.inFlight.set(key, { promise: pending, tags: normalizedOptions?.tags ?? Object.freeze([]) });
      return pending;
    }

    if (result !== undefined && !this.disposed && this.snapshotIsCurrent(key, snapshot)) {
      this.trySetFromFactory(key, result, normalizedOptions);
    }
    this.releaseSnapshot(key, snapshot);
    this.activeFactories -= 1;
    return result;
  }

  public getOrCreateAsync(
    key: string,
    factory: () => Promise<TValue | undefined>,
    options?: CacheSetOptions,
  ): Promise<TValue | undefined> {
    const resolved = this.getOrCreate(key, () => factory(), options);
    return Promise.resolve(resolved);
  }

  public set(key: string, value: TValue, options?: CacheSetOptions): void {
    assertCacheKey(key, this.maxKeyLength);
    const normalizedOptions = this.normalizeSetOptions(options);
    if (this.disposed) {
      return;
    }
    this.assertValueSize(value);
    this.bumpKey(key);
    this.setStored(key, value, normalizedOptions);
  }

  private setStored(key: string, value: TValue, options?: CacheSetOptions): void {
    const ttlMs = this.resolveTtlMs(options);
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
    const tags = options?.tags;
    const next: StoredEntry<TValue> = { value, expiresAt, tags };

    if (this.store.has(key)) {
      this.unindexKey(key, this.store.get(key)?.tags);
      this.store.delete(key);
    } else if (this.maxEntries !== undefined && this.store.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.store.set(key, next);
    this.indexTags(key, tags);
  }

  public remove(key: string): boolean {
    assertCacheKey(key, this.maxKeyLength);
    this.bumpKey(key);
    this.inFlight.delete(key);
    return this.removeStored(key);
  }

  private removeStored(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return false;
    }
    this.unindexKey(key, entry.tags);
    return this.store.delete(key);
  }

  public clear(): void {
    this.clearEpoch += 1;
    this.store.clear();
    this.tagIndex.clear();
    this.inFlight.clear();
  }

  public evictByTag(tag: string): number {
    assertCacheKey(tag, this.maxKeyLength);
    this.bumpTag(tag);
    // A factory can carry the evicted dependency before its value has been
    // indexed by tag. Only cancel matching work; unrelated fills remain valid.
    for (const [key, entry] of this.inFlight) {
      if (entry.tags.includes(tag)) this.inFlight.delete(key);
    }
    const keys = this.tagIndex.get(tag);
    if (keys === undefined || keys.size === 0) {
      return 0;
    }
    let removed = 0;
    for (const key of [...keys]) {
      if (this.removeStored(key)) {
        removed += 1;
      }
    }
    return removed;
  }

  /** Frees memory when the container is disposed. */
  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private trySetFromFactory(key: string, value: TValue, options?: CacheSetOptions): void {
    try {
      assertCacheKey(key, this.maxKeyLength);
      this.assertValueSize(value);
      this.setStored(key, value, options);
    } catch {
      // Graceful degradation: factory result is still returned to the caller.
    }
  }

  private resolveTtlMs(options?: CacheSetOptions): number | undefined {
    if (options?.ttlSeconds !== undefined) {
      if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
        throw new CacheValueError("ttlSeconds must be a positive number");
      }
      return options.ttlSeconds * 1000;
    }
    return this.defaultTtlMs;
  }

  private normalizeSetOptions(options: CacheSetOptions | undefined): CacheSetOptions | undefined {
    if (options === undefined) return undefined;
    if (options?.ttlSeconds !== undefined && (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0)) {
      throw new CacheValueError("ttlSeconds must be a positive number");
    }
    for (const tag of options?.tags ?? []) {
      assertCacheKey(tag, this.maxKeyLength);
    }
    return Object.freeze({
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.tags !== undefined ? { tags: Object.freeze([...options.tags]) } : {}),
    });
  }

  private factorySnapshot(key: string, tags: readonly string[] | undefined): FactorySnapshot {
    this.keySnapshotRefs.set(key, (this.keySnapshotRefs.get(key) ?? 0) + 1);
    const tagVersions = new Map<string, number>();
    for (const tag of new Set(tags ?? [])) {
      this.tagSnapshotRefs.set(tag, (this.tagSnapshotRefs.get(tag) ?? 0) + 1);
      tagVersions.set(tag, this.tagEpochs.get(tag) ?? 0);
    }
    return {
      clear: this.clearEpoch,
      key: this.keyEpochs.get(key) ?? 0,
      tags: tagVersions,
    };
  }

  private snapshotIsCurrent(key: string, snapshot: FactorySnapshot): boolean {
    if (snapshot.clear !== this.clearEpoch || snapshot.key !== (this.keyEpochs.get(key) ?? 0)) return false;
    for (const [tag, epoch] of snapshot.tags) {
      if ((this.tagEpochs.get(tag) ?? 0) !== epoch) return false;
    }
    return true;
  }

  private bumpKey(key: string): void {
    if (this.keySnapshotRefs.has(key)) {
      this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
    }
  }

  private bumpTag(tag: string): void {
    if (this.tagSnapshotRefs.has(tag)) {
      this.tagEpochs.set(tag, (this.tagEpochs.get(tag) ?? 0) + 1);
    }
  }

  private releaseSnapshot(key: string, snapshot: FactorySnapshot): void {
    this.releaseSnapshotRef(key, this.keySnapshotRefs, this.keyEpochs);
    for (const tag of snapshot.tags.keys()) {
      this.releaseSnapshotRef(tag, this.tagSnapshotRefs, this.tagEpochs);
    }
  }

  private releaseSnapshotRef(
    name: string,
    refs: Map<string, number>,
    epochs: Map<string, number>,
  ): void {
    const next = (refs.get(name) ?? 1) - 1;
    if (next <= 0) {
      refs.delete(name);
      epochs.delete(name);
    } else {
      refs.set(name, next);
    }
  }

  private assertValueSize(value: TValue): void {
    if (this.maxValueBytes === undefined) {
      return;
    }
    const bytes = measureValueBytes(value);
    if (bytes !== undefined && bytes > this.maxValueBytes) {
      throw new CacheValueError(`Cache value exceeds max size of ${this.maxValueBytes} bytes`);
    }
  }

  private isExpired(entry: StoredEntry<TValue>): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private touch(key: string, entry: StoredEntry<TValue>): void {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private evictOldest(): void {
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) {
      this.removeStored(oldest);
    }
  }

  private indexTags(key: string, tags: readonly string[] | undefined): void {
    if (tags === undefined || tags.length === 0) {
      return;
    }
    for (const tag of tags) {
      let keys = this.tagIndex.get(tag);
      if (keys === undefined) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  private unindexKey(key: string, tags: readonly string[] | undefined): void {
    if (tags === undefined || tags.length === 0) {
      return;
    }
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.remove(key);
      }
    }
  }
}
