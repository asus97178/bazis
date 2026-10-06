import { describe, expect, test } from "bun:test";
import {
  Cacheable, CacheableRedis, DistributedCache, MemoryCache, NamedCacheRegistry, jsonCacheCodec,
  type IDistributedCache,
} from "../index";
import { wrapCachedService } from "../services/cacheProxy";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

class ObservedRegistry extends NamedCacheRegistry<IDistributedCache> {
  reads = 0;
  override resolve(name?: string) { this.reads++; return super.resolve(name); }
}

function subject(read: (...args: any[]) => unknown) {
  class Subject {
    calls = 0;
    @Cacheable({ seconds: 30 }) memory(...args: unknown[]) { this.calls++; return read(...args); }
    @CacheableRedis({ seconds: 30 }) async distributed(...args: unknown[]) { this.calls++; return read(...args); }
  }
  const memory = new MemoryCache();
  const registry = new ObservedRegistry(new Map([["default", new DistributedCache(
    new InMemoryCacheDriver(), jsonCacheCodec,
    { connectionName: "default", keyPrefix: "automatic:", defaultLockSeconds: 1 },
  )]]));
  const service = wrapCachedService(new Subject(), { memoryCache: memory, serviceCache: registry, policies: {} });
  return { service, memory, registry };
}

for (const tier of ["memory", "distributed"] as const) describe(`automatic ${tier} collection keys`, () => {
  test("caches equivalent primitive collections and preserves insertion order and type", async () => {
    const { service } = subject((input) => [...input].flat().join(","));
    expect(await service[tier](new Map([["a", 1], ["b", 2]]))).toBe("a,1,b,2");
    expect(await service[tier](new Map([["a", 1], ["b", 2]]))).toBe("a,1,b,2");
    expect(service.calls).toBe(1);
    expect(await service[tier](new Map([["b", 2], ["a", 1]]))).toBe("b,2,a,1");
    expect(await service[tier](new Set(["a", "b"]))).toBe("a,b");
    expect(await service[tier](new Set(["b", "a"]))).toBe("b,a");
    expect(await service[tier](["b", "a"])).toBe("b,a");
    expect(service.calls).toBe(5);
    const reordered = new Map([["a", 1], ["b", 2]]);
    reordered.delete("a"); reordered.set("a", 1);
    expect(await service[tier](reordered)).toBe("b,2,a,1");
    expect(service.calls).toBe(5);
  });

  test("recomputes nested contents and deletion/reinsertion order after mutation", async () => {
    const { service } = subject((input) => [...input.get("nested")].map((item) => item.value).join(","));
    const first = { value: "one" }, second = { value: "two" };
    const members = new Set([first, second]);
    const input = new Map([["nested", members]]);
    expect(await service[tier](input)).toBe("one,two");
    expect(await service[tier](input)).toBe("one,two");
    first.value = "changed";
    expect(await service[tier](input)).toBe("changed,two");
    members.delete(first); members.add(first);
    expect(await service[tier](input)).toBe("two,changed");
    input.set("nested", new Set([second]));
    expect(await service[tier](input)).toBe("two");
    expect(service.calls).toBe(4);
  });

  test("distinguishes captured object keys and members from structurally equal objects", async () => {
    const known = {};
    const { service } = subject((input) => input.has(known));
    for (const make of [(key: object) => new Map([[key, 1]]), (key: object) => new Set([key])]) {
      expect(await service[tier](make(known))).toBe(true);
      expect(await service[tier](make({}))).toBe(false);
      expect(await service[tier](make(known))).toBe(true);
    }
    expect(service.calls).toBe(4);
  });

  test("preserves aliases across arguments even before a Map key is encountered", async () => {
    const { service } = subject((key, input) => input.has(key));
    const key = {};
    const input = new Map([[key, 1]]);
    expect(await service[tier](key, input)).toBe(true);
    expect(await service[tier]({}, input)).toBe(false);
    expect(await service[tier](key, new Map([[key, 1]]))).toBe(true);
    expect(service.calls).toBe(2);
    const aliases = subject((left, right) => left === right).service;
    expect(await aliases[tier](key, key)).toBe(true);
    expect(await aliases[tier]({}, {})).toBe(false);
    expect(aliases.calls).toBe(2);
  });

  test("preserves the contents of mutable object keys as well as their identity", async () => {
    const { service } = subject((input) => [...input.keys()][0].value);
    const key = { value: 1 }, input = new Map([[key, "entry"]]);
    expect(await service[tier](input)).toBe(1);
    key.value = 2;
    expect(await service[tier](input)).toBe(2);
    expect(service.calls).toBe(2);
  });

  test("does not reuse another manual proxy's object identity in a shared cache namespace", async () => {
    const known = {};
    class Subject {
      @Cacheable({ seconds: 30 }) memory(input: Map<object, number>) { return input.has(known); }
      @CacheableRedis({ seconds: 30 }) async distributed(input: Map<object, number>) { return input.has(known); }
    }
    const { memory, registry } = subject(() => undefined);
    const options = { memoryCache: memory, serviceCache: registry, policies: {}, cacheNamespace: "shared" };
    const first = wrapCachedService(new Subject(), options), second = wrapCachedService(new Subject(), options);
    expect(await first[tier](new Map([[known, 1]]))).toBe(true);
    expect(await second[tier](new Map([[{}, 1]]))).toBe(false);
  });

  test("lets the original method read an accessor exactly once per bypassed call", async () => {
    let reads = 0;
    const input = { get value() { return ++reads; } };
    const { service, registry } = subject((value) => value.value);
    expect(await service[tier](input)).toBe(1);
    expect(await service[tier](input)).toBe(2);
    expect(reads).toBe(2);
    expect(service.calls).toBe(2);
    expect(registry.reads).toBe(0);
  });

  test("bypasses unsupported graphs without touching either cache or argument traps", async () => {
    let traps = 0;
    class Hidden { #value = 1; get() { return this.#value; } }
    class CustomMap extends Map {}
    const cycle: any = {}; cycle.self = cycle;
    const cyclicMap = new Map(); cyclicMap.set("self", cyclicMap);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const inputs = [new Hidden(), new CustomMap(), new Date(NaN), () => 1, Symbol("key"),
      { get value() { traps++; throw new Error("getter must not run"); } }, cycle, cyclicMap,
      Object.defineProperty({}, "hidden", { value: 1 }), { [Symbol("field")]: 1 },
      new Map([["nested", new Hidden()]]), new Map([[new Hidden(), 1]]), new Set([new Hidden()]),
      Object.assign(new Map(), { custom: true }), Object.assign(new Set(), { custom: true }),
      new Proxy({}, { getPrototypeOf() { traps++; throw new Error("proxy must not run"); } }), revoked.proxy];
    const { service, memory, registry } = subject(() => "original");
    // If the memory backend were consulted, even a cache miss would now fail.
    memory.getOrCreate = () => { throw new Error("memory backend must not run"); };
    for (const input of inputs) {
      expect(await service[tier](input)).toBe("original");
      expect(await service[tier](input)).toBe("original");
    }
    expect(service.calls).toBe(inputs.length * 2);
    expect(registry.reads).toBe(0);
    expect(traps).toBe(0);
  });
});

test("automatic bypass preserves original failures and explicit key failures", async () => {
  const failure = new Error("original failure"), keyFailure = new Error("key failure");
  let calls = 0, keyCalls = 0;
  class Subject {
    @Cacheable({ seconds: 30 }) sync(_input: unknown) { calls++; throw failure; }
    @CacheableRedis({ seconds: 30 }) async async(_input: unknown) { calls++; throw failure; }
    @Cacheable({ seconds: 30, key() { keyCalls++; throw keyFailure; } }) explicit(_input: unknown) { calls++; }
    @CacheableRedis({ seconds: 30, key() { keyCalls++; throw keyFailure; } }) explicitRedis(_input: unknown) { calls++; }
  }
  const service = wrapCachedService(new Subject(), { memoryCache: new MemoryCache(), policies: {} });
  expect(() => service.sync(Symbol())).toThrow(failure);
  await expect(service.async(Symbol())).rejects.toBe(failure);
  expect(() => service.explicit(Symbol())).toThrow(keyFailure);
  expect(() => service.explicitRedis(Symbol())).toThrow(keyFailure);
  expect(calls).toBe(2);
  expect(keyCalls).toBe(2);
  expect(() => service.async("cacheable")).toThrow("no distributed cache backend");
  expect(calls).toBe(2);
});

test("a supported automatic key preserves backend failure without invoking the original", () => {
  const failure = new Error("backend failure");
  const { service, memory, registry } = subject(() => "must not execute");
  memory.getOrCreate = () => { throw failure; };
  registry.resolve = () => { throw failure; };
  expect(() => service.memory(new Map([["key", 1]]))).toThrow(failure);
  expect(() => service.distributed(new Set(["key"]))).toThrow(failure);
  expect(service.calls).toBe(0);
});
