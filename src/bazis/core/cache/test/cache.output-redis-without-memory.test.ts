import { describe, expect, test } from "bun:test";
import { DI, Module } from "@/core/di";
import { Controller, Get } from "@/core/http";
import { startTestApp } from "@/core/testing";
import { memory } from "@/core/cache";
import {
  connectionCache,
  DISTRIBUTED_CACHE_BACKEND,
  DISTRIBUTED_OUTPUT_CACHE,
  DISTRIBUTED_SERVICE_CACHE,
  OutputRedisCache,
  type DistributedCacheSetOptions,
  type DistributedCacheStores,
  type IDistributedCache,
} from "@/core/cache";
import { NamedCacheRegistry } from "@/core/cache/distributed/NamedCacheRegistry";

// 0.100.4: @OutputRedisCache needs only the distributed backend of @Infra.
// On 0.100.3 it did nothing without `cache: memory()`, and without a backend
// it said nothing either; IDistributedCache.evictByTag left its responses.

/** A distributed store in memory: entries with tags, like the Redis one. */
class FakeStore implements IDistributedCache {
  readonly connectionName = "default";
  readonly keyPrefix = "test:";
  readonly entries = new Map<string, { value: unknown; tags: readonly string[] }>();
  async get<T>(key: string) { return this.entries.get(key)?.value as T | undefined; }
  async getOrCreateAsync<T>(key: string, factory: () => Promise<T | undefined>, options: DistributedCacheSetOptions) {
    const found = this.entries.get(key);
    if (found) return found.value as T;
    const value = await factory();
    if (value !== undefined) this.entries.set(key, { value, tags: options.tags ?? [] });
    return value;
  }
  async remove(key: string) { return this.entries.delete(key); }
  async evictByTag(tag: string) {
    let removed = 0;
    for (const [key, entry] of this.entries) if (entry.tags.includes(tag)) { this.entries.delete(key); removed += 1; }
    return removed;
  }
}

function stores(): DistributedCacheStores & { values: FakeStore; responses: FakeStore } {
  const values = new FakeStore(), responses = new FakeStore();
  return {
    values,
    responses,
    connectionNames: ["default"],
    outputCache: new NamedCacheRegistry(new Map([["default", responses as IDistributedCache<never>]])),
    serviceCache: new NamedCacheRegistry(new Map([["default", values]])),
    ping: async () => [{ connection: "default", healthy: true }],
  };
}

let calls = 0;

@Controller("prices")
class PricesController {
  @Get()
  @OutputRedisCache({ seconds: 60, tags: ["prices"] })
  list() {
    calls += 1;
    return { calls };
  }
}

DI.bindDeps(PricesController);

@Module({ controllers: [PricesController] })
class PricesModule {}

function backendModule(backend: DistributedCacheStores) {
  return {
    global: true,
    providers: [
      DI.singleton(DI.valueProvider(DISTRIBUTED_CACHE_BACKEND, backend)),
      DI.singleton(DI.valueProvider(DISTRIBUTED_OUTPUT_CACHE, backend.outputCache)),
      DI.singleton(DI.valueProvider(DISTRIBUTED_SERVICE_CACHE, backend.serviceCache)),
    ],
    exports: [DISTRIBUTED_CACHE_BACKEND, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE],
  };
}

describe("@OutputRedisCache without a cache module", () => {
  test("responses are served from the distributed store, and evictByTag of IDistributedCache drops them", async () => {
    calls = 0;
    const backend = stores();
    const app = await startTestApp(PricesModule, { http: {}, infra: backendModule(backend) });
    try {
      expect(await (await app.fetch("/prices")).json()).toEqual({ calls: 1 });
      const second = await app.fetch("/prices");
      expect(await second.json()).toEqual({ calls: 1 });
      expect(backend.responses.entries.size).toBe(1);

      // The cache services inject by type evicts the tag in values and responses.
      expect(await connectionCache(backend).evictByTag("prices")).toBe(1);
      expect(await (await app.fetch("/prices")).json()).toEqual({ calls: 2 });
    } finally {
      await app.stop();
    }
  });

  test("without a distributed backend the start fails and names the route", async () => {
    await expect(startTestApp(PricesModule, { http: {} })).rejects.toThrow(
      "@OutputRedisCache on PricesController.list requires a distributed backend",
    );
  });

  test("with a cache module but no distributed backend the start fails too, not the first request", async () => {
    await expect(startTestApp(PricesModule, { http: {}, cache: memory() })).rejects.toThrow(
      "@OutputRedisCache on PricesController.list requires a distributed backend",
    );
  });
});
