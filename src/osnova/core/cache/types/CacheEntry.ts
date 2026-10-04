/** Одна запись кэша, возвращаемая {@link ICache.list}. */
export interface CacheEntry<TValue> {
  readonly key: string;
  readonly value: TValue;
  /** Unix timestamp (ms) истечения; отсутствует — запись бессрочная. */
  readonly expiresAt?: number;
}
