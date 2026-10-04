import type { ClientCacheOptions } from "../types/CachePolicy";
import type { OutputCachePolicyFields } from "../types/CachePolicy";
import { CacheValueError } from "../errors/CacheError";

/** Validates client-cache directives and forces personalized responses private. */
export function resolveOutputClientCacheOptions(
  policy: Pick<OutputCachePolicyFields, "clientCache" | "varyByUser" | "varyByClaim">,
): ClientCacheOptions | undefined {
  if (policy.varyByClaim !== undefined && policy.varyByClaim.trim().length === 0) {
    throw new CacheValueError("output cache varyByClaim must be a non-empty string");
  }
  const options = policy.clientCache;
  if (options?.maxAge !== undefined && (!Number.isFinite(options.maxAge) || options.maxAge < 0)) {
    throw new CacheValueError("output cache clientCache.maxAge must be a non-negative finite number");
  }
  if (options?.public === true && options.private === true) {
    throw new CacheValueError("output cache clientCache cannot be both public and private");
  }
  const personalized = policy.varyByUser === true || policy.varyByClaim !== undefined;
  if (!personalized) return options;
  if (options?.public === true) {
    throw new CacheValueError("personalized output cache cannot use clientCache.public");
  }
  return Object.freeze({ ...(options ?? {}), public: false, private: true });
}

/** Applies client/proxy Cache-Control headers (ASP.NET Response Cache layer). */
export function applyClientCacheHeaders(
  response: Response,
  options: ClientCacheOptions | undefined,
): Response {
  if (options === undefined) {
    return response;
  }

  const directives: string[] = [];
  if (options.noCache === true) {
    directives.push("no-cache");
  }
  if (options.public === true) {
    directives.push("public");
  }
  if (options.private === true) {
    directives.push("private");
  }
  if (options.maxAge !== undefined) {
    directives.push(`max-age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  if (directives.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("cache-control", directives.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
