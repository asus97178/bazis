import { CacheError } from "../errors/CacheError";
import type { CachePolicy, CacheableOptions, OutputCacheOptions } from "../types/CachePolicy";

/** Merges named policy with inline decorator options (inline wins). */
export function resolveCacheOptions<T extends OutputCacheOptions | CacheableOptions>(
  inline: T,
  policies: Readonly<Record<string, CachePolicy>>,
): T & CachePolicy {
  const policyName = inline.policy;
  const base = policyName !== undefined ? policies[policyName] ?? {} : {};
  return { ...base, ...inline };
}

/** Resolved output cache requirement attached to a controller action. */
export type ResolvedOutputCacheOptions = OutputCacheOptions & CachePolicy & {
  readonly seconds: number;
};

/** Resolved cacheable requirement attached to a service method. */
export type ResolvedCacheableOptions = CacheableOptions & CachePolicy & {
  readonly seconds: number;
};

export function requireCacheSeconds(options: CachePolicy, context: string): number {
  if (options.seconds === undefined || !Number.isFinite(options.seconds) || options.seconds <= 0) {
    throw new CacheError(`${context}: "seconds" (or policy with seconds) is required`);
  }
  return options.seconds;
}

export const DEFAULT_OUTPUT_CACHE_METHODS = ["GET", "HEAD"] as const;
export const DEFAULT_OUTPUT_CACHE_STATUS_CODES = [200] as const;

/**
 * @deprecated Internal compatibility alias kept through Osnova 0.x. Use
 * {@link DEFAULT_OUTPUT_CACHE_METHODS}; earliest removal is 1.0.
 */
export const DEFAULT_CACHEABLE_METHODS = DEFAULT_OUTPUT_CACHE_METHODS;

/**
 * @deprecated Internal compatibility alias kept through Osnova 0.x. Use
 * {@link DEFAULT_OUTPUT_CACHE_STATUS_CODES}; earliest removal is 1.0.
 */
export const DEFAULT_CACHEABLE_STATUS_CODES = DEFAULT_OUTPUT_CACHE_STATUS_CODES;
