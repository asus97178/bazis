import { describe, expect, test } from "bun:test";
import { Module, singleton, singletonValue } from "@/core/di";
import { Controller, Get } from "@/core/http";
import { startTestApp } from "@/core/testing";
import {
  CacheableRedis, CacheUnavailableError, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE, DistributedCache, NamedCacheRegistry,
  OutputRedisCache, httpPayloadCacheCodec, jsonCacheCodec, memory, type CachedHttpPayload, type DistributedCacheDriver, type IDistributedCache,
} from "@/core/cache";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

// 0.98.34: a hung or failing distributed store must not hang or fail the
// caller. The cache-aside path computes the value; explicit operations throw.

/** Every operation never settles: a paused Redis with an open connection. */
const hung = new Proxy(new InMemoryCacheDriver(), {
  get: (target, property) => typeof (target as unknown as Record<PropertyKey, unknown>)[property] === "function"
    ? () => new Promise(() => {})
    : (target as unknown as Record<PropertyKey, unknown>)[property],
}) as DistributedCacheDriver;

/** Every operation fails at once: a refused connection. */
const refused = new Proxy(new InMemoryCacheDriver(), {
  get: (target, property) => typeof (target as unknown as Record<PropertyKey, unknown>)[property] === "function"
    ? () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379 password=hunter2"))
    : (target as unknown as Record<PropertyKey, unknown>)[property],
}) as DistributedCacheDriver;

const store = <T>(driver: DistributedCacheDriver, codec = jsonCacheCodec as never) =>
  new DistributedCache<T>(driver, codec, { connectionName: "default", keyPrefix: "t:", defaultLockSeconds: 5, operationTimeoutMs: 50 });

describe("DistributedCache with an unavailable store", () => {
  for (const [name, driver] of [["hung", hung], ["refused", refused]] as const) {
    test(`${name}: getOrCreateAsync computes the value within the timeout`, async () => {
      const cache = store<number>(driver);
      const started = performance.now();
      let calls = 0;
      expect(await cache.getOrCreateAsync("k", async () => ++calls, { ttlSeconds: 60 })).toBe(1);
      expect(await cache.getOrCreateAsync("k", async () => ++calls, { ttlSeconds: 60 })).toBe(2);
      expect(performance.now() - started).toBeLessThan(400);
    });

    test(`${name}: explicit operations throw CacheUnavailableError`, async () => {
      const cache = store<number>(driver);
      for (const operation of [() => cache.get("k"), () => cache.remove("k"), () => cache.evictByTag("t")]) {
        const error = await operation().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CacheUnavailableError);
        expect((error as Error).message).toStartWith('Distributed cache "default" ');
      }
    });
  }

  test("the timeout is named and validated", async () => {
    expect(() => new DistributedCache(new InMemoryCacheDriver(), jsonCacheCodec, { connectionName: "c", keyPrefix: "p", defaultLockSeconds: 1, operationTimeoutMs: 0 })).toThrow("operationTimeoutMs must be a positive integer of milliseconds");
    const error = await store<number>(hung).get("k").catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('Distributed cache "default" did not answer within 50 ms.');
  });
});

describe("decorators with an unavailable store", () => {
  test("@CacheableRedis returns the fresh value; @OutputRedisCache serves the route uncached", async () => {
    let serviceCalls = 0, routeCalls = 0;
    class Stock {
      @CacheableRedis({ seconds: 30, key: (sku) => `stock:${String(sku)}` })
      async count(sku: string) { serviceCalls++; return { sku, count: 5 }; }
    }
    @Controller("products")
    class ProductsController {
      @Get() @OutputRedisCache({ seconds: 60 })
      list() { routeCalls++; return { items: [1, 2] }; }
    }
    const service = new NamedCacheRegistry<IDistributedCache>(new Map([["default", store(hung)]]));
    const output = new NamedCacheRegistry<IDistributedCache<CachedHttpPayload>>(new Map([["default", store<CachedHttpPayload>(hung, httpPayloadCacheCodec as never)]]));
    @Module({ providers: [singletonValue(DISTRIBUTED_SERVICE_CACHE, service), singletonValue(DISTRIBUTED_OUTPUT_CACHE, output), singleton(Stock)], controllers: [ProductsController] })
    class App {}
    const app = await startTestApp(App, { cache: memory(), http: {} });
    try {
      const stock = app.container.resolve(Stock);
      expect(await stock.count("apple")).toEqual({ sku: "apple", count: 5 });
      expect(serviceCalls).toBe(1);
      const started = performance.now();
      const response = await app.fetch("/products");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [1, 2] });
      expect(routeCalls).toBe(1);
      expect(performance.now() - started).toBeLessThan(400);
    } finally {
      await app.stop();
    }
  });
});
