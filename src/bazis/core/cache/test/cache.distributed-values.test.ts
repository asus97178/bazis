import { describe, expect, test } from "bun:test";
import { createContainer, Module, singleton, singletonValue } from "@/core/di";
import {
  CacheableRedis, CacheValueError, DISTRIBUTED_SERVICE_CACHE, DistributedCache, NamedCacheRegistry, jsonCacheCodec, memory,
  type IDistributedCache,
} from "@/core/cache";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

// 0.98.34: the distributed tier refuses values JSON would change instead of
// returning a string for a Date and {} for a Set on a cache hit.

function registry(): NamedCacheRegistry<IDistributedCache> {
  const cache = new DistributedCache(new InMemoryCacheDriver(), jsonCacheCodec, { connectionName: "default", keyPrefix: "t:", namespace: "svc:", defaultLockSeconds: 5 });
  return new NamedCacheRegistry(new Map([["default", cache]]));
}

describe("jsonCacheCodec", () => {
  test("plain data round-trips; undefined object fields are dropped like JSON does", () => {
    const value = { a: 1, b: "x", c: [true, null, { d: 2.5 }], e: undefined, f: Object.assign(Object.create(null), { g: 1 }) };
    expect(JSON.parse(jsonCacheCodec.serialize(value))).toEqual({ a: 1, b: "x", c: [true, null, { d: 2.5 }], f: { g: 1 } });
  });

  test("names the first field JSON would change", () => {
    const refused = (value: unknown) => { try { jsonCacheCodec.serialize(value); return "accepted"; } catch (error) { expect(error).toBeInstanceOf(CacheValueError); return (error as Error).message.split(": ")[1]!.split(". Return")[0]; } };
    class Price { amount = 1; }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(refused({ at: new Date(0) })).toBe("value.at is a Date (JSON returns a string)");
    expect(refused({ tags: new Set(["a"]) })).toBe("value.tags is a Set (JSON returns {})");
    expect(refused([new Map()])).toBe("value[0] is a Map (JSON returns {})");
    expect(refused({ price: new Price() })).toBe("value.price is a Price");
    expect(refused({ n: Number.NaN })).toBe("value.n is NaN (JSON writes null)");
    expect(refused({ big: 1n })).toBe("value.big is a bigint");
    expect(refused([1, undefined])).toBe("value[1] is undefined (JSON writes null)");
    expect(refused({ fn: () => 1 })).toBe("value.fn is a function");
    expect(refused(cycle)).toBe("value.self is a circular reference");
  });
});

describe("@CacheableRedis with a value JSON would change", () => {
  test("the call fails with the method name instead of caching altered data", async () => {
    let calls = 0;
    class Report {
      @CacheableRedis({ seconds: 60, key: () => "report" })
      async build() { calls++; return { at: new Date(0), rows: [1, 2] }; }
      @CacheableRedis({ seconds: 60, key: () => "plain" })
      async plain() { calls++; return { at: new Date(0).toISOString(), rows: [1, 2] }; }
    }
    @Module({ imports: [memory()], providers: [singletonValue(DISTRIBUTED_SERVICE_CACHE, registry()), singleton(Report)] })
    class App {}
    const report = createContainer(App, { validateOnBuild: true }).resolve(Report);
    const failure = await report.build().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CacheValueError);
    expect((failure as Error).message).toBe("Report.build: Cache value is not plain JSON: value.at is a Date (JSON returns a string). Return plain data (an ISO string for a date, an array for a set), or cache it in memory with @Cacheable.");
    expect(await report.plain()).toEqual({ at: "1970-01-01T00:00:00.000Z", rows: [1, 2] });
    expect(await report.plain()).toEqual({ at: "1970-01-01T00:00:00.000Z", rows: [1, 2] });
    expect(calls).toBe(2);
  });
});
