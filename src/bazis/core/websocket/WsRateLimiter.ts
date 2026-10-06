/**
 * Minimal in-process fixed-window limiter for WebSocket admission and traffic.
 * Single-node; a clustered deployment would track windows in the adapter.
 */
export interface WsRateLimiterOptions {
  readonly maxBuckets?: number;
  readonly purgeIntervalMs?: number;
}

export interface WsRateLimiterStats {
  readonly buckets: number;
}

export class WsRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxBuckets: number;
  private readonly purgeIntervalMs: number;
  private nextPurgeAt = 0;

  public constructor(options: WsRateLimiterOptions = {}) {
    this.maxBuckets = positiveInteger(options.maxBuckets, 10_000);
    this.purgeIntervalMs = nonNegativeInteger(options.purgeIntervalMs, 60_000);
  }

  /** Returns true if the call is allowed; false when the window is exhausted. */
  public check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (now >= this.nextPurgeAt || this.buckets.size >= this.maxBuckets) {
      this.purgeExpired(now);
    }
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.ensureCapacity();
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** Drops a key's window (e.g. on disconnect). */
  public forget(key: string): void {
    this.buckets.delete(key);
  }

  public forgetMany(keys: Iterable<string>): void {
    for (const key of keys) {
      this.buckets.delete(key);
    }
  }

  public clear(): void {
    this.buckets.clear();
    this.nextPurgeAt = 0;
  }

  public purgeExpired(now = Date.now()): number {
    let purged = 0;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
        purged += 1;
      }
    }
    this.nextPurgeAt = now + this.purgeIntervalMs;
    return purged;
  }

  public getStats(): WsRateLimiterStats {
    this.purgeExpired();
    return { buckets: this.buckets.size };
  }

  private ensureCapacity(): void {
    if (this.buckets.size < this.maxBuckets) {
      return;
    }
    let oldestKey: string | undefined;
    let oldestReset = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < oldestReset) {
        oldestKey = key;
        oldestReset = bucket.resetAt;
      }
    }
    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
