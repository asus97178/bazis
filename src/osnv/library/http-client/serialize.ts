import type { CorrelationPropagation, HeaderBag, RequestParams } from "./types";

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Resolves `url` against `baseUrl`, **preserving the base path prefix**.
 * Unlike raw `new URL(url, base)` (where a leading-slash url discards the
 * prefix), `baseUrl: "https://api/v1"` + `"/users"` → `…/v1/users`.
 * Absolute URLs and missing baseUrl pass through.
 */
export function resolveUrl(baseUrl: string | undefined, url: string): string {
  if (!baseUrl || ABSOLUTE_URL.test(url)) {
    return url;
  }
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relative = url.startsWith("/") ? url.slice(1) : url;
  return new URL(relative, base).toString();
}

/** Default query serializer: skips nullish, expands arrays to repeated keys. */
export function defaultParamsSerializer(params: RequestParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && item !== undefined) {
          search.append(key, String(item));
        }
      }
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

/** Appends serialized params to a URL, respecting an existing query string. */
export function appendQuery(
  url: string,
  params: RequestParams | undefined,
  serializer: (params: RequestParams) => string = defaultParamsSerializer,
): string {
  if (!params) {
    return url;
  }
  const query = serializer(params);
  if (!query) {
    return url;
  }
  const fragmentIndex = url.indexOf("#");
  const address = fragmentIndex < 0 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : url.slice(fragmentIndex);
  return address + (address.includes("?") ? "&" : "?") + query + fragment;
}

/** True for values that fetch accepts as a raw body (not auto-JSON candidates). */
export function isBodyInit(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
    return true;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) {
    return true;
  }
  return false;
}

/** Builds an HTTP Basic `Authorization` header value (browser/Bun/Node safe). */
export function basicAuthHeader(username: string, password: string): string {
  const token = `${username}:${password}`;
  const env = globalThis as {
    btoa?: (input: string) => string;
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
  };
  const encoded = env.btoa ? env.btoa(token) : env.Buffer ? env.Buffer.from(token, "utf-8").toString("base64") : token;
  return `Basic ${encoded}`;
}

/** Lowercase-key merge: later bags win. */
export function mergeHeaderBags(...bags: (HeaderBag | undefined)[]): HeaderBag {
  const out: HeaderBag = {};
  for (const bag of bags) {
    if (!bag) {
      continue;
    }
    for (const [key, value] of Object.entries(bag)) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/** Whether correlation headers may be sent to the resolved URL under the policy. */
export function shouldPropagateCorrelation(
  url: string,
  policy: CorrelationPropagation,
  baseUrl: string | undefined,
): boolean {
  if (policy === "all") {
    return true;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (Array.isArray(policy)) {
    return policy.includes(host);
  }
  if (!baseUrl) {
    return false;
  }
  try {
    return new URL(baseUrl).origin === new URL(url).origin;
  } catch {
    return false;
  }
}
