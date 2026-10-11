import type { CachedHttpPayload } from "../http/CachedHttpPayload";
import type { CacheCodec } from "./CacheCodec";
import { CacheValueError } from "../errors/CacheError";

/**
 * JSON codec for service values (`@CacheableRedis`, `IDistributedCache`). It
 * refuses a value that JSON would change on the way back — a Date comes back
 * as a string, a Set or Map as `{}` — instead of returning altered data on a
 * cache hit.
 */
export const jsonCacheCodec: CacheCodec<unknown> = {
  serialize: (value) => {
    const problem = notPlainJson(value, "value", new Set());
    if (problem !== undefined) {
      throw new CacheValueError(`Cache value is not plain JSON: ${problem}. Return plain data (an ISO string for a date, an array for a set), or cache it in memory with @Cacheable.`);
    }
    return JSON.stringify(value);
  },
  deserialize: (raw) => JSON.parse(raw) as unknown,
};

/** Where `value` stops surviving JSON unchanged, or undefined when it does. */
function notPlainJson(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${path} is ${String(value)} (JSON writes null)`;
  if (typeof value === "bigint") return `${path} is a bigint`;
  if (typeof value !== "object") return `${path} is a ${typeof value}`;
  if (seen.has(value)) return `${path} is a circular reference`;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (item === undefined) return `${path}[${index}] is undefined (JSON writes null)`;
        const problem = notPlainJson(item, `${path}[${index}]`, seen);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name || "object with a prototype";
      return `${path} is a ${name}${value instanceof Date ? " (JSON returns a string)" : value instanceof Map || value instanceof Set ? " (JSON returns {})" : ""}`;
    }
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;                 // dropped and read back as undefined
      const problem = notPlainJson(item, `${path}.${key}`, seen);
      if (problem !== undefined) return problem;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

interface SerializedHttpPayload {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly storedAt?: number;
}

/** Codec for HTTP output payloads — body is base64 because JSON cannot hold bytes. */
export const httpPayloadCacheCodec: CacheCodec<CachedHttpPayload> = {
  serialize: (payload) =>
    JSON.stringify({
      status: payload.status,
      headers: payload.headers,
      body: Buffer.from(payload.body).toString("base64"),
      ...(payload.storedAt !== undefined ? { storedAt: payload.storedAt } : {}),
    } satisfies SerializedHttpPayload),
  deserialize: (raw) => {
    const parsed = JSON.parse(raw) as SerializedHttpPayload;
    return {
      status: parsed.status,
      headers: parsed.headers,
      body: Uint8Array.from(Buffer.from(parsed.body, "base64")),
      ...(typeof parsed.storedAt === "number" ? { storedAt: parsed.storedAt } : {}),
    };
  },
};
