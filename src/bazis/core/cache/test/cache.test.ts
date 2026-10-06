import { afterEach, describe, expect, test } from "bun:test";
import { createContainer } from "@/core/di";
import {
  CacheKeyError,
  CacheValueError,
  ICache,
  MemoryCache,
  memory,
} from "@/core/cache";

describe("MemoryCache", () => {
  test("validates direct-construction and per-entry options", async () => {
    expect(() => new MemoryCache({ maxEntries: 0 })).toThrow(CacheValueError);
    const cache = new MemoryCache<string>();
    expect(() => cache.set("k", "v", { ttlSeconds: Number.NaN })).toThrow(CacheValueError);
    expect(() => cache.getOrCreateAsync("k", async () => "v", { ttlSeconds: -1 })).toThrow(CacheValueError);
  });

  let cache: MemoryCache<string>;

  afterEach(() => {
    cache?.clear();
  });

  test("set / get / remove / clear", () => {
    cache = new MemoryCache();
    cache.set("hello", "world");
    expect(cache.get("hello")).toBe("world");
    expect(cache.remove("hello")).toBe(true);
    expect(cache.get("hello")).toBeUndefined();
    expect(cache.remove("hello")).toBe(false);

    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.list()).toHaveLength(2);
    cache.clear();
    expect(cache.list()).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  test("list returns snapshot of all entries", () => {
    cache = new MemoryCache();
    cache.set("x", "1");
    cache.set("y", "2");
    const entries = cache.list();
    expect(entries).toEqual([
      { key: "x", value: "1", expiresAt: undefined },
      { key: "y", value: "2", expiresAt: undefined },
    ]);
    cache.set("x", "updated");
    expect(entries[0]?.value).toBe("1");
    expect(cache.get("x")).toBe("updated");
  });

  test("TTL: expired entries behave as missing", async () => {
    cache = new MemoryCache({ defaultTtlSeconds: 0.05 });
    cache.set("temp", "value");
    expect(cache.get("temp")).toBe("value");
    await Bun.sleep(60);
    expect(cache.get("temp")).toBeUndefined();
    expect(cache.list()).toHaveLength(0);
  });

  test("per-entry TTL overrides default", async () => {
    cache = new MemoryCache({ defaultTtlSeconds: 3600 });
    cache.set("short", "v", { ttlSeconds: 0.05 });
    await Bun.sleep(60);
    expect(cache.get("short")).toBeUndefined();
  });

  test("LRU evicts oldest when maxEntries exceeded", () => {
    cache = new MemoryCache({ maxEntries: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
  });

  test("rejects forbidden and invalid keys", () => {
    cache = new MemoryCache();
    expect(() => cache.set("__proto__", "x")).toThrow(CacheKeyError);
    expect(() => cache.set("", "x")).toThrow(CacheKeyError);
    expect(() => cache.set("constructor", "x")).toThrow(CacheKeyError);
    expect(() => cache.get(1 as unknown as string)).toThrow(CacheKeyError);
  });

  test("rejects oversized string values", () => {
    cache = new MemoryCache({ maxValueBytes: 4 });
    expect(() => cache.set("k", "hello")).toThrow(CacheValueError);
    cache.set("k", "hi");
    expect(cache.get("k")).toBe("hi");
  });

  test("dispose clears storage", () => {
    cache = new MemoryCache();
    cache.set("k", "v");
    cache.dispose();
    expect(cache.size).toBe(0);
  });

  test("evictByTag removes tagged entries", () => {
    cache = new MemoryCache<string>();
    cache.set("a", "1", { tags: ["users"] });
    cache.set("b", "2", { tags: ["users", "catalog"] });
    cache.set("c", "3");
    expect(cache.evictByTag("users")).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
    expect(cache.evictByTag("catalog")).toBe(0);
  });

  test("getOrCreate returns cached value without calling factory twice", () => {
    cache = new MemoryCache();
    let calls = 0;
    const first = cache.getOrCreate("k", () => {
      calls += 1;
      return "v";
    });
    const second = cache.getOrCreate("k", () => {
      calls += 1;
      return "v2";
    });
    expect(first).toBe("v");
    expect(second).toBe("v");
    expect(calls).toBe(1);
  });

  test("getOrCreateAsync deduplicates concurrent factory calls", async () => {
    const numeric = new MemoryCache<number>();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await Bun.sleep(20);
      return calls;
    };
    const [a, b] = await Promise.all([
      numeric.getOrCreateAsync("k", factory),
      numeric.getOrCreateAsync("k", factory),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  test("invalidation prevents an older in-flight factory from repopulating the cache", async () => {
    const cache = new MemoryCache<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("k", async () => {
      await gate;
      return "stale";
    });
    cache.remove("k");
    release();
    expect(await pending).toBe("stale");
    expect(cache.get("k")).toBeUndefined();
  });

  test("an unrelated mutation does not cancel a valid in-flight fill", async () => {
    const cache = new MemoryCache<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("a", async () => {
      await gate;
      return "value-a";
    }, { tags: ["group-a"] });
    cache.set("b", "value-b", { tags: ["group-b"] });
    cache.evictByTag("group-b");
    release();
    expect(await pending).toBe("value-a");
    expect(cache.get("a")).toBe("value-a");
  });

  test("snapshots caller-owned tags before an asynchronous fill", async () => {
    const cache = new MemoryCache<string>();
    const tags = ["users"];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = cache.getOrCreateAsync("a", async () => {
      await gate;
      return "stale";
    }, { tags });
    tags[0] = "admins";
    cache.evictByTag("users");
    release();
    await pending;
    expect(cache.get("a")).toBeUndefined();
  });

  test("does not retain invalidation metadata for keys without active factories", () => {
    const cache = new MemoryCache<string>({ maxEntries: 1 });
    for (let index = 0; index < 500; index += 1) {
      cache.set(`key-${index}`, "value");
      cache.remove(`key-${index}`);
      cache.evictByTag(`tag-${index}`);
    }
    const internals = cache as unknown as {
      keyEpochs: Map<string, number>;
      tagEpochs: Map<string, number>;
      keySnapshotRefs: Map<string, number>;
      tagSnapshotRefs: Map<string, number>;
    };
    expect(internals.keyEpochs.size).toBe(0);
    expect(internals.tagEpochs.size).toBe(0);
    expect(internals.keySnapshotRefs.size).toBe(0);
    expect(internals.tagSnapshotRefs.size).toBe(0);
  });

  test("getOrCreateAsync does not cache undefined", async () => {
    cache = new MemoryCache<string>();
    let calls = 0;
    await cache.getOrCreateAsync("k", async () => {
      calls += 1;
      return undefined;
    });
    await cache.getOrCreateAsync("k", async () => {
      calls += 1;
      return "ok";
    });
    expect(calls).toBe(2);
    expect(cache.get("k")).toBe("ok");
  });

  test("trySet degrades gracefully when value exceeds max size", () => {
    cache = new MemoryCache({ maxValueBytes: 2 });
    const value = cache.getOrCreate("k", () => "hello");
    expect(value).toBe("hello");
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("memory cache value", () => {
  test("registers ICache singleton in DI", () => {
    const module = memory({ maxEntries: 100 });
    const container = createContainer(module);
    const cache = container.resolve(ICache);
    cache.set("ping", 42);
    expect(cache.get("ping")).toBe(42);
    expect(cache.list()).toEqual([{ key: "ping", value: 42, expiresAt: undefined }]);
  });
});
