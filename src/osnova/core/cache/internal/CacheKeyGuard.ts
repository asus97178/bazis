import { CacheKeyError } from "../errors/CacheError";
import { DEFAULT_MAX_KEY_LENGTH } from "../types/CacheOptions";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const encoder = new TextEncoder();

/** Проверяет ключ кэша: тип, длина, защита от prototype pollution. */
export function assertCacheKey(key: unknown, maxKeyLength = DEFAULT_MAX_KEY_LENGTH): asserts key is string {
  if (typeof key !== "string") {
    throw new CacheKeyError("Cache key must be a string");
  }
  if (key.length === 0) {
    throw new CacheKeyError("Cache key must not be empty");
  }
  if (key.length > maxKeyLength) {
    throw new CacheKeyError(`Cache key exceeds max length of ${maxKeyLength}`);
  }
  if (FORBIDDEN_KEYS.has(key)) {
    throw new CacheKeyError(`Cache key '${key}' is not allowed`);
  }
}

/** Оценивает размер строкового значения в байтах UTF-8. */
export function measureStringBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Best-effort размер значения в байтах для лимита `maxValueBytes`.
 * Покрывает строки, бинарные буферы и HTTP-payload (по `body: Uint8Array`).
 * Возвращает `undefined`, если размер измерить нельзя — тогда лимит не применяется.
 */
export function measureValueBytes(value: unknown): number | undefined {
  if (typeof value === "string") {
    return encoder.encode(value).byteLength;
  }
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (value !== null && typeof value === "object") {
    const body = (value as { body?: unknown }).body;
    if (body instanceof Uint8Array) {
      return body.byteLength;
    }
    try {
      return encoder.encode(JSON.stringify(value)).byteLength;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
