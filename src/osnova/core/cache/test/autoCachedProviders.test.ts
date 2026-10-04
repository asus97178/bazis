import { describe, expect, test } from "bun:test";
import {
  Cacheable,
  CacheableRedis,
  DistributedCache,
  NamedCacheRegistry,
  DISTRIBUTED_SERVICE_CACHE,
  autoCachedScoped,
  autoCachedSingleton,
  cachedScoped,
  cachedSingleton,
  DEFAULT_OUTPUT_CACHE_METHODS,
  DEFAULT_OUTPUT_CACHE_STATUS_CODES,
  memory,
  jsonCacheCodec,
  type IDistributedCache,
} from "@/core/cache";
import { createContainer, Module, createToken, singletonValue } from "@/core/di";
import {
  DEFAULT_CACHEABLE_METHODS,
  DEFAULT_CACHEABLE_STATUS_CODES,
} from "@/core/cache/internal/resolveCachePolicy";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

function distributedRegistry(): NamedCacheRegistry<IDistributedCache> {
  const cache = new DistributedCache(new InMemoryCacheDriver(), jsonCacheCodec, {
    connectionName: "default",
    keyPrefix: "auto:",
    namespace: "svc:",
    defaultLockSeconds: 5,
  });
  return new NamedCacheRegistry(new Map([["default", cache]]));
}

interface IMemoryCounter {
  next(): number;
}

const IMemoryCounter = createToken<IMemoryCounter>("IMemoryCounter");

class MemoryCounter implements IMemoryCounter {
  private value = 0;

  @Cacheable({ seconds: 60, key: () => "n" })
  next(): number {
    this.value += 1;
    return this.value;
  }
}

interface IHybridCounter {
  byMemory(id: number): number;
  byRedis(id: number): Promise<number>;
}

const IHybridCounter = createToken<IHybridCounter>("IHybridCounter");

let hybridMemoryCalls = 0;
let hybridRedisCalls = 0;

class HybridCounter implements IHybridCounter {
  @Cacheable({ seconds: 60, key: (...args: readonly unknown[]) => String(args[0]) })
  byMemory(id: number): number {
    hybridMemoryCalls += 1;
    return id * 2;
  }

  @CacheableRedis({ seconds: 60, key: (...args: readonly unknown[]) => String(args[0]) })
  async byRedis(id: number): Promise<number> {
    hybridRedisCalls += 1;
    return id * 3;
  }
}

describe("autoCached providers", () => {
  test("deprecated compatibility aliases point to canonical exports", () => {
    expect(autoCachedScoped).toBe(cachedScoped);
    expect(autoCachedSingleton).toBe(cachedSingleton);
    expect(DEFAULT_CACHEABLE_METHODS).toBe(DEFAULT_OUTPUT_CACHE_METHODS);
    expect(DEFAULT_CACHEABLE_STATUS_CODES).toBe(DEFAULT_OUTPUT_CACHE_STATUS_CODES);
  });

  test("autoCachedScoped uses memory cache when no distributed backend is registered", () => {
    const cacheModuleRef = memory();
    @Module({
      imports: [cacheModuleRef],
      providers: [autoCachedScoped(IMemoryCounter, MemoryCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const counter = container.createScope().resolve(IMemoryCounter);

    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(1);
  });

  test("cachedScoped preserves explicitly keyed sharing across request scopes", () => {
    let calls = 0;
    class ScopedCounter {
      @Cacheable({ seconds: 60, key: () => "same" })
      next(): number {
        calls += 1;
        return calls;
      }
    }
    const Counter = createToken<ScopedCounter>("ScopedCounter");
    const cacheModuleRef = memory();
    @Module({
      imports: [cacheModuleRef],
      providers: [cachedScoped(Counter, ScopedCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const first = container.createScope().resolve(Counter);
    const second = container.createScope().resolve(Counter);
    expect(first.next()).toBe(1);
    expect(first.next()).toBe(1);
    expect(second.next()).toBe(1);
  });

  test("cachedScoped isolates automatic argument keys across request scopes", () => {
    let calls = 0;
    class ScopedCounter {
      @Cacheable({ seconds: 60 })
      next(value: number): number {
        calls += 1;
        return value + calls;
      }
    }
    const Counter = createToken<ScopedCounter>("ImplicitScopedCounter");
    const cacheModuleRef = memory();
    @Module({ imports: [cacheModuleRef], providers: [cachedScoped(Counter, ScopedCounter)] })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const first = container.createScope().resolve(Counter);
    const second = container.createScope().resolve(Counter);
    expect(first.next(10)).toBe(11);
    expect(first.next(10)).toBe(11);
    expect(second.next(10)).toBe(12);
  });

  test("autoCachedScoped uses the distributed tier when a service cache is registered", async () => {
    hybridMemoryCalls = 0;
    hybridRedisCalls = 0;

    const cacheModuleRef = memory();

    @Module({
      imports: [cacheModuleRef],
      providers: [
        singletonValue(DISTRIBUTED_SERVICE_CACHE, distributedRegistry()),
        autoCachedScoped(IHybridCounter, HybridCounter),
      ],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const counter = container.createScope().resolve(IHybridCounter);

    expect(counter.byMemory(2)).toBe(4);
    expect(counter.byMemory(2)).toBe(4);
    expect(hybridMemoryCalls).toBe(1);

    expect(await counter.byRedis(2)).toBe(6);
    expect(await counter.byRedis(2)).toBe(6);
    expect(hybridRedisCalls).toBe(1);
  });

  test("autoCachedSingleton caches through interface token", () => {
    const cacheModuleRef = memory({ maxEntries: 100 });
    @Module({
      imports: [cacheModuleRef],
      providers: [autoCachedSingleton(IMemoryCounter, MemoryCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const counter = container.resolve(IMemoryCounter);

    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(1);
  });
});
