import { PRINCIPAL_STATE_KEY, type HttpContext, type RequestPrincipal } from "../../http";
import { createHash } from "node:crypto";
import type { ResolvedOutputCacheOptions } from "../internal/resolveCachePolicy";

/**
 * Ключ `ctx.state` с принципалом запроса. Совпадает с {@link PRINCIPAL_STATE_KEY}
 * ядра, поэтому `varyByUser`/`unlessAuthenticated` видят того же субъекта, что
 * кладёт слой аутентификации.
 */
export const OUTPUT_CACHE_PRINCIPAL_STATE_KEY = PRINCIPAL_STATE_KEY;

function appendQueryParts(
  parts: CacheKeyPart[],
  url: URL,
  keys: readonly string[] | "*",
): void {
  if (keys === "*") {
    const names = [...new Set(url.searchParams.keys())].sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      parts.push(["query", name, url.searchParams.getAll(name)]);
    }
    return;
  }
  for (const name of keys) {
    const values = url.searchParams.getAll(name);
    if (values.length > 0) {
      parts.push(["query", name, values]);
    }
  }
}

function appendRouteParts(
  parts: CacheKeyPart[],
  params: HttpContext["params"],
  keys: readonly string[],
): void {
  for (const name of keys) {
    const value = params[name];
    if (value !== undefined) {
      parts.push(["route", name, value]);
    }
  }
}

function appendHeaderParts(
  parts: CacheKeyPart[],
  ctx: HttpContext,
  keys: readonly string[],
): void {
  for (const name of keys) {
    const value = ctx.header(name);
    if (value !== undefined) {
      parts.push(["header", name.toLowerCase(), value]);
    }
  }
}

function appendUserPart(parts: CacheKeyPart[], ctx: HttpContext, varyByUser: boolean, varyByClaim?: string): void {
  const principal = ctx.state.get(OUTPUT_CACHE_PRINCIPAL_STATE_KEY) as RequestPrincipal | undefined;
  if (varyByUser) {
    parts.push(["user", principal === undefined ? "anonymous" : "authenticated", principal?.subject ?? ""]);
  }
  if (varyByClaim !== undefined) {
    parts.push([
      "claim",
      varyByClaim,
      principal === undefined ? "anonymous" : "authenticated",
      principal?.findFirst?.(varyByClaim) ?? "",
    ]);
  }
}

/** Authenticated requests need every configured identity component to exist. */
export function canBuildPersonalizedOutputCacheKey(
  ctx: HttpContext,
  options: {
    readonly varyByUser?: boolean;
    readonly varyByClaim?: string;
    readonly allowAuthenticatedShared?: boolean;
  },
): boolean {
  if (options.varyByClaim !== undefined && options.varyByClaim.trim().length === 0) {
    return false;
  }
  const principal = ctx.state.get(OUTPUT_CACHE_PRINCIPAL_STATE_KEY) as RequestPrincipal | undefined;
  if (principal === undefined) return true;
  if (
    options.varyByUser !== true
    && options.varyByClaim === undefined
    && options.allowAuthenticatedShared !== true
  ) {
    return false;
  }
  if (
    options.varyByUser === true
    && (typeof principal.subject !== "string" || principal.subject.trim().length === 0)
  ) {
    return false;
  }
  if (options.varyByClaim !== undefined) {
    const claim = principal.findFirst?.(options.varyByClaim);
    if (typeof claim !== "string" || claim.trim().length === 0) {
      return false;
    }
  }
  return true;
}

type CacheKeyPart = readonly [kind: string, ...values: readonly (string | number | boolean | readonly string[])[]];

/**
 * Cache keys can contain credentials, subject identifiers and arbitrary query
 * values. Keep those values out of memory listings/Redis keyspace and use a
 * collision-resistant digest over an unambiguous JSON tuple representation.
 */
function digestKey(parts: readonly CacheKeyPart[]): string {
  return `http:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Builds a deterministic output-cache key for the request. */
export function buildOutputCacheKey(
  ctx: HttpContext,
  routeName: string,
  options: ResolvedOutputCacheOptions,
): string {
  // Runtime class names are not globally unique (dynamic modules can contain
  // two same-named controllers). The concrete path is an independent route
  // identity component and also prevents accidental sharing across route-param
  // values when varyByRoute was omitted.
  const parts: CacheKeyPart[] = [
    ["action", ctx.method.toUpperCase(), routeName],
    ["origin", ctx.url.origin],
    ["path", ctx.url.pathname],
  ];

  // Query is part of the safe default identity. `[]` is the explicit opt-out
  // for an endpoint whose representation is proven query-independent.
  appendQueryParts(parts, ctx.url, options.varyByQuery ?? "*");
  if (options.varyByRoute !== undefined) {
    appendRouteParts(parts, ctx.params, options.varyByRoute);
  }
  if (options.varyByHeader !== undefined) {
    appendHeaderParts(parts, ctx, options.varyByHeader);
  }
  if (options.varyByUser === true || options.varyByClaim !== undefined) {
    appendUserPart(parts, ctx, options.varyByUser === true, options.varyByClaim);
  }

  if (ctx.apiVersion !== undefined) {
    parts.push(["version", ctx.apiVersion]);
  }

  return digestKey(parts);
}
