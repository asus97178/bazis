/** Version value captured before a cache factory starts. */
export interface DistributedCacheVersionCheck {
  readonly key: string;
  readonly expected: string | null;
}

/** Tag-set membership written together with a cache value. */
export interface DistributedCacheTagWrite {
  readonly key: string;
  readonly member: string;
}

/**
 * Atomic, fenced write requested by {@link DistributedCache}.
 *
 * A backend must write neither the value nor its tag memberships unless the
 * caller still owns the lock and every invalidation version is unchanged.
 */
export interface DistributedCacheFencedWrite {
  readonly lockKey: string;
  readonly lockToken: string;
  readonly key: string;
  readonly value: string;
  readonly ttlSeconds?: number;
  readonly versionChecks: readonly DistributedCacheVersionCheck[];
  readonly tags: readonly DistributedCacheTagWrite[];
}

/**
 * Low-level primitives a distributed backend must provide. All caching policy
 * (anti-stampede, fencing, tag generations, size limits and namespacing) lives
 * in {@link DistributedCache}; a backend only maps these calls to its protocol.
 */
export interface DistributedCacheDriver {
  /** Reads a raw string value; `null` when the key is absent. */
  read(key: string): Promise<string | null>;

  /** Writes a raw value with an optional TTL (seconds). */
  write(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Deletes keys; returns the number actually removed. */
  delete(keys: readonly string[]): Promise<number>;

  /**
   * Acquires a lock by setting `lockKey` to `token` only if absent (`SET NX EX`).
   * Returns `true` when acquired.
   */
  acquireLock(lockKey: string, token: string, ttlSeconds: number): Promise<boolean>;

  /**
   * Releases a lock **only if** it still holds `token` (fencing). Prevents a slow
   * worker from deleting a lock another worker already re-acquired.
   */
  releaseLock(lockKey: string, token: string, entryVersionKey?: string): Promise<void>;

  /** Atomically performs a value/tag write while the lock and versions match. */
  writeIfLockOwner(request: DistributedCacheFencedWrite): Promise<boolean>;

  /** Atomically deletes a key only when its complete raw value still matches. */
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;

  /** Atomically increments an invalidation generation and returns its new value. */
  increment(key: string): Promise<number>;

  /** Advances a tag generation and records the previous one for recoverable cleanup. */
  advanceTagGeneration(versionKey: string, pendingKey: string): Promise<number>;

  /**
   * Atomically deletes the current cache value and, when `lockKey` is present,
   * advances the generation that fences its owner. Implementations may omit a
   * tombstone when no writer lock exists.
   */
  invalidate(versionKey: string, valueKey: string, lockKey?: string): Promise<boolean>;

  /** Adds members to a tag set, refreshing the set TTL to avoid unbounded growth. */
  addTagMembers(tagKey: string, members: readonly string[], ttlSeconds?: number): Promise<void>;

  /** Removes members from a set. */
  removeTagMembers(tagKey: string, members: readonly string[]): Promise<void>;

  /** Returns the members of a tag set. */
  tagMembers(tagKey: string): Promise<readonly string[]>;
}
