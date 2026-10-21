# Обзор `@Infra`

Всё внешнее — база, Redis, поисковый движок, модель — подключается в одном
месте: манифестом `@Infra`. Это список «имя → коннектор». Коннектор знает,
как создать клиента, подключиться при старте, отключиться при остановке и
проверить здоровье. Приложение получает клиентов через DI.

Все примеры проверены на bazis 0.111.2, PostgreSQL 17, Valkey 7.2 и
OpenSearch 2.17.

## Манифест

```ts
// infra/App.infra.ts
import { Infra, openSearchConnect, postgres, redisConnect } from "bazis/core/infra";
import { dbConfig, redisConfig, searchConfig } from "./configs";

@Infra({
  db: postgres(dbConfig),
  cache: redisConnect(redisConfig),
  search: openSearchConnect(searchConfig),
})
export class AppInfra {}
```

```ts
// index.ts
await runApp(AppModule, { infra: AppInfra, http: { port: 3000 } });
```

Ключ манифеста — имя экземпляра: `db`, `cache`, `search`. Оно видно в
`/health` (`infra:db`) и в сообщениях о сбоях. Конфигурацию каждый
коннектор берёт из своего `defineConfig` — она проверяется до старта, как
и всякая [конфигурация](../fundamentals/configuration.md).

`@Infra` — обычный модуль, видимый всему приложению: импортировать его в
модули не нужно.

## Клиенты в сервисах

Клиент внедряется по типу:

```ts
import type { IOpenSearch, IPostgres, IRedis } from "bazis/core/infra";

export class StatsService {
  constructor(private readonly sql: IPostgres, private readonly redis: IRedis, private readonly search: IOpenSearch) {}

  async snapshot() {
    const [row] = await this.sql`select current_database() as db`;
    const hits = await this.redis.incr("stats:hits");
    const health = await this.search.clusterHealth();
    return { db: row.db, hits, search: health.status };
  }
}
```

```text
GET /stats → {"db":"infra_lab","hits":3,"search":"green"}
```

| Коннектор | Тип клиента | Что это |
| --- | --- | --- |
| `postgres` | `IPostgres` | `SQL` из Bun |
| `redisConnect` | `IRedis` | `RedisClient` из Bun |
| `openSearchConnect` | `IOpenSearch` | Клиент OpenSearch из bazis |
| `llmConnect`, `llmRouter` | `AgentRuntime` | См. [LLM-коннекторы](../ai/llm-connectors.md) |

Для работы с базой через ORM есть свой коннектор, `ormBazisConnect`, —
см. [Подключение PostgreSQL](../database/postgresql.md). `postgres` даёт
голый SQL-клиент, когда ORM не нужен.

> [!NOTE]
> Внедрение по типу — с версии 0.99.6. Раньше клиенты брались токенами
> `POSTGRES`, `REDIS`, `OPENSEARCH` с явным списком зависимостей.

## Порядок старта и остановки

Инфраструктура поднимается раньше HTTP-сервера и фоновых служб, а
останавливается после них:

```text
[probe] create
[probe] connect
info: bazis started {...}
SIGTERM
[probe] dispose
```

Так запросы и фоновые задачи не начинаются без базы и не теряют её
посреди работы при остановке. Подробнее — в главе
[Жизненный цикл](../fundamentals/lifecycle.md).

## Если подключиться не удалось

Приложение не стартует и говорит, что не так:

```text
PostgreSQL отказал в доступе:
[bazis] application failed: InfraError: Infra connector "postgres": failed to connect —
  password authentication failed for user "postgres"

Redis недоступен:
[bazis] application failed: InfraError: Infra connector "redis": failed to connect to
  redis://127.0.0.1:56999 within 5000 ms.

OpenSearch недоступен:
[bazis] application failed: InfraError: Infra connector "opensearch": cannot reach
  http://127.0.0.1:59299 — OpenSearch GET /_cluster/health request failed: Unable to connect. …
```

Пароли в адресах и сообщениях замаскированы.

Подключения проверяются одновременно. Если не удалось несколько, сообщение
перечисляет все — их можно исправить за один раз:

```text
[bazis] application failed: StartupFailuresError: 3 services failed to start: infra:db, infra:cache, infra:search.
  - InfraError: Infra connector "postgres": failed to connect — password authentication failed for user "postgres"
  - InfraError: Infra connector "redis": failed to connect to redis://127.0.0.1:56999 within 5000 ms.
  - InfraError: Infra connector "opensearch": cannot reach http://127.0.0.1:59299 — …
```

В терминале вместо этих строк — экран с панелью на каждое подключение,
адресом и переменными, которые стоит проверить (см.
[Команды CLI](../cli/commands.md#если-запуск-не-удался)).

Если что-то не ответило совсем, срабатывает общий срок старта — 30 секунд
(`runApp(…, { kernel: { startupTimeoutMs } })`). Сообщение называет, что
ещё стартует:

```text
[bazis] application failed: StartupTimeoutError: Application startup did not finish within 30000ms;
  still starting: infra:probe.
```

> [!NOTE]
> Срок подключения Redis и имя зависшего сервиса — с версии 0.99.6. Раньше
> недоступный Redis держал старт 30 секунд, а сообщение не называло
> причину. Одновременная проверка подключений и адрес OpenSearch в
> ошибке — с версии 0.100.0. С 0.100.0 до 0.111.2 при зависшем коннекторе
> сообщение перечисляло и уже подключённые.

## Здоровье

Каждый коннектор добавляет проверку в `/health`:

```json
{"healthy":true,"checks":[
  {"name":"infra:db","healthy":true,"durationMs":1.04},
  {"name":"infra:cache","healthy":true,"durationMs":1.22},
  {"name":"infra:search","healthy":true,"durationMs":1.74}]}
```

Если хоть одна проверка не прошла, `/health` отвечает `503` — оркестратор
выведет экземпляр из балансировки. Подробнее — в главе
[Health checks](../fundamentals/health-checks.md).

## Два экземпляра одного типа

Два Redis — для сессий и для очереди — это два коннектора. `IRedis`
достаётся первому; второму дайте свой тип — интерфейс и токен одного
имени, так же устроен `IRedis`:

```ts
// queue/Queue.module.ts
import { createToken, type InjectionToken } from "bazis/core/di";
import type { RedisClient } from "bun";

export interface IQueueRedis extends RedisClient {}
export const IQueueRedis = createToken<IQueueRedis>("IQueueRedis") as InjectionToken<RedisClient>;
```

```ts
@Infra({
  cache: redisConnect(redisConfig),
  queue: redisConnect(queueRedisConfig, { token: IQueueRedis }),
})
export class AppInfra {}
```

```ts
export class QueueService {
  constructor(private readonly sessions: IRedis, private readonly queue: IQueueRedis) {}
}
```

```text
GET /queue  → {"sessions":"sessions","queue":"queue"}
GET /health → … {"name":"infra:cache",…}, {"name":"infra:queue",…} …
```

Без `token` два экземпляра конфликтуют, и приложение не загрузится:

```text
InfraError: Infra manifest: instances "cache" and "queue" share the same connector token;
  each instance needs a distinct token.
```

## Дальше

- [Коннекторы](connectors.md)
- [Свой коннектор](custom-connector.md)
- [Конфигурация](../fundamentals/configuration.md)
- [Секреты](../security/secrets.md)
