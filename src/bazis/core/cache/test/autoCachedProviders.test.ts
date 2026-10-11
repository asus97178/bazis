import { describe, expect, test } from "bun:test";
import {
  Cacheable,
  CacheableRedis,
  DistributedCache,
  NamedCacheRegistry,
  DISTRIBUTED_SERVICE_CACHE,
  memory,
  jsonCacheCodec,
  CacheDeclarationError,
  type IDistributedCache,
} from "@/core/cache";
import { createContainer, Module, createToken, DiError, scoped, singleton, singletonValue, transient } from "@/core/di";
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

describe("cached providers", () => {
  test("a scoped service with a keyed @Cacheable uses the memory cache when no distributed backend is registered", () => {
    const cacheModuleRef = memory();
    @Module({
      imports: [cacheModuleRef],
      providers: [scoped(IMemoryCounter, MemoryCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const counter = container.createScope().resolve(IMemoryCounter);

    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(1);
  });

  test("a scoped service shares explicitly keyed values across request scopes", () => {
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
      providers: [scoped(Counter, ScopedCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const first = container.createScope().resolve(Counter);
    const second = container.createScope().resolve(Counter);
    expect(first.next()).toBe(1);
    expect(first.next()).toBe(1);
    expect(second.next()).toBe(1);
  });

  test("a scoped service with @Cacheable without key is refused at startup (0.98.34)", () => {
    class ScopedCounter {
      @Cacheable({ seconds: 60 })
      next(value: number): number { return value; }
    }
    const Counter = createToken<ScopedCounter>("ImplicitScopedCounter");
    @Module({ imports: [memory()], providers: [scoped(Counter, ScopedCounter)] })
    class TestModule {}
    expect(() => createContainer(TestModule, { validateOnBuild: true })).toThrow(CacheDeclarationError);
    // A DI error: the start prints it as a configuration error, not a crash.
    expect(new CacheDeclarationError("x")).toBeInstanceOf(DiError);
    expect(() => createContainer(TestModule, { validateOnBuild: true })).toThrow(
      "ScopedCounter.next: @Cacheable without key on a scoped service caches only within one request (the automatic key belongs to the instance). Set key — include the user or tenant when the result depends on them — or register ScopedCounter as a singleton.",
    );
  });

  test("a transient service with @Cacheable is refused at startup (0.98.34)", () => {
    class TransientCounter {
      @Cacheable({ seconds: 60, key: () => "k" })
      next(): number { return 1; }
    }
    @Module({ imports: [memory()], providers: [transient(TransientCounter)] })
    class TestModule {}
    expect(() => createContainer(TestModule, { validateOnBuild: true })).toThrow(
      "TransientCounter uses @Cacheable but is registered transient: a new instance for every injection never reuses its cache. Register it as singleton or scoped.",
    );
  });

  test("a singleton keeps automatic keys across calls", () => {
    let calls = 0;
    class SingletonCounter {
      @Cacheable({ seconds: 60 })
      next(value: number): number { calls += 1; return value + calls; }
    }
    @Module({ imports: [memory()], providers: [singleton(SingletonCounter)] })
    class TestModule {}
    const container = createContainer(TestModule, { validateOnBuild: true });
    expect(container.resolve(SingletonCounter).next(10)).toBe(11);
    expect(container.resolve(SingletonCounter).next(10)).toBe(11);
  });

  test("a scoped service uses the distributed tier for @CacheableRedis when a service cache is registered", async () => {
    hybridMemoryCalls = 0;
    hybridRedisCalls = 0;

    const cacheModuleRef = memory();

    @Module({
      imports: [cacheModuleRef],
      providers: [
        singletonValue(DISTRIBUTED_SERVICE_CACHE, distributedRegistry()),
        scoped(IHybridCounter, HybridCounter),
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

  test("a singleton caches through an interface token", () => {
    const cacheModuleRef = memory({ maxEntries: 100 });
    @Module({
      imports: [cacheModuleRef],
      providers: [singleton(IMemoryCounter, MemoryCounter)],
    })
    class TestModule {}

    const container = createContainer(TestModule, { validateOnBuild: true });
    const counter = container.resolve(IMemoryCounter);

    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(1);
  });
});
