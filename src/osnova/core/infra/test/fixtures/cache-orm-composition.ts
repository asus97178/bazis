import assert from "node:assert/strict";
import type { RedisClient } from "bun";
import { createContainer, createToken, HOSTED_SERVICE, singletonValue, type HostedService } from "../../../di";
import { DISTRIBUTED_CACHE_BACKEND, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE, memory } from "../../../cache";
import { defineConfig, HEALTH_CHECK, LifecycleCoordinator, secret } from "../../../kernel";
import { ormOsnovaConnect } from "../../../orm";
import { ormHostedPlanValidator } from "../../../orm/OrmHostedPlan.validator";
import { infraModule, llmConnect, redisConnect, type InfraConnector } from "../../index";

// Controlled source/compiled acceptance: no native database, Redis or HTTP connections.
const customEvents: string[] = [];
const customToken = createToken<{ ready: boolean }>("DeliveryClient");
const customConnector: InfraConnector<{ ready: boolean }> = {
  token: customToken,
  create: () => ({ ready: false }),
  connect(client) { client.ready = true; customEvents.push("connect"); },
  dispose() { customEvents.push("dispose"); },
};
const custom = createContainer(infraModule({ "payment-delivery": customConnector }));
const customLifecycle = new LifecycleCoordinator(custom);
await customLifecycle.start();
assert.equal(custom.resolve(customToken).ready, true);
await customLifecycle.stopServices();
await custom.dispose();
assert.deepEqual(customEvents, ["connect", "dispose"]);

const redisConfig = defineConfig("binary-cache-composition", { default: { url: "redis://unused.invalid:1" } });
const events: string[] = [];
function redis(name: string, cache = true) {
  return {
    ...redisConnect(redisConfig, { token: createToken<RedisClient>(name), cache: cache ? { mode: "distributed", connection: name } : undefined }),
    create: () => {
      events.push(`${name}:create`);
      return {
        connect: async () => { events.push(`${name}:start`); },
        close: () => { events.push(`${name}:stop`); },
        ping: async () => "PONG", send: async () => "PONG",
      } as unknown as RedisClient;
    },
  };
}
for (const reverse of [false, true]) {
  const imports = [infraModule({ cache: redis("alpha") }), infraModule({ cache: redis("beta") })];
  assert.throws(() => createContainer({ imports: reverse ? imports.reverse() : imports }), /Only one distributed cache backend/);
}
assert.equal(events.length, 0);

const cache = createContainer({ imports: [memory(), infraModule({ cache: redis("sessions"), raw: redis("queue", false) })] });
const backend = cache.resolve(DISTRIBUTED_CACHE_BACKEND);
assert.equal("start" in backend, false);
assert.equal("stop" in backend, false);
assert.deepEqual(backend.connectionNames, ["sessions"]);
assert.equal(cache.resolve(DISTRIBUTED_OUTPUT_CACHE), backend.outputCache);
assert.equal(cache.resolve(DISTRIBUTED_SERVICE_CACHE), backend.serviceCache);
assert.equal(cache.resolveAll(HOSTED_SERVICE).length, 2);
assert.deepEqual(cache.resolveAll(HEALTH_CHECK).map((check) => check.name).sort(), ["cache:memory", "infra:cache", "infra:raw"]);
const cacheLifecycle = new LifecycleCoordinator(cache);
await cacheLifecycle.start();
assert.deepEqual(await backend.ping(), [{ connection: "sessions", healthy: true }]);
await cacheLifecycle.stopServices();
await cache.dispose();
assert.deepEqual(events.filter((event) => event.endsWith(":stop")), ["queue:stop", "sessions:stop"]);

const dbConfig = defineConfig("binary-orm-composition", { default: {
  host: "unused.invalid", port: 1, database: "unused", username: "unused", password: secret("unused"),
} });
const llmConfig = defineConfig("binary-llm-composition", { default: {
  provider: "controlled", model: "controlled", baseUrl: "https://unused.invalid", apiKey: secret("unused"),
} });
function graph(copyLlm: boolean) {
  const llm = llmConnect(llmConfig, {
    create: () => ({ complete: async () => { throw new Error("No model calls permitted"); } }),
    connect: () => { events.push("llm:start"); },
    dispose: () => { events.push("llm:stop"); },
  });
  const db = {
    ...ormOsnovaConnect(dbConfig),
    create: () => {
      events.push("db:create");
      return {
        ping: async () => { events.push("db:start"); return true; },
        close: async () => { events.push("db:stop"); },
      } as never;
    },
  };
  assert.equal("kind" in db, false);
  assert.equal("kind" in llm, false);
  const admission: HostedService = {
    planValidator: ormHostedPlanValidator, phase: -105,
    ...{ __osnovaSchemaAdmission: { unit: [], tables: [], foreignKeys: [] } },
    start: () => { events.push("schema:start"); },
    stop: () => { events.push("schema:stop"); },
  };
  return createContainer({
    imports: [infraModule({ db, llm: copyLlm ? { ...llm } : llm })],
    providers: [singletonValue(HOSTED_SERVICE, admission)],
  });
}

events.length = 0;
const valid = graph(false);
const lifecycle = new LifecycleCoordinator(valid);
await lifecycle.start();
await lifecycle.stopServices();
await valid.dispose();
assert.deepEqual(events, ["db:create", "db:start", "schema:start", "llm:start", "llm:stop", "schema:stop", "db:stop"]);

events.length = 0;
const invalid = graph(true);
await assert.rejects(new LifecycleCoordinator(invalid).start(), { code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
await invalid.dispose();
assert.equal(events.length, 0);
console.log(JSON.stringify({ result: "PASS", customConnectorWithoutKind: true, duplicateBackendBeforeCreate: true, cacheStoresWithoutLifecycle: true, redisSingleOwner: true, ormPlanAndReverseStop: true, copiedConnectorRejectedBeforeCreate: true }));
