import { describe, expect, test } from "bun:test";
import { Authorize, Controller, Get, HttpContext } from "@/core/http";
import { guardInsecureOutputCacheRoute, OutputCache } from "@/core/cache";
import {
  buildOutputCacheKey,
  canBuildPersonalizedOutputCacheKey,
  OUTPUT_CACHE_PRINCIPAL_STATE_KEY,
} from "@/core/cache/http/buildOutputCacheKey";
import {
  resolveCachedHttpPayloadReadOptions,
  responseAllowsServerCache,
  responseToCachedPayload,
} from "@/core/cache/http/CachedHttpPayload";
import { resolveOutputClientCacheOptions } from "@/core/cache/http/applyClientCacheHeaders";
import type { ResolvedOutputCacheOptions } from "@/core/cache/internal/resolveCachePolicy";

@Controller("secure")
@Authorize(() => true)
class SecureCatalogController {
  @Get("items")
  @OutputCache({ seconds: 60 })
  list() {
    return { items: [] };
  }

  @Get("safe")
  @OutputCache({ seconds: 60, varyByUser: true })
  safe() {
    return { ok: true };
  }
}

describe("outputCacheSecurityWarning", () => {
  test("throws by default on @Authorize route without varyByUser", () => {
    expect(() =>
      guardInsecureOutputCacheRoute(
        SecureCatalogController,
        "list",
        { seconds: 60 },
      ),
    ).toThrow("responses may leak between users");
  });

  test("can warn on @Authorize route without varyByUser in compatibility mode", () => {
    const warnings: string[] = [];
    guardInsecureOutputCacheRoute(
      SecureCatalogController,
      "list",
      { seconds: 60 },
      { behavior: "warn", warn: (message: string) => warnings.push(message) },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SecureCatalogController.list");
    expect(warnings[0]).toContain("varyByUser");
  });

  test("silent when varyByUser is set", () => {
    const warnings: string[] = [];
    guardInsecureOutputCacheRoute(
      SecureCatalogController,
      "safe",
      { seconds: 60, varyByUser: true },
      { warn: (message: string) => warnings.push(message) },
    );
    expect(warnings).toHaveLength(0);
  });
});

function cacheContext(url: string): HttpContext {
  const parsed = new URL(url);
  return new HttpContext(new Request(parsed.href), parsed, {}, {} as never);
}

const keyOptions = {
  enabled: true,
  seconds: 60,
  varyByQuery: ["x", "y"],
} as ResolvedOutputCacheOptions;

describe("output cache key isolation", () => {
  test("uses an unambiguous representation for delimiter-like values", () => {
    const embedded = buildOutputCacheKey(
      cacheContext("https://example.test/items?x=a%7Cquery%3Ay%3Db"),
      "items",
      keyOptions,
    );
    const separate = buildOutputCacheKey(
      cacheContext("https://example.test/items?x=a&y=b"),
      "items",
      keyOptions,
    );
    expect(embedded).not.toBe(separate);
    expect(embedded).not.toContain("query");
    expect(embedded).not.toContain("a%7C");
  });

  test("includes every repeated query value", () => {
    const one = buildOutputCacheKey(cacheContext("https://example.test/items?x=a"), "items", keyOptions);
    const two = buildOutputCacheKey(cacheContext("https://example.test/items?x=a&x=b"), "items", keyOptions);
    expect(one).not.toBe(two);
  });

  test("varies by every query value by default and requires an explicit empty-list opt-out", () => {
    const first = cacheContext("https://example.test/items?a=1");
    const second = cacheContext("https://example.test/items?a=2");
    const safeDefault = { enabled: true, seconds: 60 } as ResolvedOutputCacheOptions;
    expect(buildOutputCacheKey(first, "items", safeDefault)).not.toBe(
      buildOutputCacheKey(second, "items", safeDefault),
    );

    const intentionalShared = { ...safeDefault, varyByQuery: [] } as ResolvedOutputCacheOptions;
    expect(buildOutputCacheKey(first, "items", intentionalShared)).toBe(
      buildOutputCacheKey(second, "items", intentionalShared),
    );
  });

  test("isolates identical routes served for different origins", () => {
    const first = buildOutputCacheKey(cacheContext("https://tenant-a.test/items?x=a"), "items", keyOptions);
    const second = buildOutputCacheKey(cacheContext("https://tenant-b.test/items?x=a"), "items", keyOptions);
    expect(first).not.toBe(second);
  });

  test("distinguishes anonymous users and refuses incomplete authenticated identities", () => {
    const anonymous = cacheContext("https://example.test/items");
    const literalAnon = cacheContext("https://example.test/items");
    literalAnon.state.set(OUTPUT_CACHE_PRINCIPAL_STATE_KEY, { subject: "anon" });
    const options = { ...keyOptions, varyByUser: true } as ResolvedOutputCacheOptions;
    expect(buildOutputCacheKey(anonymous, "items", options)).not.toBe(
      buildOutputCacheKey(literalAnon, "items", options),
    );

    const subjectless = cacheContext("https://example.test/items");
    subjectless.state.set(OUTPUT_CACHE_PRINCIPAL_STATE_KEY, {});
    expect(canBuildPersonalizedOutputCacheKey(subjectless, options)).toBe(false);
    expect(canBuildPersonalizedOutputCacheKey(subjectless, { varyByClaim: "tenant" })).toBe(false);

    const blankTenant = cacheContext("https://example.test/items");
    blankTenant.state.set(OUTPUT_CACHE_PRINCIPAL_STATE_KEY, {
      subject: "user-1",
      findFirst: () => "   ",
    });
    expect(canBuildPersonalizedOutputCacheKey(blankTenant, { varyByClaim: "tenant" })).toBe(false);
    expect(canBuildPersonalizedOutputCacheKey(anonymous, { varyByClaim: "   " })).toBe(false);

    const authenticatedPublicRoute = cacheContext("https://example.test/items");
    authenticatedPublicRoute.state.set(OUTPUT_CACHE_PRINCIPAL_STATE_KEY, { subject: "user-1" });
    expect(canBuildPersonalizedOutputCacheKey(authenticatedPublicRoute, {})).toBe(false);
    expect(canBuildPersonalizedOutputCacheKey(authenticatedPublicRoute, {
      allowAuthenticatedShared: true,
    })).toBe(true);
  });
});

describe("dynamic response cache policy", () => {
  test("rejects session and explicitly private responses", () => {
    expect(responseAllowsServerCache(new Response("ok", { headers: { "Set-Cookie": "sid=secret" } }))).toBe(false);
    expect(responseAllowsServerCache(new Response("ok", { headers: { "Cache-Control": "private" } }))).toBe(false);
    expect(responseAllowsServerCache(new Response("ok", { headers: { "Cache-Control": "no-store" } }))).toBe(false);
  });

  test("requires response Vary headers to be represented in the key", () => {
    const response = new Response("ok", { headers: { Vary: "Accept-Language" } });
    expect(responseAllowsServerCache(response)).toBe(false);
    expect(responseAllowsServerCache(response, ["accept-language"])).toBe(true);
    expect(responseAllowsServerCache(new Response("ok", { headers: { Vary: "*" } }), ["*"])).toBe(false);
  });

  test("bounds response materialization without consuming an oversized response", async () => {
    const advertised = new Response("abcdef", { headers: { "content-length": "6" } });
    expect(await responseToCachedPayload(advertised, { maxBodyBytes: 4 })).toBeUndefined();
    expect(await advertised.text()).toBe("abcdef");

    const streamed = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
        controller.enqueue(new TextEncoder().encode("efgh"));
        controller.close();
      },
    }));
    expect(await responseToCachedPayload(streamed, { maxBodyBytes: 4 })).toBeUndefined();
    expect(await streamed.text()).toBe("abcdefgh");
  });

  test("times out a non-terminating response body and keeps the original stream available", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    const startedAt = performance.now();
    expect(await responseToCachedPayload(response, {
      maxBodyBytes: 1024,
      bodyReadTimeoutMs: 15,
    })).toBeUndefined();
    expect(performance.now() - startedAt).toBeLessThan(250);
    await response.body?.cancel();
  });

  test("validates output body bounds before middleware execution", () => {
    expect(() => resolveCachedHttpPayloadReadOptions({ maxBodyBytes: -1 })).toThrow("maxBodyBytes");
    expect(() => resolveCachedHttpPayloadReadOptions({ bodyReadTimeoutMs: 1.5 })).toThrow("bodyReadTimeoutMs");
  });

  test("never marks a personalized response public in shared client caches", () => {
    expect(() => resolveOutputClientCacheOptions({
      varyByUser: true,
      clientCache: { public: true, maxAge: 60 },
    })).toThrow("personalized output cache");
    expect(resolveOutputClientCacheOptions({
      varyByClaim: "tenant",
      clientCache: { maxAge: 60 },
    })).toEqual({ public: false, private: true, maxAge: 60 });
    expect(() => resolveOutputClientCacheOptions({ varyByClaim: "   " })).toThrow("varyByClaim");
  });
});
