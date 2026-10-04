import { createToken, type InjectionToken } from "../di";
import type { CacheEntry } from "./types/CacheEntry";
import type { CacheSetOptions } from "./types/CacheOptions";

/** Factory for {@link ICache.getOrCreate} / {@link ICache.getOrCreateAsync}. */
export type CacheFactory<TValue> = () => TValue | Promise<TValue | undefined> | undefined;

/**
 * Контракт key-value кэша.
 *
 * Реализации обязаны:
 * - валидировать ключи (строка, не пустая, без `__proto__` и т.п.);
 * - возвращать cache miss при отсутствии значения; ошибки входа и factory не скрывать;
 * - при TTL просроченные записи ведут себя как отсутствующие.
 */
export interface ICache<TValue = unknown> {
  /** Читает одну запись; `undefined`, если нет или истёк TTL. */
  get(key: string): TValue | undefined;

  /** Снимок всех актуальных записей (без просроченных). */
  list(): readonly CacheEntry<TValue>[];

  /** Записывает значение; при переполнении — LRU-вытеснение. */
  set(key: string, value: TValue, options?: CacheSetOptions): void;

  /**
   * Возвращает значение из кэша или создаёт через `factory`.
   * `undefined` из factory не сохраняется.
   * MemoryCache бросает CacheCapacityError до запуска новой factory, если
   * достигнут maxInFlight; cache hits и присоединение к текущей работе разрешены.
   */
  getOrCreate(
    key: string,
    factory: CacheFactory<TValue>,
    options?: CacheSetOptions,
  ): TValue | Promise<TValue | undefined> | undefined;

  /**
   * Async-версия с dedup in-flight запросов по ключу (anti-stampede).
   * `undefined` из factory не сохраняется.
   * Проверка входа и допуска может бросить синхронно до возврата Promise.
   */
  getOrCreateAsync(
    key: string,
    factory: () => Promise<TValue | undefined>,
    options?: CacheSetOptions,
  ): Promise<TValue | undefined>;

  /** Удаляет одну запись; `true`, если запись существовала. */
  remove(key: string): boolean;

  /** Удаляет все записи. */
  clear(): void;

  /**
   * Удаляет все записи с указанным тегом.
   * @returns число удалённых записей.
   */
  evictByTag(tag: string): number;

  /** Число актуальных записей (после ленивой очистки TTL). */
  readonly size: number;
}

/** DI-токен кэша по умолчанию. */
export const ICache = createToken<ICache>("ICache") as InjectionToken<ICache<unknown>>;

/** Типизированный токен для конкретного value-type. */
export function cacheToken<TValue>(name: string): InjectionToken<ICache<TValue>> {
  return createToken<ICache<TValue>>(`ICache<${name}>`);
}
