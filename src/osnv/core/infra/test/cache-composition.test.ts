import { describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { createContainer, createToken, DI, HOSTED_SERVICE, namedDependency, type OsnvModuleRef } from "../../di";
import { CacheError, DISTRIBUTED_CACHE_BACKEND, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE, type DistributedCacheStores } from "../../cache";
import { buildCacheModule } from "../../cache/internal/buildCacheProviders";
import { defineConfig, HEALTH_CHECK, LifecycleCoordinator } from "../../kernel";
import { infraModule, redisConnect, RedisDistributedCacheBackend } from "../index";

const config = defineConfig("cache-composition", { default: { url: "redis://unused.invalid:1" } });
const backend = () => new RedisDistributedCacheBackend({
  send: async () => "PONG",
  get: async () => null, set: async () => "OK", del: async () => 0, expire: async () => 0,
});

function connector(name: string, events: string[], cache = true) {
  const redis = redisConnect(config, {
    token: createToken<RedisClient>(name),
    cache: cache ? { mode: "distributed", connection: name } : undefined,
  });
  return {
    ...redis,
    create: () => {
      events.push(`${name}:create`);
      return {
        connect: async () => { events.push(`${name}:connect`); },
        close: () => { events.push(`${name}:close`); },
        ping: async () => "PONG",
        send: async () => "PONG",
      } as unknown as RedisClient;
    },
  };
}

describe("distributed cache composition", () => {
  for (const reverse of [false, true]) {
    test(`rejects two cache connectors before creating clients (reverse=${reverse})`, () => {
      const events: string[] = [];
      const entries = [["alpha", connector("alpha", events)], ["beta", connector("beta", events)]] as const;
      const root = infraModule(Object.fromEntries(reverse ? [...entries].reverse() : entries));
      expect(() => createContainer(root, { validateOnBuild: false })).toThrow(CacheError);
      expect(() => createContainer(root)).toThrow("Only one distributed cache backend");
      expect(events).toEqual([]);
    });

    test(`rejects cache connectors in separate modules (reverse=${reverse})`, () => {
      const events: string[] = [];
      const imports = [infraModule({ alpha: connector("alpha", events) }), infraModule({ beta: connector("beta", events) })];
      expect(() => createContainer({ imports: reverse ? imports.reverse() : imports })).toThrow("found 2");
      expect(events).toEqual([]);
    });

    test(`rejects mixed Infra and direct backend registrations (reverse=${reverse})`, () => {
      const events: string[] = [];
      const imports = [infraModule({ cache: connector("redis", events) }), {
        providers: [DI.singleton(DI.valueProvider(DISTRIBUTED_CACHE_BACKEND, backend()))],
      }];
      expect(() => createContainer({ imports: reverse ? imports.reverse() : imports })).toThrow("found 2");
      expect(events).toEqual([]);
    });
  }

  test("also rejects direct and configure registrations without activating their factories", () => {
    let calls = 0;
    const first = DI.singleton(DI.factoryProvider(DISTRIBUTED_CACHE_BACKEND, [], () => { calls++; return backend(); }));
    const root: OsnvModuleRef = {
      providers: [first],
      configure: (di) => { di.singleton(first.provider); },
    };
    expect(() => createContainer(root)).toThrow("found 2");
    expect(calls).toBe(0);
  });

  test("checks the final registrations after an explicit configure replacement", async () => {
    const obsolete = backend(), replacement = backend();
    const root: OsnvModuleRef = {
      imports: [{ providers: [DI.singleton(DI.valueProvider(DISTRIBUTED_CACHE_BACKEND, obsolete))] }],
      configure: (di) => { di.replace(DISTRIBUTED_CACHE_BACKEND, DI.valueProvider(DISTRIBUTED_CACHE_BACKEND, replacement), "singleton"); },
    };
    const container = createContainer(root);
    expect(container.resolve(DISTRIBUTED_CACHE_BACKEND)).toBe(replacement);
    await container.dispose();
  });

  test("a repeated import contributes one backend and independent containers remain isolated", async () => {
    const events: string[] = [];
    const shared = infraModule({ cache: connector("sessions", events) });
    const first = createContainer({ imports: [shared, shared] });
    const second = createContainer(shared);
    const a = first.resolve(DISTRIBUTED_CACHE_BACKEND), b = second.resolve(DISTRIBUTED_CACHE_BACKEND);
    expect(a).not.toBe(b);
    expect(first.resolve(DISTRIBUTED_SERVICE_CACHE).connectionNames).toEqual(["sessions"]);
    expect(second.resolve(DISTRIBUTED_OUTPUT_CACHE).connectionNames).toEqual(["sessions"]);
    await first.dispose();
    expect(events.filter((event) => event === "sessions:close")).toHaveLength(1);
    await second.dispose();
    expect(events.filter((event) => event === "sessions:close")).toHaveLength(2);
  });

  test("one cache backend coexists with raw Redis clients and each resource closes exactly once", async () => {
    const events: string[] = [];
    const container = createContainer({ imports: [
      buildCacheModule(),
      infraModule({ cache: connector("sessions", events), raw: connector("queue", events, false) }),
    ] });
    const stores: DistributedCacheStores = container.resolve(DISTRIBUTED_CACHE_BACKEND);
    expect(stores.connectionNames).toEqual(["sessions"]);
    expect(stores.outputCache).toBe(container.resolve(DISTRIBUTED_OUTPUT_CACHE));
    expect(stores.serviceCache).toBe(container.resolve(DISTRIBUTED_SERVICE_CACHE));
    const lifecycle = new LifecycleCoordinator(container);
    expect(container.resolveAll(HOSTED_SERVICE)).toHaveLength(2);
    expect(container.resolveAll(HEALTH_CHECK).map((check) => check.name).sort()).toEqual([
      "cache:memory", "infra:cache", "infra:raw",
    ]);
    await lifecycle.start();
    expect(await stores.ping()).toEqual([{ connection: "sessions", healthy: true }]);
    await lifecycle.stopServices();
    await container.dispose();
    expect(events.filter((event) => event.endsWith(":connect"))).toEqual(["sessions:connect", "queue:connect"]);
    expect(events.filter((event) => event.endsWith(":close"))).toEqual(["queue:close", "sessions:close"]);
  });

  test("resolves stores by their interface name without a hosted-service contract", async () => {
    const value = backend();
    const stores: DistributedCacheStores = {
      connectionNames: value.connectionNames,
      outputCache: value.outputCache,
      serviceCache: value.serviceCache,
      ping: () => value.ping(),
    };
    const consumer = createToken<DistributedCacheStores>("store-consumer");
    const container = createContainer({
      imports: [buildCacheModule()],
      providers: [
        DI.singleton(DI.valueProvider(DISTRIBUTED_CACHE_BACKEND, stores)),
        DI.singleton(DI.factoryProvider(consumer, [namedDependency<DistributedCacheStores>("DistributedCacheStores")], (dependency) => dependency)),
      ],
    });
    expect(container.resolve(consumer)).toBe(stores);
    expect(await container.resolve(consumer).ping()).toEqual([{ connection: "default", healthy: true }]);
    expect(container.resolveAll(HOSTED_SERVICE)).toEqual([]);
    await container.dispose();
  });
});
