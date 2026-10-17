# Ошибки кэша

Классы — из `bazis/core/cache`, все наследуют `CacheError`. Тексты — из
исходников 0.100.7.

## При запуске

### `CacheDeclarationError`

```text
PriceService uses @Cacheable but is registered transient: a new instance for every injection never reuses its cache. Register it as singleton or scoped.
```

`@Cacheable` на сервисе, который создаётся заново при каждом внедрении:
кэш не переживёт и одного вызова. Зарегистрируйте сервис как `singleton` или
`scoped`. Похожая ошибка — `@Cacheable` без `key` на `scoped`-сервисе: кэш
живёт только в пределах запроса, задайте ключ
([Кэширование](../../realtime/caching.md)).

### `CacheError` — нет распределённого кэша

```text
@OutputRedisCache on PricesController.list requires a distributed cache backend — add redisConnect(redisConfig, { cache: "distributed" }) to your @Infra manifest
```

([Несколько экземпляров](../../recipes/multiple-instances.md)).

### `CacheValueError` — настройки

```text
Invalid memory cache options: maxEntries must be a positive integer
ttlSeconds must be a positive number
output cache clientCache cannot be both public and private
personalized output cache cannot use clientCache.public
```

Неверные параметры `memory()`, `@Cacheable`, `@OutputCache`. Ответ с
`clientCache.public` нельзя кэшировать по пользователю: браузер или CDN
отдали бы его чужому человеку
([Кэш ответов](../../http/output-cache.md#кэш-браузера-и-cdn)).

## Во время работы

| Класс | Текст | Когда |
| --- | --- | --- |
| `CacheKeyError` | `Cache key must not be empty`, `Cache key exceeds max length of 256` | Неверный ключ |
| `CacheValueError` | `Cache value exceeds max size of … bytes` | Значение больше `maxValueBytes` |
| `CacheValueError` | `Cache value is not plain JSON: … Return plain data (an ISO string for a date, an array for a set), or cache it in memory with @Cacheable.` | В Redis кладётся `Date`, `Map`, `Set`, класс — их нельзя сохранить как JSON |
| `CacheCapacityError` | `Memory cache reached maxInFlight=…` | Слишком много одновременных вычислений одного кэша |
| `CacheUnavailableError` | `Distributed cache "default" did not answer within 1000 ms.` | Redis не ответил в срок |
| `CacheUnavailableError` | `Distributed cache "default" failed: …` | Ошибка Redis |
| `CacheError` | `Unknown output connection "reports". Available: default` | Именованное подключение кэша не объявлено |

`CacheUnavailableError` получают только прямые вызовы `get`, `remove`,
`evictByTag`. Методы с `@CacheableRedis` и маршруты с `@OutputRedisCache`
при недоступном Redis работают без кэша
([Если Redis недоступен](../../realtime/caching.md#если-redis-недоступен)).

## Дальше

- [Кэширование](../../realtime/caching.md)
- [Кэш ответов](../../http/output-cache.md)
