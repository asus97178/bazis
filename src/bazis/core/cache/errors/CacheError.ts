import { DiError } from "../../di";
/** Base error of the cache module. */
export class CacheError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid cache key (type, length, forbidden name). */
export class CacheKeyError extends CacheError {}

/** Invalid value (size limit exceeded and the like). */
export class CacheValueError extends CacheError {}

/**
 * The distributed store did not answer in time or failed. On the cache-aside
 * path (`getOrCreateAsync`, `@CacheableRedis`) the value is computed without
 * the cache; explicit operations (`get`, `remove`, `evictByTag`) throw it.
 */
export class CacheUnavailableError extends CacheError {}

/** The limit of unfinished factories is exhausted; the new factory was not started. */
export class CacheCapacityError extends CacheError {}

/**
 * A cache declaration that can never work, found while the container is built
 * (a cached scoped method without a key, a cached transient service). A DI
 * error, so the start prints it as a configuration error.
 */
export class CacheDeclarationError extends DiError {}
