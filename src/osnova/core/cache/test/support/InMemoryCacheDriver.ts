import type { DistributedCacheDriver, DistributedCacheFencedWrite } from "@/core/cache";

/**
 * In-process {@link DistributedCacheDriver} for tests — exercises the full
 * distributed cache policy (fencing lock, anti-stampede, tags) without Redis.
 */
export class InMemoryCacheDriver implements DistributedCacheDriver {
  public readonly store = new Map<string, string>();
  public readonly locks = new Map<string, string>();
  public readonly tags = new Map<string, Set<string>>();

  public async read(key: string): Promise<string | null> {
    return this.store.get(key) ?? this.locks.get(key) ?? null;
  }

  public async write(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  public async delete(keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key) || this.tags.delete(key)) {
        removed += 1;
      }
    }
    return removed;
  }

  public async acquireLock(lockKey: string, token: string): Promise<boolean> {
    if (this.locks.has(lockKey)) {
      return false;
    }
    this.locks.set(lockKey, token);
    return true;
  }

  public async releaseLock(lockKey: string, token: string, entryVersionKey?: string): Promise<void> {
    if (this.locks.get(lockKey) === token) {
      this.locks.delete(lockKey);
      if (entryVersionKey !== undefined) this.store.delete(entryVersionKey);
    }
  }

  public async writeIfLockOwner(request: DistributedCacheFencedWrite): Promise<boolean> {
    if (this.locks.get(request.lockKey) !== request.lockToken) {
      return false;
    }
    for (const check of request.versionChecks) {
      if ((this.store.get(check.key) ?? null) !== check.expected) {
        return false;
      }
    }
    this.store.set(request.key, request.value);
    for (const tag of request.tags) {
      let set = this.tags.get(tag.key);
      if (set === undefined) {
        set = new Set();
        this.tags.set(tag.key, set);
      }
      set.add(tag.member);
    }
    return true;
  }

  public async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    if (this.store.get(key) !== expectedValue) {
      return false;
    }
    return this.store.delete(key);
  }

  public async increment(key: string): Promise<number> {
    const value = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(value));
    return value;
  }

  public async invalidate(versionKey: string, valueKey: string, lockKey?: string): Promise<boolean> {
    if (lockKey === undefined || this.locks.has(lockKey)) {
      const value = Number(this.store.get(versionKey) ?? "0") + 1;
      this.store.set(versionKey, String(value));
    } else {
      this.store.delete(versionKey);
    }
    return this.store.delete(valueKey);
  }

  public async advanceTagGeneration(versionKey: string, pendingKey: string): Promise<number> {
    const value = Number(this.store.get(versionKey) ?? "0") + 1;
    this.store.set(versionKey, String(value));
    let pending = this.tags.get(pendingKey);
    if (pending === undefined) {
      pending = new Set();
      this.tags.set(pendingKey, pending);
    }
    pending.add(String(value - 1));
    return value;
  }

  public async addTagMembers(tagKey: string, members: readonly string[]): Promise<void> {
    let set = this.tags.get(tagKey);
    if (set === undefined) {
      set = new Set();
      this.tags.set(tagKey, set);
    }
    for (const member of members) {
      set.add(member);
    }
  }

  public async removeTagMembers(tagKey: string, members: readonly string[]): Promise<void> {
    const set = this.tags.get(tagKey);
    if (set === undefined) return;
    for (const member of members) set.delete(member);
    if (set.size === 0) this.tags.delete(tagKey);
  }

  public async tagMembers(tagKey: string): Promise<readonly string[]> {
    return [...(this.tags.get(tagKey) ?? [])];
  }
}
