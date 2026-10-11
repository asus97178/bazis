import { createHash, randomUUID } from "node:crypto";
import { CacheUnavailableError, CacheValueError } from "../errors/CacheError";
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
  /** Bound of one store operation (ms); a hung store must not hang the caller. Default 1000. */
  readonly operationTimeoutMs?: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 1000;

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
  private readonly operationTimeoutMs: number;
  /** The driver with every operation bounded by {@link io}. */
  private readonly ioCall: DistributedCacheDriver;

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
    if (snapshot.operationTimeoutMs !== undefined && (!Number.isSafeInteger(snapshot.operationTimeoutMs) || snapshot.operationTimeoutMs <= 0 || snapshot.operationTimeoutMs > 2_147_483_647)) {
      throw new CacheValueError("operationTimeoutMs must be a positive integer of milliseconds");
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
    this.operationTimeoutMs = snapshot.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.ioCall = new Proxy(driver, {
      get: (target, property) => {
        const member = (target as unknown as Record<PropertyKey, unknown>)[property];
        return typeof member === "function"
          ? (...args: unknown[]) => this.io(() => (member as (...values: unknown[]) => Promise<unknown>).apply(target, args))
          : member;
      },
    });
  }

  /**
   * One store operation, bounded by `operationTimeoutMs`. A timeout or a driver
   * failure becomes {@link CacheUnavailableError}; the native operation is not
   * cancelled (the driver has no cancellation), only no longer awaited.
   */
  private io<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CacheUnavailableError(
        `Distributed cache "${this.connectionName}" did not answer within ${this.operationTimeoutMs} ms.`,
      )), this.operationTimeoutMs);
      let started: Promise<T>;
      try { started = work(); } catch (error) { clearTimeout(timer); reject(unavailable(this.connectionName, error)); return; }
      started.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(unavailable(this.connectionName, error)); },
      );
    });
  }

  public async get<T = TValue>(key: string): Promise<T | undefined> {
    assertCacheKey(key, this.maxKeyLength);
    const storageKey = this.storageKey(key);
    const raw = await this.ioCall.read(storageKey);
    if (raw === null) {
      return undefined;
    }
    try {
      return this.codec.deserialize(decodeEnvelope(raw).payload) as unknown as T;
    } catch {
      try {
        await this.ioCall.deleteIfValue(storageKey, raw);
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
    let hit: T | undefined;
    try {
      hit = await this.get<T>(key);
    } catch (error) {
      // The cache is optional: an unavailable store means "compute it now".
      if (error instanceof CacheUnavailableError) return factory();
      throw error;
    }
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
    return this.ioCall.invalidate(this.entryVersionKey(key), this.storageKey(key), this.lockKeyFor(key));
  }

  public async evictByTag(tag: string): Promise<number> {
    assertCacheKey(tag, this.maxKeyLength);
    for (const [key, entry] of this.inFlight) {
      if (entry.tags.includes(tag)) this.inFlight.delete(key);
    }
    const versionKey = this.tagVersionKey(tag);
    const pendingKey = this.tagPendingKey(tag);
    await this.ioCall.advanceTagGeneration(versionKey, pendingKey);
    const generations = [...await this.ioCall.tagMembers(pendingKey)]
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
    const members = await this.ioCall.tagMembers(tagKey);
    let removed = 0;
    for (const member of members) {
      const parsed = decodeTagMember(member);
      if (parsed === undefined) {
        continue;
      }
      if (!parsed.storageKey.startsWith(`${this.fullPrefix}entry:`)) {
        continue;
      }
      const raw = await this.ioCall.read(parsed.storageKey);
      if (raw === null) {
        continue;
      }
      if (decodeEnvelope(raw).token !== parsed.token) {
        continue;
      }
      if (await this.ioCall.deleteIfValue(parsed.storageKey, raw)) {
        removed += 1;
      }
    }
    await this.ioCall.delete([tagKey]);
    await this.ioCall.removeTagMembers(pendingKey, [generation]);
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

    let acquired: boolean;
    try {
      acquired = await this.ioCall.acquireLock(lockKey, token, lockTtl);
    } catch (error) {
      if (error instanceof CacheUnavailableError) return factory();
      throw error;
    }
    if (!acquired) {
      let peerValue: T | undefined;
      try {
        peerValue = await this.waitForPeerResult<T>(key, lockKey, lockTtl);
      } catch (error) {
        if (error instanceof CacheUnavailableError) return factory();
        throw error;
      }
      if (peerValue !== undefined) return peerValue;
      if (contentionAttempt < 2) {
        return this.runLockedFactory(key, factory, options, contentionAttempt + 1);
      }
      // Availability fallback: another owner repeatedly failed to publish. The
      // caller still receives its service result, but we do not write unlocked.
      return factory();
    }

    try {
      let versionChecks: readonly DistributedCacheVersionCheck[];
      try {
        const again = await this.get<T>(key);
        if (again !== undefined) {
          return again;
        }
        versionChecks = await this.captureVersions(key, options.tags);
      } catch (error) {
        // The store went away under the lock: compute, but do not write.
        if (error instanceof CacheUnavailableError) return await factory();
        throw error;
      }
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
        await this.ioCall.releaseLock(lockKey, token, this.entryVersionKey(key));
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
      if (await this.ioCall.read(lockKey) === null) {
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
    // A value the codec refuses is a bug of the cached method, not a store
    // outage: it surfaces instead of silently never being cached.
    const serialized = this.codec.serialize(value as unknown as TValue);
    try {
      await this.write(key, serialized, options, lockKey, lockToken, versionChecks);
    } catch {
      // Graceful degradation — the caller still receives the fresh value.
    }
  }

  private async write(
    key: string,
    serialized: string,
    options: DistributedCacheSetOptions,
    lockKey: string,
    lockToken: string,
    versionChecks: readonly DistributedCacheVersionCheck[],
  ): Promise<void> {
    assertCacheKey(key, this.maxKeyLength);

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
    await this.ioCall.writeIfLockOwner({
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
      expected: await this.ioCall.read(versionKey),
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

function unavailable(connection: string, error: unknown): CacheUnavailableError {
  if (error instanceof CacheUnavailableError) return error;
  return new CacheUnavailableError(`Distributed cache "${connection}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
