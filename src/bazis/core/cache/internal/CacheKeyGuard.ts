import { CacheKeyError } from "../errors/CacheError";
import { DEFAULT_MAX_KEY_LENGTH } from "../types/CacheOptions";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const encoder = new TextEncoder();

/** Validates a cache key: type, length, prototype pollution protection. */
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

/** Estimates the size of a string value in UTF-8 bytes. */
export function measureStringBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Best-effort value size in bytes for the `maxValueBytes` limit.
 * Covers strings, binary buffers and HTTP payloads (via `body: Uint8Array`).
 * Returns `undefined` when the size cannot be measured; the limit is not applied then.
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
