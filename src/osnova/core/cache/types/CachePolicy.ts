import type { HttpContext } from "../../http";

/** Shared cache policy fields for HTTP output cache and service method cache. */
export interface CachePolicyBase {
  /** TTL in seconds. */
  readonly seconds?: number;
  /** Tags for group invalidation via {@link ICache.evictByTag}. */
  readonly tags?: readonly string[];
  /** When false, caching is skipped (metadata kept). Default true. */
  readonly enabled?: boolean;
  /** Disable caching for this entry. */
  readonly noStore?: boolean;
}

/** Named policy registry entry (module-level defaults). */
export type CachePolicy = CachePolicyBase & OutputCachePolicyFields & CacheablePolicyFields;

/** HTTP output cache options (ASP.NET Core Output Cache). */
export interface OutputCachePolicyFields {
  /** Maximum response body buffered for one cache entry. Default 16 MiB; 0 disables the limit. */
  readonly maxBodyBytes?: number;
  /** Total time allowed to materialize a response body. Default 5000ms; 0 disables the timeout. */
  readonly bodyReadTimeoutMs?: number;
  readonly varyByQuery?: readonly string[] | "*";
  readonly varyByRoute?: readonly string[];
  readonly varyByHeader?: readonly string[];
  /** Separate cache entry per authenticated user (`sub`). */
  readonly varyByUser?: boolean;
  /** Separate cache entry per JWT claim value. */
  readonly varyByClaim?: string;
  /** HTTP methods allowed for caching (default GET, HEAD). */
  readonly methods?: readonly string[];
  /** Status codes to store (default 200). */
  readonly statusCodes?: readonly number[];
  /** Skip cache when the request is authenticated. */
  readonly unlessAuthenticated?: boolean;
  /**
   * Explicitly share one server/client cache entry with authenticated callers
   * when the response is guaranteed not to depend on the principal.
   * Default false: optional-auth requests bypass a non-personalized policy.
   */
  readonly allowAuthenticatedShared?: boolean;
  /** Client/proxy Cache-Control headers (Response Cache layer). */
  readonly clientCache?: ClientCacheOptions;
  /** Custom predicate; return false to skip cache read/write. */
  readonly when?: (ctx: HttpContext) => boolean | Promise<boolean>;
}

/** Service method cache options (IMemoryCache / @Cacheable). */
export interface CacheablePolicyFields {
  /** Static key prefix or builder from method arguments. */
  readonly key?: string | ((...args: readonly unknown[]) => string);
  /** Skip cache when predicate returns true. */
  readonly unless?: (...args: readonly unknown[]) => boolean;
}

export interface ClientCacheOptions {
  readonly maxAge?: number;
  readonly public?: boolean;
  readonly private?: boolean;
  readonly noCache?: boolean;
}

/** Options for {@link OutputCache} decorator. */
export type OutputCacheOptions = CachePolicyBase & OutputCachePolicyFields & {
  readonly policy?: string;
};

/** Options for {@link Cacheable} decorator. */
export type CacheableOptions = CachePolicyBase & CacheablePolicyFields & {
  readonly policy?: string;
};

export type CachePolicyRegistry = Readonly<Record<string, CachePolicy>>;
