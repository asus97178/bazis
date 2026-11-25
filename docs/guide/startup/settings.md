# Настройки приложения

`@App` принимает объект с полями. Обязательное поле одно: `modules`. Каждое
из остальных что-то включает или настраивает: HTTP-сервер, кэш, язык ответов.
Не указали поле — этого просто нет или работает значение по умолчанию.

Как приложение запускается и останавливается — в статье
[«Приложение»](application.md).

## Поля `@App`

| Поле | Что включает |
| --- | --- |
| [`modules`](#modules) | Модули приложения. Обязательное |
| [`http`](#http) | HTTP-сервер |
| [`grpc`](#grpc) | gRPC-сервер |
| [`infra`](#infra) | Подключения к базе данных, Redis и т. п. |
| [`cache`](#cache) | Кэш в памяти |
| [`config`](#config) | Свои настройки приложения |
| [`language` и `messages`](#language-и-messages) | Язык и тексты ответов фреймворка |
| [`kernel`](#kernel) | Окружение, сроки запуска и остановки |
| [Редкие поля](#редкие-поля) | `websocket`, `ui`, `validator`, `configure` |

Дальше у каждого поля свой раздел: какое значение оно принимает, что будет
без него, пример и опции.

## Пример: всё вместе

Так может выглядеть `App.ts` живого сервиса: API под `/api`, вход по токену,
фронтенд на другом домене, nginx впереди.

```ts
// src/app/App.ts
import { App } from "bazis/core/app";
import { memory } from "bazis/core/cache";
import { AppModule } from "./modules/App.module";
import { AppInfra } from "./infra/App.infra";
import { signedIn } from "./auth/checks";

@App({
  modules: [AppModule],
  infra: AppInfra,                        // база данных
  cache: memory({ maxEntries: 1000 }),    // кэш в памяти
  language: "ru",                         // ответы фреймворка по-русски
  http: {
    prefix: "api",                        // маршруты: /api/tasks, /api/projects
    health: true,                         // GET /health для Docker и Kubernetes
    authorize: signedIn,                  // все маршруты — только с токеном
    cors: { origin: "https://app.example.com" }, // фронтенд на своём домене
    trustedProxies: ["127.0.0.1"],        // адрес клиента — от nginx
  },
  kernel: { shutdownTimeoutMs: 30_000 },  // 30 секунд на остановку
})
export class Application {}
```

Что получилось:

```text
GET /api/tasks                → 403 {"error":"Доступ запрещён"}
GET /api/tasks  (с токеном)   → 200 [...]
GET /tasks                    → 404 {"error":"Не найдено"}
GET /health                   → 200 {"healthy":true,"checks":[{"name":"cache:memory","healthy":true,...}]}
```

Обязательна здесь только строка `modules`, остальные можно убрать.

## `modules`

**Значение:** список модулей: `[AppModule]`  
**Если не указать:** приложение не запустится — поле обязательное

Из чего состоит приложение. Обычно здесь один корневой `AppModule`, который
подключает остальные модули через `imports`:

```ts
@App({ modules: [AppModule] })
export class Application {}
```

Контроллеры, фоновые службы и обработчики bazis находит во всех подключённых
модулях сам — перечислять их не нужно. Подробно — в [Модулях](../module/modules/modules.md).

## `http`

**Значение:** объект с опциями: `{ health: true }`; `{}` — сервер с настройками по умолчанию  
**Если не указать:** HTTP-сервера нет

```ts
@App({ modules: [AppModule], http: { prefix: "api", health: true } })
```

### Порт и адрес

Порт и адрес в коде не пишут: они приходят из окружения, как любые
[настройки](../module/config/configuration.md).

| Настройка | Переменная | По умолчанию |
| --- | --- | --- |
| `http.port` | `BAZIS_HTTP__PORT` | `3000` |
| `http.host` | `BAZIS_HTTP__HOST` | `127.0.0.1`; в `production` — `0.0.0.0` |

```bash
BAZIS_HTTP__PORT=3100 bunx bazis dev
```

При разработке сервер виден только с вашей машины. В production он слушает
все интерфейсы, как и нужно в контейнере. Если перед приложением на том же
сервере стоит nginx, задайте `BAZIS_HTTP__HOST=127.0.0.1`.

### Опции `http`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `port` | Из переменной `BAZIS_HTTP__PORT`, иначе `3000` | Порт прямо в коде: `port: 8080`. Если указан, переменная `BAZIS_HTTP__PORT` больше не действует, и сменить порт на сервере без правки кода нельзя. Поэтому порт обычно задают переменной (см. [Порт и адрес](#порт-и-адрес)), а в коде пишут только `port: 0` — «любой свободный порт», например для тестов |
| `hostname` | Из переменной `BAZIS_HTTP__HOST` | Адрес прямо в коде: `hostname: "127.0.0.1"`. Если указан, переменная `BAZIS_HTTP__HOST` больше не действует. Обычно адрес задают переменной |
| `prefix` | — | Общий префикс маршрутов: `prefix: "api"` → `/api/tasks` |
| `health` | Выключено | `true` — маршрут `GET /health` |
| `docs` | Вне production | Документация API: `/docs` и `/docs/openapi.json`; `false` — выключить, `true` — включить и в production |
| `middleware` | — | Глобальные [middleware](../module/controllers/middleware.md) |
| `accessLog` | Выключено | Журнал запросов |
| `cors` | Выключено | [CORS](../module/controllers/middleware.md#cors-и-журнал-запросов) |
| `securityHeaders` | Включены | Заголовки безопасности; `false` — выключить |
| `maxBodyBytes` | 1 МиБ | Предел размера тела запроса; больше — `413` |
| `exposeErrorDetails` | Вне production | Текст и стек ошибки в ответе `500` — см. [Обработку ошибок](../module/controllers/errors.md) |
| `errorHandler` | — | Уведомления о неожиданных ошибках, своя запись в журнал, `status` — коды для своих ошибок |
| `authorize` | — | Проверки для всех маршрутов — [закрыто по умолчанию](../module/controllers/authorization.md#закрыто-по-умолчанию) |
| `versioning` | Версия в пути | [Версионирование API](../module/controllers/versioning.md) |
| `idleTimeoutSeconds` | 10 (Bun) | Простой соединения клиента |
| `trustedProxies` | — | Прокси, которым можно верить в `X-Forwarded-For`, например `["127.0.0.1"]` для nginx |

### Примеры

#### Префикс и `/health`

```ts
@App({ modules: [AppModule], http: { prefix: "api", health: true } })
```

```text
GET /api/tasks  → 200 [...]
GET /tasks      → 404
GET /health     → 200 {"healthy":true,"checks":[]}
```

`/health` и `/docs` не зависят от `prefix`: контроллеры переезжают на
`/api/...`, а `GET /health` остаётся на месте.

#### Закрыть все маршруты

```ts
import { signedIn } from "./auth/checks";

@App({ modules: [AppModule], http: { authorize: signedIn } })
```

Теперь любой маршрут без токена отвечает `403`. Открытые маршруты помечают
`@AllowAnonymous()`. `/health` и `/docs` остаются открытыми. Как написать
`signedIn` — в [Авторизации](../module/controllers/authorization.md).

#### Фронтенд на другом домене

```ts
@App({
  modules: [AppModule],
  http: { cors: { origin: ["https://app.example.com", "https://admin.example.com"] } },
})
```

Ответы получают `Access-Control-Allow-Origin` для этих доменов, на запросы
`OPTIONS` от браузера bazis отвечает сам.

#### За nginx

```ts
@App({ modules: [AppModule], http: { trustedProxies: ["127.0.0.1"] } })
```

Теперь `ctx.clientIp` — адрес посетителя из `X-Forwarded-For`, а не адрес
nginx. Подделать его, обратившись к приложению напрямую, нельзя: заголовку
верят, только если запрос пришёл с перечисленного адреса.

#### Документация API в production

```ts
@App({ modules: [AppModule], http: { docs: true } })
```

По умолчанию `/docs` есть только при разработке. С `docs: true` он работает и
на сервере; `docs: false` выключает его везде.

#### Ошибки — в трекер

```ts
@App({
  modules: [AppModule],
  http: {
    errorHandler: {
      onUnexpectedError: (ctx, error) => tracker.capture(error, { path: ctx.request.url }),
    },
  },
})
```

Вызывается для каждой неожиданной ошибки: клиент получает `500`, ошибка
пишется в журнал, как обычно, и дополнительно уходит в трекер.

#### Журнал запросов

```ts
@App({ modules: [AppModule], http: { accessLog: true } })
```

```text
info: GET /api/tasks 200 0.2ms {"method":"GET","path":"/api/tasks","status":200,"durationMs":0.22,"clientIp":"127.0.0.1"}
```

## `grpc`

**Значение:** объект с опциями: `{ address: "0.0.0.0:50051" }`; `{}` — адрес `127.0.0.1:50051`  
**Если не указать:** gRPC-сервера нет

gRPC — отдельный сервер на своём порту. Можно включить только HTTP, только
gRPC или оба сразу:

```ts
@App({
  modules: [AppModule],
  http: { health: true },               // HTTP на порту 3000
  grpc: { address: "0.0.0.0:50052" },   // gRPC на своём порту
})
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `address` | `"127.0.0.1:50051"` | Адрес и порт; порт `0` — любой свободный |
| `credentials` | Без шифрования | TLS или mTLS: `ServerCredentials.createSsl(...)` |
| `maxConcurrentCalls` | `1024` | Сколько вызовов обрабатывается одновременно |
| `shutdownTimeoutMs` | `5000` | Сколько ждать незаконченные вызовы при остановке |

Порт gRPC задаётся только в коде, в `address`: настройки вроде
`BAZIS_HTTP__PORT` для него нет. Чтобы брать порт из окружения, прочитайте
переменную сами:

```ts
grpc: { address: process.env.GRPC_ADDRESS ?? "127.0.0.1:50051" },
```

HTTP и gRPC слушают разные порты, общего порта у них нет. Оба сервера
работают в одном процессе и останавливаются вместе. Контроллеры
gRPC bazis находит в модулях сам — см. [gRPC](../module/grpc.md).

## `infra`

**Значение:** класс с `@Infra`: `AppInfra`  
**Если не указать:** подключений нет: ни базы данных, ни Redis

```ts
@App({ modules: [AppModule], infra: AppInfra, http: {} })
```

Подключения открываются до запуска серверов и закрываются после их
остановки. Как описать `AppInfra` — в [Инфраструктуре](../infra/overview.md).

## `cache`

**Значение:** `memory()` или `memory({ ...опции })` из `bazis/core/cache`  
**Если не указать:** кэша нет, `@Cacheable` и `@OutputCache` не работают

```ts
import { memory } from "bazis/core/cache";

@App({ modules: [AppModule], cache: memory({ maxEntries: 1000 }), http: {} })
export class Application {}
```

После этого сервисы получают `ICache`, работают `@Cacheable` и
`@OutputCache`, а в `/health` появляется проверка `cache:memory`. Кэш в Redis
подключается через `infra` — см. [Кэширование](../infra/caching.md).

| Опция `memory` | По умолчанию | Что задаёт |
| --- | --- | --- |
| `maxEntries` | Без предела | Сколько записей хранить; при переполнении вытесняется самая старая по обращению |
| `defaultTtlSeconds` | Без срока | Срок жизни записи, если он не указан при записи |
| `policies` | — | Именованные правила для `@Cacheable({ policy })` и `@OutputCache({ policy })` |

## `config`

**Значение:** результат `defineConfig(...)` или список таких: `[brandConfig, featureConfig]`  
**Если не указать:** своих настроек нет; настройки модулей и `infra` работают как обычно

Сюда кладут настройки, которые не принадлежат ни одному модулю:

```ts
import { defineConfig } from "bazis/core/kernel";

export const brandConfig = defineConfig("brand", {
  default: { title: "Задачи", supportEmail: "help@example.com" },
});

@App({ modules: [AppModule], config: brandConfig, http: {} })
export class Application {}
```

Значения меняются переменными окружения (`BAZIS_BRAND__TITLE=Проекты`) и
проверяются при запуске. Подробно — в [Конфигурации](../module/config/configuration.md).

## `language` и `messages`

**Значение:** `language` — `"ru"` или `"en"`, для нескольких языков `{ default: "ru", supported: ["ru", "en"] }`; `messages` — объект «ключ — текст»  
**Если не указать:** тексты фреймворка на английском

Это тексты, которые пишет сам фреймворк: «Не найдено», «Доступ запрещён»,
ошибки проверки данных. Тексты, которые вы передаёте в ошибку сами, не
меняются.

```ts
@App({ modules: [AppModule], language: "ru", http: {} })
```

```text
GET /tasks  → 404 {"error":"Не найдено"}       // без language: {"error":"Not Found"}
```

Несколько языков — по заголовку `Accept-Language` запроса:

```ts
@App({ modules: [AppModule], language: { default: "ru", supported: ["ru", "en"] }, http: {} })
```

Свои тексты вместо стандартных:

```ts
@App({
  modules: [AppModule],
  language: "ru",
  messages: { notFound: "Нет такой страницы" },
  http: {},
})
```

Список ключей — в [Русской локализации](../recipes/russian.md).

## `kernel`

**Значение:** объект с опциями: `{ shutdownTimeoutMs: 30_000 }`  
**Если не указать:** работают значения по умолчанию из таблицы

```ts
@App({
  modules: [AppModule],
  http: {},
  kernel: { shutdownTimeoutMs: 30_000, startupTimeoutMs: 60_000 },
})
```

Так дают больше времени долгим запросам при остановке (например, выгрузке
отчёта) и медленной базе при запуске. Kubernetes по умолчанию ждёт 30 секунд,
прежде чем убить процесс, поэтому больше 30 секунд на остановку ставить
смысла нет без `terminationGracePeriodSeconds`.

### Опции `kernel`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `environment` | `BAZIS_ENV`, иначе `NODE_ENV`, иначе `production` | Окружение: `"development"`, `"test"` или `"production"` |
| `debug` | Везде, кроме production | Режим отладки: `true` или `false` |
| `shutdownTimeoutMs` | `10000` | Время на плавную остановку; `0` — без предела |
| `startupTimeoutMs` | `30000` | Время на весь запуск; `0` — без предела |
| `signals` | `["SIGINT", "SIGTERM"]` | По каким сигналам останавливаться; например, добавить `"SIGHUP"` |
| `unhandledErrorPolicy` | `"shutdown"` | Что делать с необработанной ошибкой: `"shutdown"` — записать в журнал и остановиться с кодом 1; `"none"` — ничего не делать |
| `startupReport` | `true` | Строки `bazis started` (с адресом в `listening`) и `bazis stopped` в журнале, в любом окружении |

Окружение не задано — значит, production. Забытая переменная на сервере не
включит режим разработки с подробными ошибками. `bazis dev` запускает
приложение в `development`, `bazis test` — в `test`.

### Остановить из кода

Сервис `ApplicationLifetime` останавливает приложение так же аккуратно, как
сигнал:

```ts
import { ApplicationLifetime } from "bazis/core/kernel";

export class MaintenanceService {
  constructor(private readonly lifetime: ApplicationLifetime) {}

  shutdownForUpdate() {
    this.lifetime.stop(3); // процесс завершится с кодом 3
  }
}
```

## Редкие поля

| Поле | Значение | Если не указать | Что делает |
| --- | --- | --- | --- |
| `websocket` | Объект с опциями: `{ requireAuth: true }` | Настройки по умолчанию | Вход, CORS и адаптер Redis для [WebSocket](../module/websocket.md#вход). Сам WebSocket включается, когда в модуле есть `gateways` |
| `ui` | Объект с `surfaces` | Интерфейса нет | Генерируемый интерфейс по `uiProfiles` модулей |
| `validator` | Свой объект-валидатор | Встроенная проверка | Проверка моделей запросов вместо встроенной |
| `configure` | Функция `(builder) => { ... }` | — | Тонкая настройка ядра: свой логгер, свои источники настроек |

## Дальше

- [Приложение](application.md) — запуск и остановка
- [Жизненный цикл](lifecycle.md) — фоновые службы и хуки
- [Конфигурация](../module/config/configuration.md)
