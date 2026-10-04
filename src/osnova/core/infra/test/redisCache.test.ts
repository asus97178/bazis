import { describe, expect, test } from "bun:test";
import { createContainer, Global, Module, singletonValue } from "@/core/di";
import {
  DISTRIBUTED_CACHE_BACKEND,
  DISTRIBUTED_OUTPUT_CACHE,
  DISTRIBUTED_SERVICE_CACHE,
} from "@/core/cache";
import { Configuration, defineConfig } from "@/core/kernel";
import {
  Infra,
  infraModule,
  RedisDistributedCacheBackend,
  RedisDistributedCacheDriver,
  redisConnect,
  type InfraManifest,
  type RedisCommandClient,
} from "@/core/infra";

const redisConfig = defineConfig("redis", { default: { url: "redis://localhost:6379" } });

/**
 * In-memory Redis-double, реализующий узкий контракт {@link RedisCommandClient}.
 * Эмулирует ровно те команды, что использует драйвер (включая EVAL для fencing).
 */
class FakeRedis implements RedisCommandClient {
  public readonly store = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...options: string[]): Promise<string | null> {
    if (options.includes("NX") && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    const exIndex = options.indexOf("EX");
    this.ttls.set(key, exIndex >= 0 ? Number(options[exIndex + 1]) : -1);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key) || this.sets.delete(key)) {
        removed += 1;
      }
      this.ttls.delete(key);
    }
    return removed;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key) && !this.sets.has(key)) return 0;
    this.ttls.set(key, seconds);
    return 1;
  }

  ttl(key: string): number {
    if (!this.store.has(key) && !this.sets.has(key)) return -2;
    return this.ttls.get(key) ?? -1;
  }

  async send(command: string, args: string[]): Promise<unknown> {
    switch (command) {
      case "EVAL": {
        const [script, keyCountValue] = args;
        const keyCount = Number(keyCountValue);
        const keys = args.slice(2, 2 + keyCount);
        const values = args.slice(2 + keyCount);
        if (script?.includes("if KEYS[2]")) {
          const [lockKey, entryVersionKey] = keys;
          const [expected] = values;
          if (lockKey !== undefined && this.store.get(lockKey) === expected) {
            this.store.delete(lockKey);
            this.ttls.delete(lockKey);
            if (entryVersionKey !== undefined) this.store.delete(entryVersionKey);
            if (entryVersionKey !== undefined) this.ttls.delete(entryVersionKey);
            return 1;
          }
          return 0;
        }
        if (script?.includes("for i = 2, #ARGV")) {
          const [tagKey] = keys;
          const [ttlValue, ...members] = values;
          if (tagKey === undefined) return 0;
          const previousTtl = this.ttl(tagKey);
          let set = this.sets.get(tagKey);
          if (set === undefined) {
            set = new Set();
            this.sets.set(tagKey, set);
            this.ttls.set(tagKey, -1);
          }
          for (const member of members) set.add(member);
          if (ttlValue === "") {
            this.ttls.set(tagKey, -1);
          } else if (previousTtl === -2 || (previousTtl >= 0 && previousTtl < Number(ttlValue))) {
            this.ttls.set(tagKey, Number(ttlValue));
          }
          return 1;
        }
        if (script?.includes("redis.call('incr'") && script.includes("redis.call('sadd'")) {
          const [versionKey, pendingKey] = keys;
          if (versionKey === undefined || pendingKey === undefined) return 0;
          const next = Number(this.store.get(versionKey) ?? "0") + 1;
          this.store.set(versionKey, String(next));
          let pending = this.sets.get(pendingKey);
          if (pending === undefined) {
            pending = new Set();
            this.sets.set(pendingKey, pending);
          }
          pending.add(String(next - 1));
          return next;
        }
        if (script?.includes("redis.call('exists', KEYS[3])")) {
          const [versionKey, valueKey, lockKey] = keys;
          if (versionKey === undefined || valueKey === undefined || lockKey === undefined) return 0;
          if (this.store.has(lockKey)) {
            const next = Number(this.store.get(versionKey) ?? "0") + 1;
            this.store.set(versionKey, String(next));
            this.ttls.set(versionKey, 65);
          } else {
            this.store.delete(versionKey);
            this.ttls.delete(versionKey);
          }
          this.ttls.delete(valueKey);
          return this.store.delete(valueKey) ? 1 : 0;
        }
        if (script?.includes("redis.call('incr'")) {
          const [versionKey, valueKey] = keys;
          if (versionKey === undefined || valueKey === undefined) return 0;
          const next = Number(this.store.get(versionKey) ?? "0") + 1;
          this.store.set(versionKey, String(next));
          return this.store.delete(valueKey) ? 1 : 0;
        }
        if (script?.includes("versionCount")) {
          const [lockKey, valueKey, ...restKeys] = keys;
          const [token, value, , versionCountValue, tagCountValue, ...restValues] = values;
          const versionCount = Number(versionCountValue);
          const tagCount = Number(tagCountValue);
          if (lockKey === undefined || valueKey === undefined || this.store.get(lockKey) !== token) return 0;
          for (let index = 0; index < versionCount; index += 1) {
            const expected = restValues[index];
            const actual = this.store.get(restKeys[index] ?? "");
            if (expected === "__OSNOVA_MISSING_VERSION__" ? actual !== undefined : actual !== expected) return 0;
          }
          this.store.set(valueKey, value ?? "");
          this.ttls.set(valueKey, -1);
          for (let index = 0; index < tagCount; index += 1) {
            const tagKey = restKeys[versionCount + index];
            const member = restValues[versionCount + index];
            if (tagKey === undefined || member === undefined) continue;
            let set = this.sets.get(tagKey);
            if (set === undefined) {
              set = new Set();
              this.sets.set(tagKey, set);
              this.ttls.set(tagKey, -1);
            }
            set.add(member);
          }
          return 1;
        }
        const [key] = keys;
        const [expected] = values;
        if (key !== undefined && this.store.get(key) === expected) {
          this.store.delete(key);
          this.ttls.delete(key);
          return 1;
        }
        return 0;
      }
      case "INCR": {
        const [key] = args;
        if (key === undefined) return null;
        const next = Number(this.store.get(key) ?? "0") + 1;
        this.store.set(key, String(next));
        return next;
      }
      case "SADD": {
        const [setKey, ...members] = args;
        if (setKey === undefined) return 0;
        let set = this.sets.get(setKey);
        if (set === undefined) {
          set = new Set();
          this.sets.set(setKey, set);
          this.ttls.set(setKey, -1);
        }
        for (const member of members) set.add(member);
        return members.length;
      }
      case "SMEMBERS": {
        const [setKey] = args;
        return setKey === undefined ? [] : [...(this.sets.get(setKey) ?? [])];
      }
      case "SREM": {
        const [setKey, ...members] = args;
        if (setKey === undefined) return 0;
        const set = this.sets.get(setKey);
        if (set === undefined) return 0;
        let removed = 0;
        for (const member of members) {
          if (set.delete(member)) removed += 1;
        }
        if (set.size === 0) this.sets.delete(setKey);
        if (set.size === 0) this.ttls.delete(setKey);
        return removed;
      }
      case "PING":
        return "PONG";
      default:
        return null;
    }
  }
}

describe("RedisDistributedCacheDriver", () => {
  test("write/read round-trips through the client", async () => {
    const client = new FakeRedis();
    const driver = new RedisDistributedCacheDriver(client);
    await driver.write("k", "v", 60);
    expect(await driver.read("k")).toBe("v");
    expect(await driver.read("missing")).toBeNull();
  });

  test("acquireLock is exclusive (SET NX) and releaseLock honors the fencing token", async () => {
    const driver = new RedisDistributedCacheDriver(new FakeRedis());
    expect(await driver.acquireLock("lock", "token-a", 5)).toBe(true);
    expect(await driver.acquireLock("lock", "token-b", 5)).toBe(false);

    // Чужой токен не снимает лок; свой — снимает.
    await driver.releaseLock("lock", "token-b");
    expect(await driver.acquireLock("lock", "token-c", 5)).toBe(false);
    await driver.releaseLock("lock", "token-a");
    expect(await driver.acquireLock("lock", "token-c", 5)).toBe(true);
  });

  test("tag membership add/read and delete", async () => {
    const driver = new RedisDistributedCacheDriver(new FakeRedis());
    await driver.addTagMembers("tag:users", ["a", "b"], 60);
    expect([...(await driver.tagMembers("tag:users"))].sort()).toEqual(["a", "b"]);
    expect(await driver.delete(["tag:users"])).toBe(1);
    expect(await driver.tagMembers("tag:users")).toEqual([]);
  });

  test("tag membership TTL never shortens and stays persistent for a no-TTL member", async () => {
    const client = new FakeRedis();
    const driver = new RedisDistributedCacheDriver(client);
    await driver.addTagMembers("tag:users", ["long"], 120);
    expect(client.ttl("tag:users")).toBe(120);
    await driver.addTagMembers("tag:users", ["short"], 30);
    expect(client.ttl("tag:users")).toBe(120);
    await driver.addTagMembers("tag:users", ["persistent"]);
    expect(client.ttl("tag:users")).toBe(-1);
    await driver.addTagMembers("tag:users", ["finite-again"], 60);
    expect(client.ttl("tag:users")).toBe(-1);
  });

  test("atomically advances entry and tag invalidation generations", async () => {
    const client = new FakeRedis();
    const driver = new RedisDistributedCacheDriver(client);
    await driver.write("entry", "value");
    expect(await driver.invalidate("version:entry", "entry")).toBe(true);
    expect(await driver.read("entry")).toBeNull();
    expect(await driver.read("version:entry")).toBe("1");

    expect(await driver.advanceTagGeneration("version:tag", "pending:tag")).toBe(1);
    expect(await driver.tagMembers("pending:tag")).toEqual(["0"]);
    await driver.removeTagMembers("pending:tag", ["0"]);
    expect(await driver.tagMembers("pending:tag")).toEqual([]);
  });

  test("keeps an entry fence only while its writer lock is active", async () => {
    const client = new FakeRedis();
    const driver = new RedisDistributedCacheDriver(client);

    expect(await driver.invalidate("version:entry", "entry", "lock:entry")).toBe(false);
    expect(await driver.read("version:entry")).toBeNull();

    await driver.acquireLock("lock:entry", "owner", 5);
    await driver.write("entry", "value");
    expect(await driver.invalidate("version:entry", "entry", "lock:entry")).toBe(true);
    expect(await driver.read("version:entry")).toBe("1");
    expect(client.ttl("version:entry")).toBeGreaterThan(0);

    await driver.releaseLock("lock:entry", "owner", "version:entry");
    expect(await driver.read("version:entry")).toBeNull();
    expect(await driver.read("lock:entry")).toBeNull();
  });
});

describe("RedisDistributedCacheBackend", () => {
  test("exposes one named connection with output and service caches", () => {
    const backend = new RedisDistributedCacheBackend(new FakeRedis());
    expect(backend.connectionNames).toEqual(["default"]);
    expect(backend.serviceCache.connectionNames).toEqual(["default"]);
    expect(backend.outputCache.connectionNames).toEqual(["default"]);
  });

  test("service cache stores, dedups and evicts by tag end-to-end", async () => {
    const client = new FakeRedis();
    const cache = new RedisDistributedCacheBackend(client).serviceCache.resolve();

    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { id: 1 };
    };
    await cache.getOrCreateAsync("user:1", factory, { ttlSeconds: 60, tags: ["users"] });
    await cache.getOrCreateAsync("user:1", factory, { ttlSeconds: 60, tags: ["users"] });
    expect(calls).toBe(1);

    expect(await cache.evictByTag("users")).toBe(1);
    expect(await cache.get("user:1")).toBeUndefined();
  });

  test("ping reports healthy when the client answers PONG", async () => {
    const backend = new RedisDistributedCacheBackend(new FakeRedis());
    expect(await backend.ping()).toEqual([{ connection: "default", healthy: true }]);
  });

  test("honors a custom connection name", () => {
    const backend = new RedisDistributedCacheBackend(new FakeRedis(), { connection: "sessions" });
    expect(backend.connectionNames).toEqual(["sessions"]);
  });
});

function containerFor(manifest: InfraManifest) {
  @Global()
  @Module({
    providers: [singletonValue(Configuration, new Configuration(new Map()))],
    exports: [Configuration],
  })
  class ConfigModule {}

  @Module({ imports: [ConfigModule, infraModule(manifest)] })
  class Root {}

  return createContainer(Root);
}

describe("redisConnect({ cache: \"distributed\" }) infra contribution", () => {
  test("registers the distributed backend and its registries in DI", () => {
    const container = containerFor({ cache: redisConnect(redisConfig, { cache: "distributed" }) });

    const backend = container.resolve(DISTRIBUTED_CACHE_BACKEND);
    expect(backend.connectionNames).toEqual(["default"]);
    expect(container.resolve(DISTRIBUTED_SERVICE_CACHE).connectionNames).toEqual(["default"]);
    expect(container.resolve(DISTRIBUTED_OUTPUT_CACHE).connectionNames).toEqual(["default"]);
  });

  test("@Infra exports the distributed cache tokens when enabled", () => {
    @Infra({ cache: redisConnect(redisConfig, { cache: "distributed" }) })
    class AppInfra {}

    const meta = AppInfra as unknown as { exports?: readonly unknown[] };
    expect(meta.exports).toContain(DISTRIBUTED_CACHE_BACKEND);
    expect(meta.exports).toContain(DISTRIBUTED_SERVICE_CACHE);
    expect(meta.exports).toContain(DISTRIBUTED_OUTPUT_CACHE);
  });

  test("plain redisConnect() (no cache mode) does not register the backend", () => {
    const container = containerFor({ cache: redisConnect(redisConfig) });
    expect(container.tryResolve(DISTRIBUTED_CACHE_BACKEND)).toBeUndefined();
  });
});
