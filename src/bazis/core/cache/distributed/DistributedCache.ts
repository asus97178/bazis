import { createHash, randomUUID } from "node:crypto";
import { CacheValueError } from "../errors/CacheError";
import { assertCacheKey, measureStringBytes } from "../internal/CacheKeyGuard";
import type { CacheCodec } from "./CacheCodec";
import type {
  DistributedCacheDriver,
  DistributedCacheTagWrite,
  DistributedCacheVersionCheck,
} from "./DistributedCacheDriver";
import type { DistributedCacheSetOptions, IDistributedCache } from "./IDistributedCache";

const DEFAULT_DISTRIBUTED_MAX_KEY_LENGTH = 512;
const DEFAULT_POLL_INTERVAL_MS = 50;
const ENVELOPE_MARKER = "bazis-cache-v1";

interface StoredEnvelope {
  readonly token: string;
  readonly payload: string;
}

interface DistributedInFlightEntry {
  readonly promise: Promise<unknown>;
  readonly tags: readonly string[];
}

export interface DistributedCacheConfig {
  readonly connectionName: string;
  /** Connection-level prefix prepended to every key. */
  readonly keyPrefix: string;
  /** Extra namespace appended after `keyPrefix` (e.g. `svc:` for service cache). */
  readonly namespace?: string;
  /** Default anti-stampede lock TTL (seconds). */
  readonly defaultLockSeconds: number;
  readonly maxKeyLength?: number;
  /** Max serialized value size (bytes); `set` degrades gracefully past it. */
  readonly maxValueBytes?: number;
  /** Poll interval (ms) while waiting for a peer worker to fill the cache. */
  readonly pollIntervalMs?: number;
}

/**
 * Backend-agnostic distributed cache. Owns all caching policy and delegates raw
 * I/O to a {@link DistributedCacheDriver}. One instance per (connection × namespace).
 *
 * - cross-process anti-stampede: fencing-token lock + in-process in-flight dedup;
 * - tag index for group invalidation;
 * - serialized value-size guard.
 */
export class DistributedCache<TValue = unknown> implements IDistributedCache<TValue> {
  private readonly inFlight = new Map<string, DistributedInFlightEntry>();
  private readonly config: Readonly<DistributedCacheConfig>;
  private readonly fullPrefix: string;
  private readonly maxKeyLength: number;
  private readonly pollIntervalMs: number;

  public readonly connectionName: string;
  public readonly keyPrefix: string;

  public constructor(
    private readonly driver: DistributedCacheDriver,
    private readonly codec: CacheCodec<TValue>,
    config: DistributedCacheConfig,
  ) {
    const snapshot = Object.freeze({ ...config });
    if (!Number.isFinite(snapshot.defaultLockSeconds) || snapshot.defaultLockSeconds <= 0) {
      throw new CacheValueError("defaultLockSeconds must be a positive number");
    }
    if (snapshot.maxKeyLength !== undefined && (!Number.isInteger(snapshot.maxKeyLength) || snapshot.maxKeyLength <= 0)) {
      throw new CacheValueError("maxKeyLength must be a positive integer");
    }
    if (snapshot.maxValueBytes !== undefined && (!Number.isInteger(snapshot.maxValueBytes) || snapshot.maxValueBytes <= 0)) {
      throw new CacheValueError("maxValueBytes must be a positive integer");
    }
    if (snapshot.pollIntervalMs !== undefined && (!Number.isFinite(snapshot.pollIntervalMs) || snapshot.pollIntervalMs <= 0)) {
      throw new CacheValueError("pollIntervalMs must be a positive number");
    }
    this.config = snapshot;
    this.connectionName = snapshot.connectionName;
    this.keyPrefix = snapshot.keyPrefix;
    this.fullPrefix = `${snapshot.keyPrefix}${snapshot.namespace ?? ""}`;
    this.maxKeyLength = snapshot.maxKeyLength ?? DEFAULT_DISTRIBUTED_MAX_KEY_LENGTH;
    this.pollIntervalMs = snapshot.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  public async get<T = TValue>(key: string): Promise<T | undefined> {
    assertCacheKey(key, this.maxKeyLength);
    const storageKey = this.storageKey(key);
    const raw = await this.driver.read(storageKey);
    if (raw === null) {
      return undefined;
    }
    try {
      return this.codec.deserialize(decodeEnvelope(raw).payload) as unknown as T;
    } catch {
      try {
        await this.driver.deleteIfValue(storageKey, raw);
      } catch {
        // A corrupt cache entry is still a miss when backend cleanup fails.
        // Do not turn best-effort cache maintenance into a request failure.
      }
      return undefined;
    }
  }

  public async getOrCreateAsync<T = TValue>(
    key: string,
    factory: () => Promise<T | undefined>,
    options: DistributedCacheSetOptions,
  ): Promise<T | undefined> {
    const normalizedOptions = this.normalizeSetOptions(options);
    const hit = await this.get<T>(key);
    if (hit !== undefined) {
      return hit;
    }

    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing.promise as Promise<T | undefined>;
    }

    const pending = this.runLockedFactory<T>(key, factory, normalizedOptions);
    this.inFlight.set(key, { promise: pending, tags: normalizedOptions.tags ?? Object.freeze([]) });
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key)?.promise === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  public async remove(key: string): Promise<boolean> {
    assertCacheKey(key, this.maxKeyLength);
    this.inFlight.delete(key);
    return this.driver.invalidate(this.entryVersionKey(key), this.storageKey(key), this.lockKeyFor(key));
  }

  public async evictByTag(tag: string): Promise<number> {
    assertCacheKey(tag, this.maxKeyLength);
    for (const [key, entry] of this.inFlight) {
      if (entry.tags.includes(tag)) this.inFlight.delete(key);
    }
    const versionKey = this.tagVersionKey(tag);
    const pendingKey = this.tagPendingKey(tag);
    await this.driver.advanceTagGeneration(versionKey, pendingKey);
    const generations = [...await this.driver.tagMembers(pendingKey)]
      .filter((value) => /^\d+$/.test(value))
      .sort((left, right) => Number(left) - Number(right));
    let removed = 0;
    for (const generation of generations) {
      removed += await this.evictTagGeneration(tag, generation, pendingKey);
    }
    return removed;
  }

  private async evictTagGeneration(tag: string, generation: string, pendingKey: string): Promise<number> {
    const tagKey = this.tagKey(tag, generation);
    const members = await this.driver.tagMembers(tagKey);
    let removed = 0;
    for (const member of members) {
      const parsed = decodeTagMember(member);
      if (parsed === undefined) {
        continue;
      }
      if (!parsed.storageKey.startsWith(`${this.fullPrefix}entry:`)) {
        continue;
      }
      const raw = await this.driver.read(parsed.storageKey);
      if (raw === null) {
        continue;
      }
      if (decodeEnvelope(raw).token !== parsed.token) {
        continue;
      }
      if (await this.driver.deleteIfValue(parsed.storageKey, raw)) {
        removed += 1;
      }
    }
    await this.driver.delete([tagKey]);
    await this.driver.removeTagMembers(pendingKey, [generation]);
    return removed;
  }

  private storageKey(key: string): string {
    return `${this.fullPrefix}entry:${digest(key)}`;
  }

  private entryVersionKey(key: string): string {
    return `${this.fullPrefix}version:entry:${digest(key)}`;
  }

  private tagVersionKey(tag: string): string {
    return `${this.fullPrefix}version:tag:${digest(tag)}`;
  }

  private tagPendingKey(tag: string): string {
    return `${this.fullPrefix}pending:tag:${digest(tag)}`;
  }

  private tagKey(tag: string, generation: string): string {
    return `${this.fullPrefix}tag:${digest(tag)}:${generation}`;
  }

  private lockKeyFor(key: string): string {
    return `${this.fullPrefix}lock:${digest(key)}`;
  }

  private async runLockedFactory<T>(
    key: string,
    factory: () => Promise<T | undefined>,
    options: DistributedCacheSetOptions,
    contentionAttempt = 0,
  ): Promise<T | undefined> {
    const lockKey = this.lockKeyFor(key);
    const lockTtl = Math.max(1, Math.floor(options.lockSeconds ?? this.config.defaultLockSeconds));
    const token = randomUUID();

    const acquired = await this.driver.acquireLock(lockKey, token, lockTtl);
    if (!acquired) {
      const peerValue = await this.waitForPeerResult<T>(key, lockKey, lockTtl);
      if (peerValue !== undefined) return peerValue;
      if (contentionAttempt < 2) {
        return this.runLockedFactory(key, factory, options, contentionAttempt + 1);
      }
      // Availability fallback: another owner repeatedly failed to publish. The
      // caller still receives its service result, but we do not write unlocked.
      return factory();
    }

    try {
      const again = await this.get<T>(key);
      if (again !== undefined) {
        return again;
      }
      const versionChecks = await this.captureVersions(key, options.tags);
      const value = await factory();
      if (value !== undefined) {
        await this.trySet(key, value, options, lockKey, token, versionChecks);
      }
      return value;
    } finally {
      try {
        // Unlock is best effort: a transport error must not replace a fresh
        // service result or the factory's original exception. The lock still
        // has a bounded TTL, so another worker eventually makes progress.
        await this.driver.releaseLock(lockKey, token, this.entryVersionKey(key));
      } catch {
        // Intentionally preserve the primary outcome.
      }
    }
  }

  private async waitForPeerResult<T>(key: string, lockKey: string, lockTtl: number): Promise<T | undefined> {
    const deadline = Date.now() + lockTtl * 1000;
    while (Date.now() < deadline) {
      const hit = await this.get<T>(key);
      if (hit !== undefined) {
        return hit;
      }
      if (await this.driver.read(lockKey) === null) {
        break;
      }
      await Bun.sleep(this.pollIntervalMs);
    }
    return undefined;
  }

  private async trySet<T>(
    key: string,
    value: T,
    options: DistributedCacheSetOptions,
    lockKey: string,
    lockToken: string,
    versionChecks: readonly DistributedCacheVersionCheck[],
  ): Promise<void> {
    try {
      await this.write(key, value as unknown as TValue, options, lockKey, lockToken, versionChecks);
    } catch {
      // Graceful degradation — the caller still receives the fresh value.
    }
  }

  private async write(
    key: string,
    value: TValue,
    options: DistributedCacheSetOptions,
    lockKey: string,
    lockToken: string,
    versionChecks: readonly DistributedCacheVersionCheck[],
  ): Promise<void> {
    assertCacheKey(key, this.maxKeyLength);
    const serialized = this.codec.serialize(value);

    if (this.config.maxValueBytes !== undefined) {
      const bytes = measureStringBytes(serialized);
      if (bytes > this.config.maxValueBytes) {
        throw new CacheValueError(`Cache value exceeds max size of ${this.config.maxValueBytes} bytes`);
      }
    }

    const ttl = options.ttlSeconds !== undefined ? Math.max(1, Math.floor(options.ttlSeconds)) : undefined;
    const storageKey = this.storageKey(key);
    const tags: DistributedCacheTagWrite[] = [];
    for (const tag of options.tags ?? []) {
      const version = versionChecks.find((check) => check.key === this.tagVersionKey(tag))?.expected ?? null;
      tags.push({
        key: this.tagKey(tag, version ?? "0"),
        member: "",
      });
    }
    // Deterministic for one key + tag-generation set: repeated remove/recreate
    // does not grow Redis sets, while changing tags/generation fences stale
    // memberships. Keep the v1 three-item envelope/two-item member wire format
    // so rolling upgrades remain readable by older runtimes.
    const writeToken = digest(JSON.stringify([storageKey, tags.map((tag) => tag.key).sort()]));
    for (let index = 0; index < tags.length; index += 1) {
      const tag = tags[index] as DistributedCacheTagWrite;
      tags[index] = { key: tag.key, member: encodeTagMember(storageKey, writeToken) };
    }
    const envelope = encodeEnvelope(writeToken, serialized);
    await this.driver.writeIfLockOwner({
      lockKey,
      lockToken,
      key: storageKey,
      value: envelope,
      ttlSeconds: ttl,
      versionChecks,
      tags,
    });
  }

  private async captureVersions(
    key: string,
    tags: readonly string[] | undefined,
  ): Promise<readonly DistributedCacheVersionCheck[]> {
    const keys = [this.entryVersionKey(key), ...(tags ?? []).map((tag) => this.tagVersionKey(tag))];
    return Promise.all(keys.map(async (versionKey) => ({
      key: versionKey,
      expected: await this.driver.read(versionKey),
    })));
  }

  private normalizeSetOptions(options: DistributedCacheSetOptions): DistributedCacheSetOptions {
    if (options.ttlSeconds !== undefined && (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0)) {
      throw new CacheValueError("ttlSeconds must be a positive number");
    }
    if (options.lockSeconds !== undefined && (!Number.isFinite(options.lockSeconds) || options.lockSeconds <= 0)) {
      throw new CacheValueError("lockSeconds must be a positive number");
    }
    for (const tag of options.tags ?? []) {
      assertCacheKey(tag, this.maxKeyLength);
    }
    return Object.freeze({
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.lockSeconds !== undefined ? { lockSeconds: options.lockSeconds } : {}),
      ...(options.tags !== undefined ? { tags: Object.freeze([...options.tags]) } : {}),
    });
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeEnvelope(token: string, payload: string): string {
  return JSON.stringify([ENVELOPE_MARKER, token, payload]);
}

function decodeEnvelope(raw: string): StoredEnvelope {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === 3
      && parsed[0] === ENVELOPE_MARKER
      && typeof parsed[1] === "string"
      && typeof parsed[2] === "string"
    ) {
      return { token: parsed[1], payload: parsed[2] };
    }
  } catch {
    // Older cache entries stored the codec payload directly. Keep them readable
    // during a rolling upgrade; they simply do not participate in new tag sets.
  }
  return { token: "", payload: raw };
}

function encodeTagMember(storageKey: string, token: string): string {
  return JSON.stringify([storageKey, token]);
}

function decodeTagMember(member: string): { readonly storageKey: string; readonly token: string } | undefined {
  try {
    const parsed = JSON.parse(member) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { storageKey: parsed[0], token: parsed[1] };
    }
  } catch {
    // Ignore malformed/legacy tag members instead of treating their content as
    // a backend key.
  }
  return undefined;
}
