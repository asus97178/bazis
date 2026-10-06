import { DEFAULT_MAX_KEY_LENGTH } from "../types/CacheOptions";

/** Shortens keys that exceed {@link DEFAULT_MAX_KEY_LENGTH} via stable hash. */
export function normalizeCacheKey(key: string, maxLength = DEFAULT_MAX_KEY_LENGTH): string {
  if (key.length <= maxLength) {
    return key;
  }
  return `h:${Bun.hash(key).toString(16)}`;
}
