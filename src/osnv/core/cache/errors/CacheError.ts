/** Base error of the cache module. */
export class CacheError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid cache key (type, length, forbidden name). */
export class CacheKeyError extends CacheError {}

/** Invalid value (size limit exceeded and the like). */
export class CacheValueError extends CacheError {}

/** The limit of unfinished factories is exhausted; the new factory was not started. */
export class CacheCapacityError extends CacheError {}
