import { describe, expect, test } from "bun:test";
import {
  Cacheable,
  CacheableRedis,
  CacheError,
  DistributedCache,
  ICache,
  MemoryCache,
  NamedCacheRegistry,
  OutputRedisCache,
  jsonCacheCodec,
  wrapCachedService,
  type IDistributedCache,
} from "@/core/cache";
import { createRouteOutputCacheComposerWithOptions } from "@/core/cache/http/composeOutputCache";
import { Controller, Get } from "@/core/http";
import type { ActionMeta, ControllerMeta } from "@/core/http/Decorators/metadata";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

function serviceCache(driver = new InMemoryCacheDriver()): DistributedCache {
  return new DistributedCache(driver, jsonCacheCodec, {
    connectionName: "default",
    keyPrefix: "t:",
    namespace: "svc:",
    defaultLockSeconds: 5,
  });
}

function registryOf(cache: IDistributedCache): NamedCacheRegistry<IDistributedCache> {
  return new NamedCacheRegistry(new Map([["default", cache]]));
}

class FailOnceTagReadDriver extends InMemoryCacheDriver {
  public failNextTagRead = false;

  override async tagMembers(tagKey: string): Promise<readonly string[]> {
    if (this.failNextTagRead) {
      this.failNextTagRead = false;
      throw new Error("injected tag read failure");
    }
    return super.tagMembers(tagKey);
  }
}

class FailOnceTaggedDeleteDriver extends InMemoryCacheDriver {
  public failNextDelete = false;

  override async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected tagged delete failure");
    }
    return super.deleteIfValue(key, expectedValue);
  }
}

class FailingUnlockDriver extends InMemoryCacheDriver {
  override async releaseLock(): Promise<void> {
    throw new Error("injected unlock failure");
  }
}

class FailingCorruptEntryCleanupDriver extends InMemoryCacheDriver {
  override async deleteIfValue(): Promise<boolean> {
    throw new Error("injected cleanup failure");
  }
}

describe("DistributedCache", () => {
  test("validates lock, polling and per-entry TTL options", async () => {
    expect(() => new DistributedCache(new InMemoryCacheDriver(), jsonCacheCodec, {
      connectionName: "default",
      keyPrefix: "t:",
      defaultLockSeconds: 0,
    })).toThrow(CacheError);
    const cache = serviceCache();
    await expect(cache.getOrCreateAsync("k", async () => "v", { ttlSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow();
    await expect(cache.getOrCreateAsync("k", async () => "v", { lockSeconds: -1 })).rejects.toThrow();
  });

  test("snapshots and freezes caller-owned configuration", async () => {
    const driver = new InMemoryCacheDriver();
    const config = {
      connectionName: "default",
      keyPrefix: "before:",
      defaultLockSeconds: 5,
      maxValueBytes: 64,
    };
    const cache = new DistributedCache(driver, jsonCacheCodec, config);

    config.keyPrefix = "after:";
    config.defaultLockSeconds = 0;
    config.maxValueBytes = 1;

    expect(await cache.getOrCreateAsync("k", async () => "long enough", {})).toBe("long enough");
    expect(await cache.get<string>("k")).toBe("long enough");
    expect([...driver.store.keys()].some((key) => key.startsWith("before:entry:"))).toBe(true);
    expect(Object.isFrozen((cache as unknown as { config: object }).config)).toBe(true);
  });

  test("stores and reads values under the namespace prefix", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    await cache.getOrCreateAsync("user:1", async () => ({ id: 1, name: "Ada" }), { ttlSeconds: 60 });
    expect(await cache.get<{ id: number; name: string }>("user:1")).toEqual({ id: 1, name: "Ada" });
    expect([...driver.store.keys()].some((key) => key.startsWith("t:svc:entry:"))).toBe(true);
  });

  test("treats a corrupt entry as a miss even when cleanup fails", async () => {
    const driver = new FailingCorruptEntryCleanupDriver();
    const cache = serviceCache(driver);
    await cache.getOrCreateAsync("k", async () => "valid", { ttlSeconds: 60 });
    const storageKey = [...driver.store.keys()].find((key) => key.startsWith("t:svc:entry:"));
    expect(storageKey).toBeDefined();
    driver.store.set(storageKey as string, "{not-json");

    expect(await cache.get("k")).toBeUndefined();
  });

  test("getOrCreateAsync deduplicates concurrent misses", async () => {
    const cache = serviceCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await Bun.sleep(20);
      return calls;
    };
    const [a, b] = await Promise.all([
      cache.getOrCreateAsync("k", factory, { ttlSeconds: 60 }),
      cache.getOrCreateAsync("k", factory, { ttlSeconds: 60 }),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  test("a lock loser runs its own factory when the owner cannot publish", async () => {
    const driver = new InMemoryCacheDriver();
    const config = {
      connectionName: "default",
      keyPrefix: "t:",
      defaultLockSeconds: 1,
      pollIntervalMs: 1,
      maxValueBytes: 1,
    } as const;
    const owner = new DistributedCache(driver, jsonCacheCodec, config);
    const loser = new DistributedCache(driver, jsonCacheCodec, config);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ownerPending = owner.getOrCreateAsync("k", async () => {
      await gate;
      return "owner";
    }, { lockSeconds: 1 });
    await Bun.sleep(0);
    let loserCalls = 0;
    const loserPending = loser.getOrCreateAsync("k", async () => {
      loserCalls += 1;
      return "loser";
    }, { lockSeconds: 1 });
    await Bun.sleep(5);
    expect(loserCalls).toBe(0);
    release();
    expect(await ownerPending).toBe("owner");
    expect(await loserPending).toBe("loser");
    expect(loserCalls).toBe(1);
  });

  test("evictByTag removes tagged entries", async () => {
    const cache = serviceCache();
    await cache.getOrCreateAsync("a", async () => "1", { ttlSeconds: 60, tags: ["users"] });
    expect(await cache.evictByTag("users")).toBe(1);
    expect(await cache.get("a")).toBeUndefined();
  });

  test("maxValueBytes degrades gracefully (value still returned, not stored)", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = new DistributedCache(driver, jsonCacheCodec, {
      connectionName: "default",
      keyPrefix: "t:",
      defaultLockSeconds: 5,
      maxValueBytes: 4,
    });
    const value = await cache.getOrCreateAsync("k", async () => "way-too-long", { ttlSeconds: 60 });
    expect(value).toBe("way-too-long");
    expect(await cache.get("k")).toBeUndefined();
  });

  test("releases its lock after filling the entry", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    await cache.getOrCreateAsync("k", async () => "v", { ttlSeconds: 60 });
    expect(driver.locks.size).toBe(0);
  });

  test("an unlock failure does not mask a successful factory result", async () => {
    const cache = serviceCache(new FailingUnlockDriver());
    expect(await cache.getOrCreateAsync("k", async () => "fresh", { ttlSeconds: 60 })).toBe("fresh");
  });

  test("an unlock failure does not replace the factory error", async () => {
    const cache = serviceCache(new FailingUnlockDriver());
    await expect(cache.getOrCreateAsync("k", async () => {
      throw new Error("factory failed");
    }, { ttlSeconds: 60 })).rejects.toThrow("factory failed");
  });

  test("does not store a result after its fencing lock was replaced", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("k", async () => {
      await gate;
      return "old-owner";
    }, { ttlSeconds: 60 });
    await Bun.sleep(0);
    const lockKey = [...driver.locks.keys()][0];
    expect(lockKey).toBeDefined();
    driver.locks.set(lockKey as string, "new-owner");
    release();
    expect(await pending).toBe("old-owner");
    expect(await cache.get("k")).toBeUndefined();
  });

  test("invalidation fences a factory that was already running", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("k", async () => {
      await gate;
      return "stale";
    }, { ttlSeconds: 60, tags: ["users"] });
    await Bun.sleep(0);
    await cache.evictByTag("users");
    release();
    expect(await pending).toBe("stale");
    expect(await cache.get("k")).toBeUndefined();
    expect([...driver.store.keys()].some((key) => key.startsWith("t:svc:version:entry:"))).toBe(false);
  });

  test("remove of an absent unlocked entry does not leave a version tombstone", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    expect(await cache.remove("missing")).toBe(false);
    expect([...driver.store.keys()].some((key) => key.startsWith("t:svc:version:entry:"))).toBe(false);
  });

  test("an unrelated invalidation does not cancel a valid in-flight fill", async () => {
    const cache = serviceCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("a", async () => {
      await gate;
      return "value-a";
    }, { ttlSeconds: 60, tags: ["group-a"] });
    await Bun.sleep(0);
    await cache.remove("b");
    await cache.evictByTag("group-b");
    release();
    expect(await pending).toBe("value-a");
    expect(await cache.get<string>("a")).toBe("value-a");
  });

  test("snapshots caller-owned tags before an asynchronous fill", async () => {
    const cache = serviceCache();
    const tags = ["users"];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("a", async () => {
      await gate;
      return "stale";
    }, { ttlSeconds: 60, tags });
    await Bun.sleep(0);
    tags[0] = "admins";
    await cache.evictByTag("users");
    release();
    await pending;
    expect(await cache.get("a")).toBeUndefined();
  });

  test("retries an older tag generation after failure immediately after advancing", async () => {
    const driver = new FailOnceTagReadDriver();
    const cache = serviceCache(driver);
    await cache.getOrCreateAsync("a", async () => "value", { ttlSeconds: 60, tags: ["users"] });
    driver.failNextTagRead = true;
    await expect(cache.evictByTag("users")).rejects.toThrow(/injected/);
    expect(await cache.evictByTag("users")).toBe(1);
    expect(await cache.get("a")).toBeUndefined();
  });

  test("resumes a partially completed tag generation cleanup", async () => {
    const driver = new FailOnceTaggedDeleteDriver();
    const cache = serviceCache(driver);
    await cache.getOrCreateAsync("a", async () => "value", { ttlSeconds: 60, tags: ["users"] });
    driver.failNextDelete = true;
    await expect(cache.evictByTag("users")).rejects.toThrow(/injected/);
    expect(await cache.evictByTag("users")).toBe(1);
    expect(await cache.get("a")).toBeUndefined();
  });

  test("a stale tag membership cannot delete a newer value", async () => {
    const cache = serviceCache();
    await cache.getOrCreateAsync("k", async () => "old", { ttlSeconds: 60, tags: ["old-tag"] });
    await cache.remove("k");
    await cache.getOrCreateAsync("k", async () => "new", { ttlSeconds: 60, tags: ["new-tag"] });
    expect(await cache.evictByTag("old-tag")).toBe(0);
    expect(await cache.get<string>("k")).toBe("new");
  });

  test("keeps tag membership bounded across repeated remove and recreate", async () => {
    const driver = new InMemoryCacheDriver();
    const cache = serviceCache(driver);
    for (let index = 0; index < 50; index += 1) {
      await cache.getOrCreateAsync("k", async () => `value-${index}`, { tags: ["users"] });
      await cache.remove("k");
    }
    await cache.getOrCreateAsync("k", async () => "final", { tags: ["users"] });
    const tagSets = [...driver.tags.entries()].filter(([key]) => key.startsWith("t:svc:tag:"));
    expect(tagSets).toHaveLength(1);
    expect(tagSets[0]?.[1].size).toBe(1);
    expect(await cache.evictByTag("users")).toBe(1);
  });
});

class Greeter {
  public calls = 0;

  @CacheableRedis({ seconds: 60, key: (...args: readonly unknown[]) => String(args[0]) })
  async greet(name: string): Promise<string> {
    this.calls += 1;
    return `hi ${name}`;
  }
}

class BothDecorators {
  @Cacheable({ seconds: 10 })
  @CacheableRedis({ seconds: 10 })
  value(): number {
    return 1;
  }
}

class NeedsBackend {
  @CacheableRedis({ seconds: 10, key: () => "x" })
  async value(): Promise<number> {
    return 1;
  }
}

describe("wrapCachedService distributed routing", () => {
  test("routes @CacheableRedis to the distributed service cache", async () => {
    const service = wrapCachedService(new Greeter(), {
      memoryCache: new MemoryCache(),
      serviceCache: registryOf(serviceCache()),
      policies: {},
    });
    expect(await service.greet("world")).toBe("hi world");
    expect(await service.greet("world")).toBe("hi world");
    expect(service.calls).toBe(1);
  });

  test("rejects both @Cacheable and @CacheableRedis on one method", () => {
    const service = wrapCachedService(new BothDecorators(), {
      memoryCache: new MemoryCache(),
      serviceCache: registryOf(serviceCache()),
      policies: {},
    });
    expect(() => service.value()).toThrow(CacheError);
  });

  test("@CacheableRedis without a backend throws a clear error", () => {
    const service = wrapCachedService(new NeedsBackend(), {
      memoryCache: new MemoryCache(),
      policies: {},
    });
    expect(() => service.value()).toThrow(/no distributed cache backend/);
  });
});

@Controller("catalog")
class CatalogController {
  @Get("items")
  @OutputRedisCache({ seconds: 60, varyByQuery: ["limit"], tags: ["products"] })
  list() {
    return { items: ["redis"] };
  }
}

describe("output cache composer (distributed)", () => {
  test("registers @OutputRedisCache middleware when a backend is enabled", () => {
    const composer = createRouteOutputCacheComposerWithOptions({
      policies: {},
      globalEnabled: true,
      cacheToken: ICache as never,
      distributedEnabled: true,
    });
    const chain = composer(CatalogController, "list", {} as ControllerMeta, {} as ActionMeta);
    expect(chain).toHaveLength(1);
  });

  test("throws when no distributed backend is configured", () => {
    const composer = createRouteOutputCacheComposerWithOptions({
      policies: {},
      globalEnabled: true,
      cacheToken: ICache as never,
      distributedEnabled: false,
    });
    expect(() => composer(CatalogController, "list", {} as ControllerMeta, {} as ActionMeta)).toThrow(
      /requires a distributed backend/,
    );
  });
});
