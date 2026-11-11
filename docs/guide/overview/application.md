# Приложение

Приложение объявляется один раз, классом с `@App`: из каких модулей оно
состоит, какая у него инфраструктура и какие серверы оно поднимает.

```ts
// src/app/App.ts
import { App } from "bazis/core/app";
import { AppInfra } from "./infra/App.infra";
import { AppModule } from "./modules/App.module";

@App({
  modules: [AppModule],
  infra: AppInfra,
  http: { health: true },
})
export class Application {}
```

Точка входа `src/index.ts` запускает это объявление и больше ничего не
настраивает:

```ts
// src/index.ts
import { runApp } from "bazis/core/app";
import { Application } from "./app/App";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(Application);
```

`registerBazisGeneratedRuntime()` подключает результат
[кодогенерации](../fundamentals/codegen.md), `runApp` запускает приложение
и ждёт его остановки. Когда `await runApp(...)` завершается, приложение уже
остановлено, а код выхода записан в `process.exitCode`.

То же объявление читают тесты: `startTestApp(Application)` поднимает ровно
то приложение, которое уйдёт в production, — с теми же модулями,
инфраструктурой и настройками HTTP. Подробнее — в [«Тестировании»](../fundamentals/testing.md).

`@App` и `runApp(Application)` — с версии 0.138.0. Раньше опции передавали
вторым аргументом: `runApp(AppModule, { … })`; как перейти — в
[«Обновлении»](../reference/upgrading.md#01380).

## Что происходит при запуске

1. Проверяются все настройки `defineConfig`. Нет обязательного секрета или
   значение неверного типа — приложение не стартует.
2. Собирается граф сервисов и проверяется целиком: незарегистрированные
   зависимости, нарушения `exports`, singleton, зависящий от scoped.
3. Открываются подключения инфраструктуры (база данных, кэш), затем
   запускаются фоновые службы (`background` в модулях) и HTTP-сервер.
   Контроллеры собираются со всего дерева модулей — перечислять их в
   `@App` не нужно.
4. Приложение работает, пока не придёт сигнал остановки.

После запуска в журнале появляется строка с адресом в `listening`, в любом
окружении (в терминале вне production вместо неё — [экран
запуска](../cli/commands.md#экран-запуска)):

```text
info: bazis started {"environment":"development","debug":true,"configKeys":2,"configMs":0.2,"containerMs":2,"hostedServices":3,"hooks":0,"startupMs":46,"listening":["http://127.0.0.1:3000"]}
```

Ошибка на шагах 1–2 останавливает запуск до открытия порта, с кодом выхода 1:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
auth.jwtSecret — required non-empty secret is not set (BAZIS_AUTH__JWTSECRET).
```

## Поля `@App`

Обязательно только `modules`.

| Поле | Что делает |
| --- | --- |
| `modules` | Модули приложения. Обычно один корневой `AppModule`, который собирает остальные через `imports` |
| `http` | Запускает HTTP-сервер; см. ниже |
| `cache` | Кэш приложения: `cache: memory({ maxEntries: 1000 })`, `memory` — из `bazis/core/cache`. Включает `ICache`, `@Cacheable`, `@OutputCache` |
| `infra` | Подключения к базе данных, Redis и т. п. — класс с `@Infra` |
| `config` | Настройки `defineConfig`, которые не принадлежат конкретному модулю |
| `kernel` | Окружение, тайм-ауты запуска и остановки, сигналы; см. ниже |
| `grpc` | gRPC-сервер — независимо от HTTP |
| `websocket` | Настройки [WebSocket](../realtime/websocket.md#вход): вход, CORS, адаптер Redis |
| `language`, `messages` | Язык ответов фреймворка и свои тексты — [Русская локализация](../recipes/russian.md) |
| `ui` | Генерируемый интерфейс по `uiProfiles` модулей |
| `validator` | Своя проверка моделей запросов вместо встроенной |
| `configure` | Тонкая настройка ядра: свой логгер, источники настроек |

### Опции `http`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `port` | Настройка `http.port` | Жёстко задаёт порт в коде; `0` — любой свободный. Обычно не пишут: см. [Адрес сервера](#адрес-сервера) |
| `hostname` | Настройка `http.host` | Жёстко задаёт адрес в коде. Обычно не пишут |
| `prefix` | — | Общий префикс маршрутов: `prefix: "api"` → `/api/tasks` |
| `health` | Выключено | `true` — маршрут `GET /health` |
| `docs` | Вне production | Документация API: `/docs` и `/docs/openapi.json`; `false` — выключить, `true` — включить и в production |
| `middleware` | — | Глобальные [middleware](middleware.md) |
| `accessLog` | Выключено | Журнал запросов |
| `cors` | Выключено | [CORS](middleware.md#cors-и-журнал-запросов) |
| `securityHeaders` | Включены | Заголовки безопасности; `false` — выключить |
| `maxBodyBytes` | 1 МиБ | Предел размера тела запроса; больше — `413` |
| `exposeErrorDetails` | Вне production | Текст и стек ошибки в ответе `500` — см. [Обработку ошибок](errors.md) |
| `errorHandler` | — | Уведомления о неожиданных ошибках, своя запись в журнал, `status` — коды для своих ошибок |
| `authorize` | — | Проверки для всех маршрутов — [закрыто по умолчанию](authorization.md#закрыто-по-умолчанию) |
| `versioning` | Версия в пути | [Версионирование API](../http/versioning.md) |
| `idleTimeoutSeconds` | 10 (Bun) | Простой соединения клиента |

`/health` и `/docs` не зависят от `prefix`: с `prefix: "api"` маршруты
контроллеров переезжают на `/api/...`, а `GET /health` остаётся на месте.

```json
// GET /health
{"healthy":true,"checks":[]}
```

### Адрес сервера

Порт и адрес не пишут в коде: они берутся из встроенных настроек `http`
и меняются окружением, как любые [настройки](../fundamentals/configuration.md).

| Настройка | Переменная | По умолчанию |
| --- | --- | --- |
| `http.port` | `BAZIS_HTTP__PORT` | `3000` |
| `http.host` | `BAZIS_HTTP__HOST` | `127.0.0.1`; в `production` — `0.0.0.0` |

```bash
BAZIS_HTTP__PORT=3100 bunx bazis dev
```

Вне production сервер доступен только с этой машины. В production он
слушает все интерфейсы, как и нужно в контейнере; за обратным прокси на том
же хосте задайте `BAZIS_HTTP__HOST=127.0.0.1`.

`port` или `hostname`, написанные в `@App({ http })`, закрепляют значение в
коде, и окружение его уже не меняет. Неверный порт останавливает запуск:

```text
[bazis] configuration error: Invalid configuration (environment "development"):
http.port — must be a TCP port (0-65535) (BAZIS_HTTP__PORT).
```

Настройки доступны и сервисам: `ConfigView<typeof httpConfig>`, `httpConfig` —
из `bazis/core/http`. С версии 0.138.0.

## Остановка

По сигналу `SIGINT` (Ctrl+C) или `SIGTERM` (так останавливают Docker и
Kubernetes) приложение останавливается плавно:

1. Сервер перестаёт принимать новые соединения.
2. Запросы, которые уже выполняются, дорабатывают до конца.
3. Останавливаются фоновые службы, закрываются подключения.

Проверено на запросе, который длится 2 секунды: `SIGTERM` пришёл через
полсекунды после его начала, клиент всё равно получил `200`, а процесс
завершился с кодом 0.

На всю остановку отводится 10 секунд (`kernel.shutdownTimeoutMs`). Не
успели — процесс завершается принудительно с кодом 1, незаконченные запросы
обрываются:

```text
[bazis] Graceful shutdown did not finish within 500ms. Forcing exit.
```

Второй Ctrl+C во время остановки завершает процесс сразу, с кодом 130.

### Коды выхода

| Код | Когда |
| --- | --- |
| `0` | Обычная остановка по сигналу |
| `1` | Ошибка настроек или графа сервисов при запуске; необработанная ошибка; остановка не уложилась в тайм-аут |
| `130` | Второй сигнал во время остановки |
| Свой | `lifetime.stop(код)` — остановка из кода |

### Остановка из кода

Сервис `ApplicationLifetime` из `bazis/core/kernel` останавливает
приложение так же плавно, как сигнал:

```ts
import { ApplicationLifetime } from "bazis/core/kernel";

export class MaintenanceService {
  constructor(private readonly lifetime: ApplicationLifetime) {}

  shutdownForUpdate() {
    this.lifetime.stop(3);           // процесс завершится с кодом 3
  }
}
```

### Необработанные ошибки

Если ошибка не поймана нигде — например, упал `Promise`, запущенный без
`await` и без `.catch`, — приложение пишет её в журнал и плавно
останавливается с кодом 1:

```text
error: Unhandled error, shutting down {"error":{"name":"Error","message":"forgotten promise",...}}
```

Так процесс не продолжает работу в неизвестном состоянии: оркестратор
(Docker, Kubernetes, systemd) перезапустит его начисто. Проверено на
`void Promise.reject(...)` прямо в методе контроллера: клиент получил
ответ, после чего приложение остановилось. Ошибки, брошенные в самом
запросе (`throw` или отклонённый `await`), сюда не относятся — их
превращает в `500` [обработчик ошибок](errors.md).

## Опции `kernel`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `environment` | `BAZIS_ENV`, иначе `NODE_ENV`, иначе `production` | Окружение: `development`, `test` или `production` |
| `debug` | Везде, кроме production | Режим отладки |
| `shutdownTimeoutMs` | `10000` | Время на плавную остановку; `0` — без предела |
| `startupTimeoutMs` | `30000` | Время на весь запуск; `0` — без предела |
| `signals` | `["SIGINT", "SIGTERM"]` | Сигналы остановки |
| `unhandledErrorPolicy` | `"shutdown"` | Что делать с необработанной ошибкой |
| `startupReport` | `true` | Строки `bazis started` (с адресом в `listening`) и `bazis stopped` в журнале, в любом окружении |

Если окружение не задано, приложение считает себя production: забытая
переменная окружения на сервере не включит режим разработки с подробными
ошибками. `bazis dev` запускает приложение в `development`, а `bun test`
(и `bazis test`) выставляет `NODE_ENV=test`.

## Приложение без HTTP

Без поля `http` сервер не запускается — остаются фоновые службы и ядро.
Так пишут обработчики очередей, планировщики и другие фоновые процессы:

```ts
@App({ modules: [WorkerModule], infra: AppInfra })
export class Worker {}

await runApp(Worker);
```

Такое приложение тоже работает до сигнала остановки и останавливается так
же плавно.

## Дальше

- [Модули](modules.md)
- [Обработка ошибок](errors.md)
- [Жизненный цикл](../fundamentals/lifecycle.md) — фоновые службы и хуки
- [Конфигурация](../fundamentals/configuration.md)
