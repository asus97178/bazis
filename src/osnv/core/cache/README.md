# src/osnv/core/cache: caching module

The current DI contracts, key isolation and the `maxInFlight` limit are described in
the [module passport](MODULE.md). MemoryCache allows 1024 running factories by
default; a new miss at the full limit gets `CacheCapacityError` without starting
new work. Ready values and coalescing of requests for one key stay available.

Backend-agnostic osnv cache: an in-memory level plus a distributed (multi-instance) level.
The framework knows only the `IDistributedCache` abstraction; a concrete backend (Redis and so on)
lives in `@/core/infra` and is enabled with the `redisConnect(redisConfig, { cache: "distributed" })`
option in the `@Infra` manifest; the cache module finds the backend through DI. The full
specification for applications: **[SPEC.md](SPEC.md)**.

## Two levels × two backends

| Decorator | Level | Store |
|-----------|---------|-------|
| `@OutputCache` | HTTP controller | in-memory (`ICache`) |
| `@OutputRedisCache` | HTTP controller | distributed (`IDistributedCache`) |
| `@Cacheable` | service method | in-memory (`ICache`) |
| `@CacheableRedis` | service method | distributed (`IDistributedCache`) |

"Redis" in the decorator names means "distributed level". `@/core/cache` itself never imports Redis.

## Distributed cache architecture

```
@/core/cache (framework)               @/core/infra (redis backend)
  IDistributedCache        interface
  DistributedCache         all policy    ──▶ RedisDistributedCacheDriver  Bun RedisClient primitives
    (fencing lock,                            RedisDistributedCacheBackend stores per connection
     anti-stampede, tags,                       redisConnect(cfg, { cache: "distributed" })
     value-size guard)
  DistributedCacheDriver   ◀─ implements ── RedisDistributedCacheDriver
  DistributedCacheStores  ◀─ implements ── RedisDistributedCacheBackend
```

All the "smart" logic lives once in `DistributedCache` (the core). A backend implements ~7 primitives
(`read/write/delete/acquireLock/releaseLock/addTagMembers/tagMembers`). A lock is released atomically
by its fencing token (Lua `compare-and-del`), not by an unconditional `DEL`.

## Minimal example (in-memory only)

```ts
import { memory } from "@/core/cache";

// A self-installing value: the output-cache composer is published through the
// `ROUTE_MIDDLEWARE_COMPOSER` DI token, and `httpModule` picks it up automatically.
await runApp(AppModule, { cache: memory({ maxEntries: 1000 }), http: {} });

// Named policies/tuning go through the advanced builder:
import { buildCacheModule } from "@/core/cache";
const cache = buildCacheModule({
  policies: { catalog: { seconds: 60, varyByQuery: ["limit"], tags: ["catalog"] } },
});
```

## Connecting the distributed backend (Redis)

The backend lives in `@/core/infra` (it implements `DistributedCacheStores` on top of
Bun `RedisClient`) and is enabled with one mode in the `@Infra` manifest.
InfraLifecycle manages the connection; the backend has no `start/stop`:

```ts
import { Infra, redisConnect } from "@/core/infra";
import { redisConfig } from "../config/redis.config"; // defineConfig("redis", { default: { url } })

@Infra({
  cache: redisConnect(redisConfig, { cache: "distributed" }),
})
export class AppInfra {}

await runApp(AppModule, { cache: memory(), infra: AppInfra, http: {} });
```

`@CacheableRedis` / `@OutputRedisCache` find the backend through DI automatically.
The `@/core/cache` core does not import Redis at all, only the
`IDistributedCache`/`DistributedCacheDriver` abstraction.

## Compatibility

DI helpers are `cachedScoped` and `cachedSingleton`. Former aliases were
removed before the first npm release; see [COMPATIBILITY.md](./COMPATIBILITY.md).
