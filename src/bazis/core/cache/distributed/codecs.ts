import type { CachedHttpPayload } from "../http/CachedHttpPayload";
import type { CacheCodec } from "./CacheCodec";

/** JSON codec for arbitrary service values (`@Cacheable` distributed tier). */
export const jsonCacheCodec: CacheCodec<unknown> = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => JSON.parse(raw) as unknown,
};

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
