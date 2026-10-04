import { createOptionsToken } from "../../di";

/** Опции in-memory кэша. */
export interface CacheOptions {
  /** Максимальное число записей; при переполнении вытесняется LRU-запись. */
  readonly maxEntries?: number;
  /** Максимум одновременно выполняемых factory; по умолчанию 1024.
   * При переполнении новый cache miss получает CacheCapacityError до запуска factory.
   */
  readonly maxInFlight?: number;
  /** TTL по умолчанию для {@link ICache.set} (секунды). */
  readonly defaultTtlSeconds?: number;
  /** Максимальная длина ключа (символы). По умолчанию 256. */
  readonly maxKeyLength?: number;
  /** Лимит размера строкового значения (байты UTF-8). Не задан — без лимита. */
  readonly maxValueBytes?: number;
}

/** Пер-запись опции записи. */
export interface CacheSetOptions {
  /** TTL этой записи (секунды); перекрывает default из {@link CacheOptions}. */
  readonly ttlSeconds?: number;
  /** Теги для групповой инвалидации через {@link ICache.evictByTag}. */
  readonly tags?: readonly string[];
}

export const DEFAULT_MAX_KEY_LENGTH = 256;
export const DEFAULT_MAX_IN_FLIGHT = 1024;

/** DI-токен validated options кэша. */
export const CACHE_OPTIONS = createOptionsToken<CacheOptions>("Cache");

export function validateCacheOptions(options: CacheOptions): readonly string[] {
  const issues: string[] = [];
  if (options.maxInFlight !== undefined && (!Number.isSafeInteger(options.maxInFlight) || options.maxInFlight < 1)) {
    issues.push("maxInFlight must be a positive safe integer");
  }
  if (options.maxEntries !== undefined && (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)) {
    issues.push("maxEntries must be a positive integer");
  }
  if (
    options.defaultTtlSeconds !== undefined
    && (!Number.isFinite(options.defaultTtlSeconds) || options.defaultTtlSeconds <= 0)
  ) {
    issues.push("defaultTtlSeconds must be a positive number");
  }
  if (
    options.maxKeyLength !== undefined
    && (!Number.isInteger(options.maxKeyLength) || options.maxKeyLength < 1)
  ) {
    issues.push("maxKeyLength must be a positive integer");
  }
  if (
    options.maxValueBytes !== undefined
    && (!Number.isInteger(options.maxValueBytes) || options.maxValueBytes < 1)
  ) {
    issues.push("maxValueBytes must be a positive integer");
  }
  return issues;
}
