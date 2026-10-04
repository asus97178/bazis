import { describe, expect, test } from "bun:test";
import {
  Cacheable, CacheableRedis, CacheCapacityError, CacheValueError, DEFAULT_MAX_IN_FLIGHT,
  ICache, MemoryCache, cachedSingleton, memory, DistributedCache, NamedCacheRegistry,
  DISTRIBUTED_SERVICE_CACHE, jsonCacheCodec,
} from "../index";
import { DI, ServiceCollection, ServiceValidationError, createContainer, createToken, singleton, singletonValue } from "../../di";
import { registerGeneratedClassDeps, restoreGeneratedClassDeps, snapshotGeneratedClassDeps } from "../../di/module/autoDeps";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("architecture: cached class activation", () => {
  test.each(["bound", "static", "generated", "explicit"] as const)("uses normal constructor precedence: %s", async (kind) => {
    class Dependency { readonly value = "ready"; }
    class Consumer {
      constructor(readonly dependency: Dependency) {}
      @Cacheable({ seconds: 30 }) get() { return this.dependency.value; }
    }
    const snapshot = snapshotGeneratedClassDeps();
    const cache = memory();
    const definition = kind === "explicit" ? singleton(Consumer, Consumer, [Dependency]) : singleton(Consumer);
    if (kind === "bound") DI.bindDeps(Consumer, Dependency);
    if (kind === "static") Object.assign(Consumer, { inject: [Dependency] });
    // Deliberately publish after creating both the module and cached provider.
    if (kind === "generated") registerGeneratedClassDeps(Consumer, ["Dependency"]);
    try {
      const container = createContainer({ imports: [cache], providers: [singleton(Dependency), definition] }, { validateOnBuild: true });
      expect(container.resolve(Consumer).get()).toBe("ready");
      expect(container.resolve(Consumer).dependency).toBe(container.resolve(Dependency));
      await container.dispose();
    } finally { restoreGeneratedClassDeps(snapshot); }
  });

  test("keeps direct ServiceCollection activation, async deps and ownership", async () => {
    const input = createToken<string>("AsyncInput");
    let disposed = 0;
    class Consumer {
      constructor(readonly input: string) {}
      @Cacheable({ seconds: 30 }) get() { return this.input; }
      dispose() { disposed++; }
    }
    const cache = memory();
    DI.bindDeps(Consumer, input);
    const collection = new ServiceCollection().addMany(cache.providers!)
      .addSingleton(DI.asyncFactoryProvider(input, [], async () => "async"))
      .addSingleton(DI.classProvider(Consumer, Consumer));
    const container = collection.buildServiceProvider({ validateOnBuild: true });
    expect((await container.resolveAsync(Consumer)).get()).toBe("async");
    await container.dispose();
    expect(disposed).toBe(1);

    const external = createContainer({ imports: [cache], providers: [singletonValue(input, "external"), DI.singleton(DI.externallyOwned(DI.classProvider(Consumer, Consumer)))] });
    external.resolve(Consumer);
    await external.dispose();
    expect(disposed).toBe(1);
  });

  test("missing constructor metadata fails before a cached service can be used", () => {
    class Missing {
      constructor(readonly required: object) {}
      @Cacheable({ seconds: 30 }) get() { return this.required; }
    }
    const cache = memory();
    expect(() => createContainer({ imports: [cache], providers: [singleton(Missing)] }, { validateOnBuild: true })).toThrow(ServiceValidationError);
  });

  test("isolates multiple singleton/keyed registrations of the same class in both cache tiers", async () => {
    class Catalog {
      constructor(readonly source: string) {}
      @Cacheable({ seconds: 30 }) get(id: number) { return `${this.source}:${id}`; }
      @CacheableRedis({ seconds: 30 }) async distributed(id: number) { return `${this.source}:${id}`; }
    }
    const a = createToken<Catalog>("Catalog");
    const b = createToken<Catalog>("Catalog"); // Same diagnostic name, distinct identity.
    const sourceA = createToken<string>("SourceA");
    const sourceB = createToken<string>("SourceB");
    const driver = new InMemoryCacheDriver();
    const distributed = new DistributedCache(driver, jsonCacheCodec, { connectionName: "default", keyPrefix: "test:", defaultLockSeconds: 1 });
    const container = createContainer({
      imports: [memory()],
      providers: [
        singletonValue(sourceA, "A"), singletonValue(sourceB, "B"),
        singletonValue(DISTRIBUTED_SERVICE_CACHE, new NamedCacheRegistry(new Map([["default", distributed]]))),
        cachedSingleton(a, Catalog, [sourceA]), cachedSingleton(b, Catalog, [sourceB]),
        DI.keyedSingleton("keyed", DI.classProvider(a, Catalog, [sourceB])),
      ],
    }, { validateOnBuild: true });
    for (const method of ["get", "distributed"] as const) {
      expect(await container.resolve(a)[method](7)).toBe("A:7");
      expect(await container.resolve(b)[method](7)).toBe("B:7");
      expect(await container.resolveKeyed(a, "keyed")[method](7)).toBe("B:7");
      expect(await container.resolve(a)[method](7)).toBe("A:7");
    }
    await container.dispose();
  });
});

describe("architecture: bounded cache factories", () => {
  test("bounds pending work independently of resident LRU entries and deduplicates at capacity", async () => {
    const cache = new MemoryCache<string>({ maxEntries: 1, maxInFlight: 2 });
    const a = deferred<string>();
    const b = deferred<string>();
    const first = cache.getOrCreateAsync("a", () => a.promise);
    const second = cache.getOrCreateAsync("b", () => b.promise);
    expect(cache.size).toBe(0);
    let calls = 0;
    expect(() => cache.getOrCreate("c", () => { calls++; return "no"; })).toThrow(CacheCapacityError);
    const shared = cache.getOrCreateAsync("a", async () => { calls++; return "no"; });
    cache.set("hit", "cached");
    expect(cache.getOrCreate("hit", () => "no")).toBe("cached");
    expect(calls).toBe(0);
    a.resolve("A"); b.resolve("B");
    expect(await Promise.all([first, second, shared])).toEqual(["A", "B", "A"]);
    expect(cache.getOrCreate("c", () => "C")).toBe("C");
    expect(cache.size).toBe(1);
  });

  test.each(["clear", "remove", "tag", "dispose"] as const)("invalidation does not release unfinished work: %s", async kind => {
    const cache = new MemoryCache<string>({ maxInFlight: 1 });
    const fill = deferred<string>();
    const pending = cache.getOrCreateAsync("key", () => fill.promise, { tags: ["tag"] });
    if (kind === "tag") cache.evictByTag("tag");
    else if (kind === "remove") cache.remove("key");
    else cache[kind]();
    expect(() => cache.getOrCreate("key", () => "replacement")).toThrow(CacheCapacityError);
    fill.resolve("stale");
    expect(await pending).toBe("stale");
    expect(cache.get("key")).toBeUndefined();
    expect(cache.getOrCreate("fresh", () => "fresh")).toBe("fresh");
  });

  test("releases capacity after synchronous throws and asynchronous rejection", async () => {
    const cache = new MemoryCache<string>({ maxInFlight: 1 });
    expect(() => cache.getOrCreate("bad", () => { throw new Error("sync"); })).toThrow("sync");
    const fill = deferred<string>();
    const pending = cache.getOrCreateAsync("bad", () => fill.promise);
    fill.reject(new Error("async"));
    await expect(pending).rejects.toThrow("async");
    expect(cache.getOrCreate("ok", () => "ok")).toBe("ok");
  });

  test("validates maxInFlight and forwards memory() options", async () => {
    for (const maxInFlight of [0, -1, 1.5, NaN, Infinity, null]) {
      expect(() => new MemoryCache({ maxInFlight: maxInFlight as number })).toThrow(CacheValueError);
    }
    const container = createContainer({ imports: [memory({ maxInFlight: 1 })] });
    const cache = container.resolve(ICache);
    const fill = deferred<unknown>();
    const pending = cache.getOrCreateAsync("one", () => fill.promise);
    expect(() => cache.getOrCreate("two", () => "two")).toThrow(CacheCapacityError);
    fill.resolve("done"); await pending;
    await container.dispose();
    expect(DEFAULT_MAX_IN_FLIGHT).toBe(1024);
  });
});
