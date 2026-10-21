# Коннекторы

Готовые коннекторы bazis. Как они подключаются к приложению, стартуют и
сообщают о здоровье — в [обзоре `@Infra`](overview.md).

Примеры проверены на bazis 0.111.1, PostgreSQL 17, Valkey 7.2 и
OpenSearch 2.17. Codex проверен только без установленного CLI — см.
[ниже](#codex).

| Коннектор | Клиент | Глава |
| --- | --- | --- |
| `postgres` | `IPostgres` — SQL-клиент Bun | Здесь |
| `ormBazisConnect` | ORM bazis | [Подключение PostgreSQL](../database/postgresql.md) |
| `redisConnect` | `IRedis` — Redis-клиент Bun | Здесь и [Кэширование](../realtime/caching.md) |
| `openSearchConnect` | `IOpenSearch` | Здесь |
| `llmConnect`, `llmRouter` | `AgentRuntime` | [LLM-коннекторы](../ai/llm-connectors.md) |
| `codexAppServerConnect` | `ICodex` | Здесь |

## PostgreSQL: `postgres`

Голый SQL без ORM — отчёты, миграции данных, то, что проще написать
запросом.

```ts
export interface DbConfig { host: string; port: number; database: string; username: string; password: Secret; tls: PostgresSslMode; max: number }
export const dbConfig = defineConfig<DbConfig>("db", {
  default: { host: "127.0.0.1", port: 5432, database: "app", username: "postgres", password: secret("postgres"),
    tls: configEnum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"], "disable"), max: 5 },
  production: { password: secret(), tls: "verify-full" },
});

@Infra({ db: postgres(dbConfig) })
export class AppInfra {}
```

| Ключ | Что задаёт |
| --- | --- |
| `host`, `port`, `database`, `username`, `password` | Подключение |
| `tls` | `disable` … `verify-full`, как `sslmode` в PostgreSQL |
| `max` | Размер пула соединений |
| `connectionTimeout`, `idleTimeout`, `maxLifetime` | Сроки соединений, **в секундах** |

Опция коннектора `shutdownTimeoutMs` (по умолчанию 1000) — сколько ждать
текущие запросы при остановке.

```ts
export class TransfersService {
  constructor(private readonly sql: IPostgres) {}

  async transfer(from: number, to: number, amount: number) {
    await this.sql.begin(async (tx) => {
      await tx`update accounts set balance = balance - ${amount} where id = ${from}`;
      await tx`update accounts set balance = balance + ${amount} where id = ${to}`;
    });
  }
}
```

```text
перевод 30 с 1 на 2                  → [{"id":1,"balance":70},{"id":2,"balance":30}]
исключение внутри begin              → rolled back: transfer cancelled, балансы не изменились
```

Значения в `${}` уходят параметрами запроса, а не подставляются в текст —
SQL-инъекции нет. Подробности клиента — в документации Bun к `SQL`.

## Redis: `redisConnect`

```ts
export interface RedisConfig { url: Secret }
export const redisConfig = defineConfig<RedisConfig>("redis", {
  default: { url: secret("redis://127.0.0.1:6379") },
  production: { url: secret() },
});

@Infra({ cache: redisConnect(redisConfig) })
export class AppInfra {}
```

`url` — секрет: в нём может быть пароль, `redis://user:password@host:6379/0`.

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `connectTimeoutMs` | 5000 | Сколько старт ждёт первого подключения |
| `cache` | — | `"distributed"` — общий кэш на этом Redis, см. [Кэширование](../realtime/caching.md#общий-кэш-в-redis-cacheableredis) |
| `token` | `IRedis` | Свой токен для второго экземпляра, см. [обзор](overview.md#два-экземпляра-одного-типа) |

```ts
export class SessionsService {
  constructor(private readonly redis: IRedis) {}

  async open(user: string, token: string) {
    await this.redis.set(`session:${user}`, token);
    await this.redis.expire(`session:${user}`, 60);
  }
}
```

```text
ttl 60 · get token-1 · incr 1
```

Если связь пропала во время работы, клиент переподключается сам;
`/health` на это время отвечает `503`.

## OpenSearch: `openSearchConnect`

```ts
export interface SearchConfig { url: string; username: string; password: Secret }
export const searchConfig = defineConfig<SearchConfig>("search", {
  default: { url: "http://127.0.0.1:9200", username: "admin", password: secret("admin") },
  production: { password: secret() },
});

@Infra({ search: openSearchConnect(searchConfig) })
export class AppInfra {}
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `timeoutMs` | 5000 | Срок одного запроса |
| `maxResponseBytes` | 1 МиБ | Предел размера ответа |

```ts
export class CatalogSearch {
  constructor(private readonly search: IOpenSearch) {}

  async add(id: string, title: string) {
    await this.search.index("products", { title }, id);
  }

  find(text: string) {
    return this.search.search("products", { query: { match: { title: text } } });
  }
}
```

```text
index("products", { title: "Клавиатура для ноутбука" }, "1")
search({ match: { title: "клавиатура" } }) → total 1, ids ["1"]
```

| Метод | Запрос |
| --- | --- |
| `index(index, document, id?)` | `PUT /index/_doc/id`, без `id` — `POST /index/_doc` |
| `search(index, body)` | `POST /index/_search` |
| `clusterHealth()` | `GET /_cluster/health` |
| `info()` | `GET /` |
| `request(method, path, body?)` | Любой другой запрос API |

Ошибка OpenSearch приходит исключением `InfraError` с кодом и началом
ответа; секреты в нём замаскированы:

```text
InfraError: OpenSearch POST /products/_search -> 400: {"error":{"root_cause":[{"type":"parsing_exception",
  "reason":"unknown query [nosuchquery]",…
InfraError: OpenSearch POST /missing-index/_search -> 404: {"error":{"root_cause":[{"type":"index_not_found_exception",…
```

`/health` считает кластер здоровым в состоянии `green` и `yellow`.

## Codex

`codexAppServerConnect` запускает [Codex](https://github.com/openai/codex)
в режиме App Server и даёт приложению вести диалог с ChatGPT от имени
подключённого аккаунта: вход, список моделей, ответ с потоковым текстом и
вызовами инструментов. Это отдельный исполнитель, а не модель для
[`AgentRuntime`](../ai/agents.md).

> [!WARNING]
> Раздел написан по коду и проверен только без установленного CLI `codex`:
> вход в аккаунт и ответы модели на стенде не проверялись.

```ts
export interface CodexConfig { enabled: boolean; binary: string; stateDirectory: string }
export const codexConfig = defineConfig<CodexConfig>("codex", {
  default: { enabled: false, binary: "codex", stateDirectory: "var/codex" },
});

@Infra({ codex: codexAppServerConnect(codexConfig) })
export class AppInfra {}
```

| Ключ | Что задаёт |
| --- | --- |
| `enabled` | Включён ли Codex; `false` — приложение работает без него |
| `binary` | Путь к CLI `codex` |
| `stateDirectory` | Каталог состояния Codex: вход в аккаунт хранится там |

Клиент внедряется по типу `ICodex`, как и остальные:

```ts
import { ICodex } from "bazis/core/infra";

export class Assistant {
  constructor(private readonly codex: ICodex) {}

  status() {
    return this.codex.status();
  }
}
```

> [!NOTE]
> `ICodex` — с версии 0.103.0. Раньше клиент брали токеном
> `CODEX_APP_SERVER` и перечисляли зависимости вручную; см.
> [Обновление](../reference/upgrading.md).

Методы:

| Метод | Что делает |
| --- | --- |
| `status()` | Настроен ли, подключён ли аккаунт, идёт ли вход, сколько ответов в работе |
| `login("browser" \| "device")` | Начинает вход: ссылка, для `device` — ещё код |
| `cancelLogin()`, `logout()` | Отменяет вход, отключает аккаунт |
| `models()` | Модели аккаунта и уровни рассуждения |
| `run(input)` | Ответ: `instructions`, `messages` (`{ role, text }`), `signal`, `onTextDelta`, необязательно `model`, `reasoningEffort`, `tools` и `onToolCall` |

Проверено без установленного CLI:

```text
enabled: true
→ [bazis] application failed: CodexError [UNAVAILABLE]: Codex App Server is unavailable.
  Check its installation and settings.

enabled: false
→ приложение стартует, /health: infra:codex healthy
→ status(): {"configured":false,"connected":false,"account":null,…}
→ run(…):   CodexError NOT_CONFIGURED: The ChatGPT connection is not configured on the server.
```

Ошибки — `CodexError` с кодом: `NOT_CONFIGURED`, `UNAVAILABLE`,
`SIGN_IN_REQUIRED`, `BUSY`, `MODEL_UNAVAILABLE`, `REASONING_UNAVAILABLE`,
`PROTOCOL_ERROR`, `RESPONSE_FAILED`, `TIMEOUT`, `LOGIN_FAILED`,
`LOGIN_EXPIRED`. Текст `message` рассчитан на показ пользователю, его язык
задаёт `runApp({ language })`:

```ts
try {
  return { answer: await this.assistant.ask("Привет") };
} catch (error) {
  if (error instanceof CodexError) return { code: error.code, message: error.message };
  throw error;
}
```

```text
language: "en"  {"code":"NOT_CONFIGURED","message":"The ChatGPT connection is not configured on the server."}
language: "ru"  {"code":"NOT_CONFIGURED","message":"Подключение ChatGPT не настроено на сервере."}
```

Свои тексты — `CodexError.useMessages({ BUSY: "…" })`: они ложатся поверх
языка приложения, остальные коды остаются на нём. Тексты общие на процесс:
если в одном процессе два приложения с разными языками, действует язык
последнего запущенного.

> [!NOTE]
> С версии 0.105.3. Раньше `language` тексты Codex не переключал, нужен был
> `CodexError.useMessages(RU_CODEX_MESSAGES)`.

## Дальше

- [Обзор `@Infra`](overview.md)
- [Свой коннектор](custom-connector.md)
- [Подключение PostgreSQL](../database/postgresql.md)
- [Кэширование](../realtime/caching.md)
