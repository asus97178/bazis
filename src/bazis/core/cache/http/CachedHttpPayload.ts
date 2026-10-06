import { CacheValueError } from "../errors/CacheError";

/** Headers that must not be stored or replayed from output cache. */
const STRIP_RESPONSE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "www-authenticate",
]);

export function stripSensitiveResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      next[key] = value;
    }
  }
  return next;
}

/** Serialized HTTP response stored in {@link ICache}. */
export interface CachedHttpPayload {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface CachedHttpPayloadReadOptions {
  /** Default 16 MiB. Set to 0 only for an explicit unbounded compatibility path. */
  readonly maxBodyBytes?: number;
  /** Total materialization timeout. Default 5000ms; 0 disables it. */
  readonly bodyReadTimeoutMs?: number;
}

export interface ResolvedCachedHttpPayloadReadOptions {
  readonly maxBodyBytes: number;
  readonly bodyReadTimeoutMs: number;
}

export const DEFAULT_OUTPUT_CACHE_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_OUTPUT_CACHE_BODY_READ_TIMEOUT_MS = 5_000;

export function resolveCachedHttpPayloadReadOptions(
  options: CachedHttpPayloadReadOptions = {},
): ResolvedCachedHttpPayloadReadOptions {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_OUTPUT_CACHE_MAX_BODY_BYTES;
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_OUTPUT_CACHE_BODY_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new CacheValueError("output cache maxBodyBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(bodyReadTimeoutMs) || bodyReadTimeoutMs < 0) {
    throw new CacheValueError("output cache bodyReadTimeoutMs must be a non-negative safe integer");
  }
  return Object.freeze({ maxBodyBytes, bodyReadTimeoutMs });
}

/**
 * Dynamic response directives always win over decorator metadata. This keeps
 * authentication/session responses and application-declared private responses
 * out of shared server caches.
 */
export function responseAllowsServerCache(
  response: Response,
  configuredVaryHeaders: readonly string[] = [],
): boolean {
  if (response.headers.has("set-cookie")) {
    return false;
  }

  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  const directives = cacheControl.split(",").map((part) => part.trim().split("=", 1)[0]);
  if (directives.includes("no-store") || directives.includes("private")) {
    return false;
  }

  const vary = response.headers.get("vary");
  if (vary === null || vary.trim().length === 0) {
    return true;
  }
  const allowed = new Set(configuredVaryHeaders.map((name) => name.trim().toLowerCase()));
  for (const name of vary.split(",").map((part) => part.trim().toLowerCase())) {
    if (name === "*" || name.length === 0 || !allowed.has(name)) {
      return false;
    }
  }
  return true;
}

export async function responseToCachedPayload(
  response: Response,
  options: CachedHttpPayloadReadOptions | ResolvedCachedHttpPayloadReadOptions = {},
): Promise<CachedHttpPayload | undefined> {
  const limits = resolveCachedHttpPayloadReadOptions(options);
  const advertised = Number(response.headers.get("content-length"));
  if (limits.maxBodyBytes > 0 && Number.isFinite(advertised) && advertised > limits.maxBodyBytes) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!STRIP_RESPONSE_HEADERS.has(lower)) {
      headers[lower] = value;
    }
  });
  if (response.body === null) {
    return { status: response.status, headers, body: new Uint8Array() };
  }

  let clone: ReturnType<Response["clone"]>;
  try {
    // Read a tee so an over-limit/slow response remains available to the
    // caller and is merely skipped by the cache.
    clone = response.clone();
  } catch {
    return undefined;
  }
  const body = await readBoundedBody(clone.body as unknown as CacheReadableBody | null, limits);
  if (body === undefined) {
    return undefined;
  }
  // The cached payload replaces the original response. Release its tee branch
  // after the clone has been fully materialized.
  await response.body.cancel().catch(() => undefined);
  return { status: response.status, headers, body };
}

export function cachedPayloadToResponse(payload: CachedHttpPayload): Response {
  return new Response(payload.body as unknown as ConstructorParameters<typeof Response>[0], {
    status: payload.status,
    headers: stripSensitiveResponseHeaders(payload.headers),
  });
}

const BODY_READ_TIMEOUT = Symbol("output-cache-body-read-timeout");

async function readBoundedBody(
  body: CacheReadableBody | null,
  options: ResolvedCachedHttpPayloadReadOptions,
): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = options.bodyReadTimeoutMs === 0
    ? undefined
    : performance.now() + options.bodyReadTimeoutMs;
  try {
    while (true) {
      const item = await readBeforeDeadline(reader, deadline);
      if (item === BODY_READ_TIMEOUT) {
        void reader.cancel("output cache body read timed out").catch(() => undefined);
        return undefined;
      }
      if (item.done) break;
      total += item.value.byteLength;
      if (options.maxBodyBytes > 0 && total > options.maxBodyBytes) {
        void reader.cancel("output cache body exceeds maxBodyBytes").catch(() => undefined);
        return undefined;
      }
      chunks.push(item.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBeforeDeadline(
  reader: CacheBodyReader,
  deadline: number | undefined,
): Promise<CacheBodyReadResult | typeof BODY_READ_TIMEOUT> {
  if (deadline === undefined) return reader.read();
  const remaining = deadline - performance.now();
  if (remaining <= 0) return BODY_READ_TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof BODY_READ_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(BODY_READ_TIMEOUT), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type CacheBodyReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };

interface CacheBodyReader {
  read(): Promise<CacheBodyReadResult>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

interface CacheReadableBody {
  getReader(): CacheBodyReader;
}
