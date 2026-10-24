# `bazis/core/cache`

Кэш: в памяти и в Redis, кэш методов сервисов и кэш ответов HTTP. Список —
по пакету 0.118.0.

## Подключение

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `memory(options)` | Кэш в памяти одной строкой: `runApp({ cache: memory({ maxEntries }) })` | [Кэширование](../../realtime/caching.md) |
| `buildCacheModule(config)` | Модуль кэша с расширенными настройками: политики, распределённый кэш | — |

Распределённый кэш включает коннектор Redis:
`redisConnect(redisConfig, { cache: "distributed" })` из
[`bazis/core/infra`](core-infra.md).

## Кэш методов

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Cacheable(options)` | Результат метода в памяти процесса | [`@Cacheable`](../../realtime/caching.md#кэш-в-памяти-cacheable) |
| `CacheableRedis(options)` | Результат метода в Redis — общий для всех экземпляров | [`@CacheableRedis`](../../realtime/caching.md#общий-кэш-в-redis-cacheableredis) |
| `ICache` | Кэш в памяти по типу: `get`, `list`, `set`, `getOrCreate`, `getOrCreateAsync`, `remove`, `evictByTag`, `clear` | там же |
| `IDistributedCache`, `connectionCache(name)` | Распределённый кэш по типу; кэш именованного подключения | [Несколько экземпляров](../../recipes/multiple-instances.md) |
| `cacheToken<T>(name)` | Типизированный токен для значений одного типа | — |

## Кэш ответов

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `OutputCache(options)` | Ответ маршрута в памяти: `seconds`, `tags`, `clientCache` | [Кэш ответов](../../http/output-cache.md) |
| `OutputRedisCache(options)` | Ответ маршрута в Redis | [Несколько экземпляров](../../recipes/multiple-instances.md) |
| `buildOutputCacheKey(ctx, routeName, options)` | Ключ кэша ответа | [Что отличает один ответ от другого](../../http/output-cache.md#что-отличает-один-ответ-от-другого) |
| `guardInsecureOutputCacheRoute` | Предупреждение: кэш ответа на защищённом маршруте без разделения по пользователю | — |

## Ошибки

`CacheError`, `CacheDeclarationError`, `CacheKeyError`, `CacheValueError`,
`CacheCapacityError`, `CacheUnavailableError` — [Ошибки кэша](../errors/cache.md).

## Для пакетов и бэкендов

`MemoryCache`, `DistributedCache`, `NamedCacheRegistry`, `wrapCachedService`,
`createRouteOutputCacheComposer`, `validateCacheOptions`, `jsonCacheCodec`,
`httpPayloadCacheCodec`, токены `CACHE_OPTIONS`, `CACHE_POLICIES`,
`DISTRIBUTED_CACHE_BACKEND`, `DISTRIBUTED_OUTPUT_CACHE`,
`DISTRIBUTED_SERVICE_CACHE`, `OUTPUT_CACHE_PRINCIPAL_STATE_KEY` и значения по
умолчанию `DEFAULT_CACHE_CONNECTION`, `DEFAULT_MAX_IN_FLIGHT`,
`DEFAULT_MAX_KEY_LENGTH` (256), `DEFAULT_OUTPUT_CACHE_METHODS`,
`DEFAULT_OUTPUT_CACHE_STATUS_CODES`.

## Типы

- **Методы:** `CacheableOptions`, `CacheableDecoratorOptions`,
  `CacheablePolicyFields`, `CacheableRedisOptions`,
  `CacheableRedisDecoratorOptions`, `ResolvedCacheableRedisOptions`,
  `CacheFactory`, `CacheEntry`, `CacheSetOptions`, `CachePolicy`,
  `CachePolicyRegistry`, `CacheProxyOptions`.
- **Ответы:** `OutputCacheOptions`, `OutputCacheDecoratorOptions`,
  `OutputCachePolicyFields`, `OutputRedisCacheOptions`,
  `OutputRedisCacheDecoratorOptions`, `ResolvedOutputRedisCacheOptions`,
  `ClientCacheOptions`, `CachedHttpPayload`, `CacheOutputCacheOptions`,
  `OutputCacheSecurityWarningOptions`, `RouteOutputCacheComposer`.
- **Модуль и бэкенд:** `CacheModuleConfig`, `CacheOptions`,
  `MemoryCacheOptions`, `CacheCodec`, `DistributedCacheConfig`,
  `DistributedCacheDriver`, `DistributedCacheStores`,
  `DistributedCacheSetOptions`, `DistributedCachePing`,
  `DistributedCacheFencedWrite`, `DistributedCacheTagWrite`,
  `DistributedCacheVersionCheck`.
