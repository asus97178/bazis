import { describe, expect, test } from "bun:test";
import { createContainer, singleton } from "../../di";
import {
  Cacheable, CacheableRedis, DistributedCache, MemoryCache,
  NamedCacheRegistry, jsonCacheCodec, memory,
} from "../index";
import { wrapCachedService } from "../services/cacheProxy";
import { InMemoryCacheDriver } from "./support/InMemoryCacheDriver";

describe("cache proxy argument and accessor contracts", () => {
  class HiddenInput {
    #id = "alice";
    getId() { return this.#id; }
  }

  function subject() {
    class Subject {
      calls = 0;
      @Cacheable({ seconds: 30 }) read(_input: unknown) { return ++this.calls; }
      @CacheableRedis({ seconds: 30 }) async distributed(_input: unknown) { return ++this.calls; }
    }
    const distributed = new DistributedCache(new InMemoryCacheDriver(), jsonCacheCodec,
      { connectionName: "default", keyPrefix: "proxy-contracts:", defaultLockSeconds: 1 });
    return wrapCachedService(new Subject(), {
      memoryCache: new MemoryCache(), policies: {},
      serviceCache: new NamedCacheRegistry(new Map([["default", distributed]])),
    });
  }

  test("bypasses unsupported instances in both cache tiers", async () => {
    const service = subject();
    let calls = 0;
    for (const input of [new HiddenInput(),
      new URL("https://example.test"), /alice/, new Uint8Array([1]), new ArrayBuffer(1),
      { nested: new HiddenInput() }]) {
      expect(service.read(input)).toBe(++calls);
      expect(await service.distributed(input)).toBe(++calls);
    }
    expect(service.calls).toBe(calls);
  });

  test("bypasses hidden own properties and accessors without executing their getters", () => {
    let getters = 0;
    const accessor = { get id() { getters++; return "alice"; } };
    const symbol = { [Symbol("id")]: "alice" };
    const hidden = Object.defineProperty({}, "id", { value: "alice" });
    const array = Object.assign(["alice"], { tenant: "one" });
    const date = Object.assign(new Date(0), { tenant: "one" });
    const indexedGetter = Object.defineProperty([], "0", { enumerable: true, get() { getters++; return "alice"; } });
    const service = subject();
    let calls = 0;
    for (const input of [accessor, symbol, hidden, array, date, indexedGetter]) {
      expect(service.read(input)).toBe(++calls);
      expect(service.read(input)).toBe(++calls);
    }
    expect(getters).toBe(0);
    expect(service.calls).toBe(calls);
  });

  test("keeps canonical plain data, arrays, dates and null-prototype records", () => {
    const service = subject();
    expect(service.read({ b: [1, null], a: new Date(0) })).toBe(1);
    expect(service.read({ a: new Date(0), b: [1, null] })).toBe(1);
    expect(service.read({ a: new Date(1), b: [1, null] })).toBe(2);
    expect(service.read([undefined])).toBe(3);
    expect(service.read(new Array(1))).toBe(4);
    expect(service.read(Object.assign(Object.create(null), { id: "alice" }))).toBe(5);
    expect(service.read(Object.assign(Object.create(null), { id: "alice" }))).toBe(5);
    expect(service.read({ id: "alice" })).toBe(6);
  });

  test("explicit keys support Map, Set and native private state", () => {
    class Subject {
      @Cacheable({ seconds: 30, key: (...args) => (args[0] as Map<string, string>).get("id")! })
      map(input: Map<string, string>) { return input.get("id"); }
      @Cacheable({ seconds: 30, key: (...args) => [...args[0] as Set<string>].sort().join(",") })
      set(input: Set<string>) { return [...input].sort().join(","); }
      @Cacheable({ seconds: 30, key: (...args) => (args[0] as HiddenInput).getId() })
      hidden(input: HiddenInput) { return input.getId(); }
    }
    const service = wrapCachedService(new Subject(), { memoryCache: new MemoryCache(), policies: {} });
    expect(service.map(new Map([["id", "alice"]]))).toBe("alice");
    expect(service.map(new Map([["id", "bob"]]))).toBe("bob");
    expect(service.set(new Set(["alice"]))).toBe("alice");
    expect(service.set(new Set(["bob"]))).toBe("bob");
    expect(service.hidden(new HiddenInput())).toBe("alice");
  });

  test("DI proxy preserves private getter, setter, method and disposal receivers", async () => {
    class Subject {
      #state = "ready";
      get state() { return this.#state; }
      set state(value: string) { this.#state = value; }
      @Cacheable({ seconds: 30 }) read(id: number) { return `${this.#state}:${id}`; }
      dispose() { this.#state = "disposed"; }
    }
    const container = createContainer({ imports: [memory()], providers: [singleton(Subject)] });
    const service = container.resolve(Subject);
    try {
      expect(service.state).toBe("ready");
      expect(service.read(1)).toBe("ready:1");
      service.state = "updated";
      expect(service.state).toBe("updated");
      expect(service.read(2)).toBe("updated:2");
    } finally { await container.dispose(); }
    expect(service.state).toBe("disposed");
  });
});
