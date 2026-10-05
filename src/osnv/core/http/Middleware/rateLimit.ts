import { TooManyRequestsError } from "../Errors/HttpError";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { HttpMiddleware } from "./types";
import { HttpSetupError } from "../Errors/HttpError";

export interface RateLimitOptions {
  /** Window size in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /**
   * Request key (default: Bun's direct peer IP, falling back to a single shared
   * bucket when unavailable). Plug your own: user id, API key, etc.
   */
  keyOf?: (ctx: HttpContext) => string;
  /** Trust the first `X-Forwarded-For` hop. Off by default. */
  trustProxy?: boolean;
  /** Forwarded client-address header used when `trustProxy` is true. */
  proxyHeader?: string;
  /** Hard cap for in-process buckets. New keys receive 429 when full. Default: 10,000. */
  maxBuckets?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter. Per-process state (no external
 * store) — suitable for a single binary; swap `keyOf` or wrap your own
 * middleware for distributed setups. Exceeding the limit throws 429 with
 * Retry-After. At capacity, new keys are rejected until a bucket expires;
 * existing keys retain their quota and live buckets are never evicted.
 */
export function rateLimit(options: RateLimitOptions): HttpMiddleware {
  assertRateLimitOptions(options);
  const buckets = new Map<string, Bucket>();
  const maxBuckets = Math.floor(options.maxBuckets ?? 10_000);
  let nextExpiry = Number.POSITIVE_INFINITY;
  const proxyHeader = options.proxyHeader ?? "x-forwarded-for";
  const keyOf = options.keyOf ?? ((ctx: HttpContext) => {
    if (options.trustProxy) {
      const forwarded = ctx.header(proxyHeader)?.split(",", 1)[0]?.trim();
      if (forwarded) {
        return forwarded;
      }
    }
    return ctx.clientIp ?? "*";
  });

  return async (ctx, next) => {
    const now = Date.now();
    const key = keyOf(ctx);
    let bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      // Avoid scanning a full table for every unknown key under saturation.
      // This lower bound may be stale after a known key renews its own window;
      // a single scan refreshes it without discarding any active quota.
      if (buckets.size >= maxBuckets && now >= nextExpiry) {
        nextExpiry = purgeExpired(buckets, now);
      }
      if (buckets.size >= maxBuckets) {
        throw new TooManyRequestsError(Math.ceil((nextExpiry - now) / 1000));
      }
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
      nextExpiry = Math.min(nextExpiry, bucket.resetAt);
    }
    if (bucket.count >= options.max) {
      throw new TooManyRequestsError(Math.ceil((bucket.resetAt - now) / 1000));
    }
    bucket.count += 1;
    await next();
  };
}

function assertRateLimitOptions(options: RateLimitOptions): void {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new HttpSetupError("rateLimit windowMs must be a positive finite number.");
  }
  if (!Number.isSafeInteger(options.max) || options.max <= 0) {
    throw new HttpSetupError("rateLimit max must be a positive integer.");
  }
  if (options.maxBuckets !== undefined && (!Number.isSafeInteger(options.maxBuckets) || options.maxBuckets <= 0)) {
    throw new HttpSetupError("rateLimit maxBuckets must be a positive integer.");
  }
}

function purgeExpired(buckets: Map<string, Bucket>, now: number): number {
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    } else {
      nextExpiry = Math.min(nextExpiry, bucket.resetAt);
    }
  }
  return nextExpiry;
}
