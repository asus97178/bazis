# Параметры конфигурации

Все параметры, которыми настраивается приложение bazis:
- опции [`runApp`](#runapp);
- параметры [ядра](#kernel) и [HTTP-сервера](#http);
- [переменные окружения](#переменные-окружения);
- [`bazis.config.json`](#bazisconfigjson).

Настройки самого приложения объявляются через `defineConfig` — это глава
[Конфигурация](../fundamentals/configuration.md). Настройки коннекторов
(PostgreSQL, Redis, OpenSearch, LLM, Codex) — в главе
[Коннекторы](../infra/connectors.md).

Значения по умолчанию — для bazis 0.100.8.

## `runApp`

```ts
await runApp(AppModule, { language: "ru", infra: AppInfra, kernel: { shutdownTimeoutMs: 20_000 }, http: { port: 3000 } });
```

| Опция | Что задаёт | Подробно |
| --- | --- | --- |
| `http` | HTTP-сервер; без неё приложение запускается без HTTP — как фоновый процесс | [HTTP](#http) |
| `grpc` | gRPC-сервер | [gRPC](../realtime/grpc.md) |
| `websocket` | Вход, адаптер и лимиты WebSocket; шлюзы собираются из модулей сами | [WebSocket](../realtime/websocket.md) |
| `kernel` | Окружение, сроки запуска и остановки, сигналы | [Ядро](#kernel) |
| `infra` | Манифест `@Infra`: подключения к базе, Redis, LLM | [Инфраструктура](../infra/overview.md) |
| `cache` | Кэш приложения: `memory({ … })` | [Кэширование](../realtime/caching.md) |
| `config` | Настройки `defineConfig`, которые не принадлежат модулю | [Конфигурация](../fundamentals/configuration.md) |
| `language` | Язык текстов ответов: `"en"` (по умолчанию) или `"ru"` | [Русская локализация](../recipes/russian.md) |
| `messages` | Свои тексты отдельных сообщений поверх `language` | [Русская локализация](../recipes/russian.md#свои-тексты) |
| `validator` | Свой валидатор моделей запроса вместо встроенного | [Проверка данных](../overview/validation.md) |
| `configure` | Тонкая настройка `KernelBuilder`: логгер, источники настроек | [Приложение](../overview/application.md) |

`startTestApp` принимает те же опции, кроме `port` и `hostname` в `http`, и
ещё `overrides` — замены сервисов
([Тестирование](../fundamentals/testing.md#http-starttestapp)).

## `kernel`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `environment` | `BAZIS_ENV`, иначе `NODE_ENV`, иначе `production` | `development`, `test` или `production` |
| `debug` | `true` везде, кроме `production` | Подробности ошибок в ответах, `/docs` |
| `startupTimeoutMs` | `30000` | Срок всего запуска; `0` — без срока |
| `shutdownTimeoutMs` | `10000` | Срок плавной остановки; `0` — без срока ([Срок остановки](../deployment/graceful-shutdown.md#срок-остановки)) |
| `signals` | `["SIGINT", "SIGTERM"]` | Сигналы плавной остановки |
| `unhandledErrorPolicy` | `"shutdown"` | Необработанная ошибка: `"shutdown"` — остановка с кодом 1, `"none"` — ничего |
| `validateOnBuild` | `true` | Проверка графа сервисов при запуске |
| `startupReport` | `true` | Строки `bazis started` и `bazis stopped`; вне `production` в терминале — [экран запуска](../cli/commands.md#экран-запуска) |
| `schemaOnly` | `BAZIS_SCHEMA_ONLY` | Только инфраструктура и схема, затем выход с кодом 0 ([Шаг схемы](../deployment/single-executable.md#шаг-схемы)) |

## `http`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `port` | `3000` | Порт; `0` — свободный порт |
| `hostname` | все адреса (`0.0.0.0`); при `port: 0` — `127.0.0.1` | Адрес. В контейнере нужен `0.0.0.0` ([Docker](../deployment/docker.md)) |
| `prefix` | — | Общий префикс маршрутов: `"api"` → `/api/…` |
| `middleware` | — | Глобальные middleware ([Middleware](../overview/middleware.md)) |
| `cors` | `false` | CORS для всех маршрутов ([CORS](../http/cors-headers-log.md)) |
| `securityHeaders` | включены | Заголовки безопасности; `false` — выключить |
| `accessLog` | `false` | Журнал запросов: `true` или свой приёмник |
| `health` | `false` | `/health`: `true` или `{ path, exposeDetails, timeoutMs: 5000, cacheMs: 0 }` ([Health](../fundamentals/health-checks.md)) |
| `docs` | при `debug` — то есть вне `production` | `/docs` и `/docs/openapi.json` ([OpenAPI](../http/openapi.md)) |
| `errorHandler` | — | `status` для своих ошибок, `onUnexpectedError` ([Ошибки](../overview/errors.md)) |
| `exposeErrorDetails` | `debug` | `message` и `stack` в ответе 500 |
| `maxBodyBytes` | `1048576` (1 МиБ) | Предел тела запроса; больше — `413`. `0` — без проверки |
| `versioning` | путь, если есть `@ApiVersion` | `{ source: "url" \| "query" \| "header", parameterName, headerName, defaultVersion }` ([Версии API](../http/versioning.md)) |
| `idleTimeoutSeconds` | как в Bun | Простой соединения, 0–255 секунд |
| `requestScopeDisposeTimeoutMs` | `5000` | Сколько ждать закрытия DI-области запроса; `0` — без срока |
| `inspectableRedirects` | `false` | Перенаправления, которые клиент может проверить ([HTTP-клиент](../http/http-client.md)) |
| `phase` | `10` | Фаза запуска HTTP-сервера: после инфраструктуры |
| `imports` | — | Модули с зависимостями контроллеров, если они не видны иначе |

Опции, которые обычно не задают руками: `validator` и `languages` ставит
`runApp`, `routeMiddlewareComposer` — пакеты фреймворка.

## Переменные окружения

| Переменная | Что задаёт |
| --- | --- |
| `BAZIS_ENV` | Окружение: `development`, `test`, `production`. Без неё — `NODE_ENV`, без неё — `production` |
| `BAZIS_<ПРЕФИКС>__<КЛЮЧ>` | Значение настройки `defineConfig`: `BAZIS_MAIL__PORT` для `mail.port` ([Имена переменных](../fundamentals/configuration.md#имена-переменных-окружения)) |
| `BAZIS_SCHEMA_ONLY` | `1` — только схема базы, затем выход |
| `BAZIS_LANG` | Язык вывода CLI и экрана запуска: `en`, `ru` |
| `BAZIS_UI` | `1` — экран запуска и без терминала, `0` — строка журнала и в терминале. По умолчанию экран — в интерактивном терминале вне CI |
| `NO_COLOR`, `FORCE_COLOR` | Выключить или включить цвет |
| `BAZIS_CODEGEN_REPORT` | Файл JSON-отчёта кодогенерации ([Кодогенерация](../fundamentals/codegen.md)) |
| `BAZIS_BUN_BIN` | Какой `bun` запускать CLI, если его нет в `PATH` |
| `PORT`, `HOST` | Порт и адрес в `src/index.ts` нового проекта; сам фреймворк их не читает |

Секреты можно передавать и файлами: `secretFilesSource` читает
`/run/secrets/<ИМЯ_ПЕРЕМЕННОЙ>`
([Файлы секретов](../security/secrets.md#файлы-секретов)).

Файл `.env` Bun читает сам — при запуске из исходников. Собранный файл
`bazis build --bin` его не читает, если не собран с `--dotenv`
([Один исполняемый файл](../deployment/single-executable.md#запуск)).

## `bazis.config.json`

Файл в корне проекта. Его читают CLI и кодогенерация, приложение — нет.

```json
{
  "version": 1,
  "defaultTarget": "production",
  "language": "ru",
  "targets": {
    "production": { "entrypoints": ["src/index.ts"] }
  }
}
```

| Поле | Что задаёт |
| --- | --- |
| `version` | Версия формата, сейчас `1` |
| `defaultTarget` | Цель кодогенерации по умолчанию |
| `language` | Язык вывода CLI: `en`, `ru`. Порядок: `--lang`, `BAZIS_LANG`, это поле, язык системы |
| `targets.<имя>.entrypoints` | Точки входа цели: кодогенерация видит всё, что из них импортируется |
| `targets.<имя>.applicationParts` | Файлы цели, которые не импортируются из точки входа |

Ошибки в файле — [`BAZIS_CODEGEN_CONFIG_INVALID`](errors/codegen.md#bazis_codegen_config_invalid).

## Дальше

- [Конфигурация](../fundamentals/configuration.md)
- [Коннекторы](../infra/connectors.md)
- [Команды CLI](../cli/commands.md)
