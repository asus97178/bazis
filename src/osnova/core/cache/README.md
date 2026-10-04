# src/osnova/core/cache — модуль кэширования

Актуальные контракты DI, изоляция ключей и предел `maxInFlight` описаны в
[паспорте модуля](MODULE.md). MemoryCache допускает по умолчанию 1024 выполняемые
factory; новый miss при заполненном лимите получает `CacheCapacityError` без запуска
новой работы. Готовые значения и объединение запросов одного ключа остаются доступны.

Backend-agnostic кэш Osnova: in-memory + распределённый (multi-instance) уровень.
Фреймворк знает только абстракцию `IDistributedCache`; конкретный backend (Redis и т.п.)
живёт в `@/core/infra` и подключается опцией `redisConnect(redisConfig, { cache: "distributed" })`
в манифесте `@Infra` — cache-модуль находит бэкенд через DI. Полная спецификация
для приложений: **[SPEC.md](SPEC.md)**.

## Два уровня × два backend'а

| Декоратор | Уровень | Store |
|-----------|---------|-------|
| `@OutputCache` | HTTP controller | in-memory (`ICache`) |
| `@OutputRedisCache` | HTTP controller | distributed (`IDistributedCache`) |
| `@Cacheable` | метод сервиса | in-memory (`ICache`) |
| `@CacheableRedis` | метод сервиса | distributed (`IDistributedCache`) |

«Redis» в именах декораторов = «распределённый уровень». Сам Redis в `@/core/cache` не импортируется.

## Архитектура распределённого кэша

```
@/core/cache (framework)               @/core/infra (redis backend)
  IDistributedCache        interface
  DistributedCache         вся политика  ──▶ RedisDistributedCacheDriver  примитивы Bun RedisClient
    (fencing lock,                            RedisDistributedCacheBackend стора per connection
     anti-stampede, tags,                       redisConnect(cfg, { cache: "distributed" })
     value-size guard)
  DistributedCacheDriver   ◀─ реализует ── RedisDistributedCacheDriver
  DistributedCacheStores  ◀─ реализует ── RedisDistributedCacheBackend
```

Вся «умная» логика — один раз в `DistributedCache` (ядро). Backend реализует ~7 примитивов
(`read/write/delete/acquireLock/releaseLock/addTagMembers/tagMembers`). Lock снимается атомарно
по fencing-token (Lua `compare-and-del`), а не безусловным `DEL`.

## Минимальный пример (только in-memory)

```ts
import { memory } from "@/core/cache";

// Значение, которое само себя устанавливает: output-cache composer публикуется
// через DI-токен `ROUTE_MIDDLEWARE_COMPOSER` и собирается `httpModule` автоматически.
await runApp(AppModule, { cache: memory({ maxEntries: 1000 }), http: {} });

// Именованные политики/тюнинг — через продвинутый билдер:
import { buildCacheModule } from "@/core/cache";
const cache = buildCacheModule({
  policies: { catalog: { seconds: 60, varyByQuery: ["limit"], tags: ["catalog"] } },
});
```

## Подключение распределённого backend (Redis)

Backend живёт в `@/core/infra` (реализует `DistributedCacheStores` поверх
Bun `RedisClient`) и включается одним режимом в манифесте `@Infra`.
Соединением управляет InfraLifecycle; у backend нет `start/stop`:

```ts
import { Infra, redisConnect } from "@/core/infra";
import { redisConfig } from "../config/redis.config"; // defineConfig("redis", { default: { url } })

@Infra({
  cache: redisConnect(redisConfig, { cache: "distributed" }),
})
export class AppInfra {}

await runApp(AppModule, { cache: memory(), infra: AppInfra, http: {} });
```

`@CacheableRedis` / `@OutputRedisCache` находят бэкенд через DI автоматически.
Ядро `@/core/cache` не импортирует Redis вовсе — только абстракцию
`IDistributedCache`/`DistributedCacheDriver`.

## Compatibility

Canonical DI helpers are `cachedScoped` and `cachedSingleton`. Deprecated
aliases such as `autoCachedScoped` and `autoCachedSingleton` are kept only for
the 0.x compatibility window; see [COMPATIBILITY.md](./COMPATIBILITY.md).
