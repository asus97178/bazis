# Кэширование

Кэш результатов методов сервисов: дорогой запрос к базе или внешнему API
выполняется один раз, а повторные вызовы с тем же ключом берут готовый
ответ. Кэш целых HTTP-ответов — отдельная глава,
[Кэширование ответов](../http/output-cache.md).

Все примеры проверены на bazis 0.110.1 и Valkey 7.2.

## Два уровня

| | `@Cacheable` | `@CacheableRedis` |
| --- | --- | --- |
| Где хранится | В памяти процесса | В Redis (Valkey), общий для всех экземпляров |
| Что подключить | `cache: memory()` в `runApp` | Плюс `redisConnect(…, { cache: "distributed" })` в `@Infra` |
| Значения | Любые — возвращается тот же объект | Только простые данные JSON |
| Скорость | Без сети | Запрос к Redis |
| Переживает перезапуск | Нет | Да, если ключ задан явно |
| Сброс | `ICache` | `IDistributedCache` |

Один экземпляр приложения — хватит `@Cacheable`. Несколько экземпляров и
нужен общий результат или общий сброс — `@CacheableRedis`.

## Кэш в памяти: `@Cacheable`

```ts
// index.ts
import { memory } from "bazis/core/cache";

await runApp(AppModule, { cache: memory({ maxEntries: 1000 }), http: { port: 3000 } });
```

```ts
import { Cacheable, ICache } from "bazis/core/cache";

export class CatalogService {
  constructor(private readonly source: PriceSource, private readonly cache: ICache) {}

  @Cacheable({ seconds: 60, key: (sku) => `price:${sku}`, tags: ["prices"] })
  async price(sku: string) {
    return { sku, price: await this.source.load(sku) };
  }

  async setPrice(sku: string, price: number) {
    await this.source.save(sku, price);
    this.cache.evictByTag("prices");                 // все цены пересчитаются
  }
}

@Module({ providers: [singleton(PriceSource), scoped(CatalogService)] })
export class CatalogModule {}
```

Сервис регистрируется как обычно — `scoped` или `singleton`: модуль кэша
сам оборачивает классы, у которых есть `@Cacheable`.

| Параметр | Что задаёт |
| --- | --- |
| `seconds` | Сколько живёт значение |
| `key` | Ключ из аргументов: `(sku) => \`price:${sku}\`` |
| `tags` | Метки для сброса группы: `cache.evictByTag("prices")` |
| `unless` | Не кэшировать этот вызов: `unless: (sku) => sku === "test"` |

Проверено:

```text
GET /catalog/price/apple  ×2              → источник вызван 1 раз
10 одновременных GET /catalog/price/pear  → источник вызван 1 раз
PUT /catalog/price/apple/15               → {"evicted":2}
GET /catalog/price/apple                  → {"sku":"apple","price":15}
через 2 с при seconds: 2                  → значение посчитано заново
```

Одновременные запросы одного ключа ждут одно вычисление, а не
запускают его каждый — так кэш защищает источник от наплыва в момент,
когда значение истекло.

Метод, вернувший `undefined`, не кэшируется.

### Ключ и время жизни сервиса

Без `key` ключ строится из аргументов автоматически, но принадлежит
**экземпляру** сервиса: два экземпляра одного класса ничего друг другу не
отдают. Причина — безопасность: результат может зависеть от состояния
сервиса, например от пользователя запроса, и общий автоматический ключ
отдал бы данные одного пользователя другому.

| Регистрация | Что требуется |
| --- | --- |
| `singleton` | Ничего: экземпляр один, автоматический ключ работает |
| `scoped` | Явный `key` у каждого кэшируемого метода |
| `transient` | Кэшировать нельзя |

Scoped-сервис создаётся на каждый запрос, и без `key` он кэшировал бы
только внутри одного запроса. Приложение такое не запустит:

```text
[bazis] configuration error: CatalogService.summary: @Cacheable without key on a scoped service
caches only within one request (the automatic key belongs to the instance). Set key — include
the user or tenant when the result depends on them — or register CatalogService as a singleton.
```

Явный ключ — ваше обещание, что результат зависит только от того, что в
нём есть. `key` получает аргументы метода, поэтому то, от чего зависит
результат, — пользователь, арендатор, — передайте аргументом:

```ts
@Cacheable({ seconds: 60, key: (tenantId, id) => `orders:${tenantId}:${id}` })
async order(tenantId: string, id: number) { … }

// вызов
this.orders.order(this.current.get().tenantId, id);
```

> [!NOTE]
> Проверка ключа и времени жизни — с версии 0.98.34. Раньше `@Cacheable`
> без ключа у scoped-сервиса молча работал только внутри запроса, а у
> transient — не работал вовсе.

## Общий кэш в Redis: `@CacheableRedis`

```ts
// infra/App.infra.ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";
import { Infra, redisConnect } from "bazis/core/infra";

export interface RedisConfig { url: Secret }
export const redisConfig = defineConfig<RedisConfig>("redis", {
  default: { url: secret("redis://127.0.0.1:6379") },
  production: { url: secret() },
});

@Infra({ cache: redisConnect(redisConfig, { cache: "distributed" }) })
export class AppInfra {}
```

```ts
import { CacheableRedis, IDistributedCache } from "bazis/core/cache";

export class StockService {
  constructor(private readonly warehouse: Warehouse, private readonly shared: IDistributedCache) {}

  @CacheableRedis({ seconds: 30, key: (sku) => `stock:${sku}`, tags: ["stock"] })
  async stock(sku: string) {
    return { sku, stock: await this.warehouse.count(sku) };
  }

  async receive(sku: string, count: number) {
    await this.warehouse.add(sku, count);
    await this.shared.evictByTag("stock");          // сброс на всех экземплярах
  }
}
```

Проверено на двух экземплярах:

```text
GET :3202/catalog/stock/pear  → {"stock":5,"instance":"b"}   посчитал экземпляр b
GET :3201/catalog/stock/pear  → {"stock":5,"instance":"b"}   a взял из Redis
PUT :3201/catalog/stock/reset → {"evicted":1}
GET :3201/catalog/stock/pear  → {"stock":5,"instance":"a"}   посчитано заново
```

- Пока один экземпляр вычисляет значение, остальные ждут его, а не
  запускают своё (блокировка в Redis, `lockSeconds` — сколько ждать).
- Автоматический ключ (без `key`) живёт только в своём процессе: другие
  экземпляры и тот же после перезапуска его не найдут. Для общего кэша
  задавайте `key`.
- `IDistributedCache` внедряется по типу. Кроме `evictByTag` у него есть
  `get`, `remove` и `getOrCreateAsync`.
- `evictByTag` сбрасывает тег и в значениях `@CacheableRedis`, и в ответах
  `@OutputRedisCache` того же подключения — как `ICache.evictByTag` в
  памяти. Ответы в Redis — до версии 0.100.4 этот сброс их не трогал.

> [!NOTE]
> Внедрение `IDistributedCache` по типу — с версии 0.98.34. Раньше нужны
> были реестр `DISTRIBUTED_SERVICE_CACHE` и явный список зависимостей.

### Только простые данные

В Redis значение хранится как JSON. Всё, что JSON меняет по дороге,
`@CacheableRedis` отклоняет — иначе первый вызов вернул бы `Date`, а
следующий из кэша — строку:

```text
CacheValueError: DateProbe.shared: Cache value is not plain JSON: value.at is a Date
(JSON returns a string). Return plain data (an ISO string for a date, an array for a set),
or cache it in memory with @Cacheable.
```

| Нельзя | Чем заменить |
| --- | --- |
| `Date` | Строка ISO: `date.toISOString()` |
| `Set`, `Map` | Массив, объект |
| Экземпляр класса | Простой объект с нужными полями |
| `bigint`, `NaN`, `Infinity` | Строка или число |

Ошибка видна сразу, на первом вызове — проверяйте кэшируемые методы с
Redis ещё в разработке.

> [!NOTE]
> Проверка значений — с версии 0.98.34. Раньше `Date` из кэша приходил
> строкой, а `Set` и `Map` — пустым объектом.

### Если Redis недоступен

Кэш необязателен: без него приложение медленнее, но работает. Каждая
операция с Redis ограничена `operationTimeoutMs` (по умолчанию 1000 мс):

| Что вызвали | Redis завис или отказал |
| --- | --- |
| Метод с `@CacheableRedis` | Метод выполняется без кэша, ответ — свежие данные |
| Маршрут с `@OutputRedisCache` | Маршрут отвечает без кэша |
| `shared.evictByTag`, `remove`, `get` | `CacheUnavailableError` — сброс не выполнен, и это видно |

Проверено: Valkey поставлен на паузу при работающем приложении.

```text
GET /catalog/stock/kiwi    → 200 {"sku":"kiwi","stock":5} за 1,05 с
PUT /catalog/stock/reset   → 500, в журнале CacheUnavailableError:
                             Distributed cache "default" did not answer within 1000 ms.
GET /health                → 503, infra:cache unhealthy
после снятия паузы         → 200 за 0,06 с, /health 200
```

Тайм-аут меняется в настройках подключения:

```ts
redisConnect(redisConfig, { cache: { mode: "distributed", operationTimeoutMs: 300 } })
```

Если сброс кэша обязателен для корректности — например, после изменения
цены, — поймайте `CacheUnavailableError` и решите явно: повторить позже,
вернуть ошибку или записать задачу в [очередь](background-services.md#очередь-задач-в-базе).

> [!NOTE]
> Тайм-аут операций — с версии 0.98.34. Раньше зависший Redis вешал каждый
> запрос к кэшируемому методу до обрыва соединения, а отказ в соединении
> ронял вызов.

## Здоровье

`/health` показывает оба уровня:

```json
{"healthy":true,"checks":[
  {"name":"infra:cache","healthy":true,…},
  {"name":"cache:memory","healthy":true,…}]}
```

## Дальше

- [Кэширование ответов](../http/output-cache.md)
- [Шаблоны авторизации](../security/authorization-patterns.md)
- [Фоновые службы](background-services.md)
