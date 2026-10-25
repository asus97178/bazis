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
   * Request key (default: `ctx.clientIp`, the client's address behind
   * `http.trustedProxies`, falling back to a single shared bucket when it is
   * unavailable). Plug your own: user id, API key, etc.
   */
  keyOf?: (ctx: HttpContext) => string;
  /** Hard cap for in-process buckets. New keys receive 429 when full. Default: 10,000. */
  maxBuckets?: number;
  /** Add `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` to responses. Default: true. */
  headers?: boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory rate limiter. Per-process state (no external
 * store) — suitable for a single binary; swap `keyOf` or wrap your own
 * middleware for distributed setups. Exceeding the limit throws 429 with
 * Retry-After; every response carries `RateLimit-Limit`, `RateLimit-Remaining`
 * and `RateLimit-Reset` unless `headers: false`. At capacity, new keys are rejected until a bucket expires;
 * existing keys retain their quota and live buckets are never evicted.
 */
export function rateLimit(options: RateLimitOptions): HttpMiddleware {
  assertRateLimitOptions(options);
  const buckets = new Map<string, Bucket>();
  const maxBuckets = Math.floor(options.maxBuckets ?? 10_000);
  let nextExpiry = Number.POSITIVE_INFINITY;
  const withHeaders = options.headers !== false;
  const keyOf = options.keyOf ?? ((ctx: HttpContext) => ctx.clientIp ?? "*");
  const limitHeaders = (remaining: number, resetSeconds: number): Record<string, string> => ({
    "ratelimit-limit": String(options.max),
    "ratelimit-remaining": String(remaining),
    "ratelimit-reset": String(resetSeconds),
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
        const retryAfter = Math.ceil((nextExpiry - now) / 1000);
        throw new TooManyRequestsError(retryAfter, withHeaders ? limitHeaders(0, retryAfter) : undefined);
      }
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
      nextExpiry = Math.min(nextExpiry, bucket.resetAt);
    }
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    if (bucket.count >= options.max) {
      throw new TooManyRequestsError(resetSeconds, withHeaders ? limitHeaders(0, resetSeconds) : undefined);
    }
    bucket.count += 1;
    await next();
    if (withHeaders && ctx.response) {
      setIfAbsent(ctx.response, limitHeaders(options.max - bucket.count, resetSeconds));
    }
  };
}

/**
 * The client address `hops` entries from the end of `X-Forwarded-For`: each
 * trusted proxy appends the address it saw, so entries before them are
 * whatever the client sent.
 */
function setIfAbsent(response: Response, headers: Record<string, string>): void {
  try {
    for (const [name, value] of Object.entries(headers)) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
  } catch {
    // A raw Response may have immutable headers; the limit itself still applies.
  }
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
  // Counting hops trusted a forged header whenever the app was reachable
  // directly; the server now decides from the connection's own address.
  const moved = (["trustProxy", "proxyHeader"] as const).find((name) => Object.hasOwn(options, name));
  if (moved !== undefined) {
    throw new HttpSetupError(`rateLimit ${moved} was removed: list the proxies in http.trustedProxies (for example ["127.0.0.1"] for nginx); rateLimit then keys by ctx.clientIp.`);
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
