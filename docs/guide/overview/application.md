# Приложение

Точка входа приложения — `src/index.ts`. В нём одна главная строка —
`runApp`:

```ts
import { runApp } from "bazis/core/app";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, {
  http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true },
});
```

`registerBazisGeneratedRuntime()` подключает результат
[кодогенерации](../introduction/essentials.md#кодогенерация), `runApp` —
запускает приложение и ждёт его остановки. Когда `await runApp(...)`
завершается, приложение уже остановлено, а код выхода записан в
`process.exitCode`.

## Что происходит при запуске

1. Проверяются все настройки `defineConfig`. Нет обязательного секрета или
   значение неверного типа — приложение не стартует.
2. Собирается граф сервисов и проверяется целиком: незарегистрированные
   зависимости, нарушения `exports`, singleton, зависящий от scoped.
3. Открываются подключения инфраструктуры (база данных, кэш), затем
   запускаются фоновые службы (`background` в модулях) и HTTP-сервер.
   Контроллеры собираются со всего дерева модулей — перечислять их в
   `runApp` не нужно.
4. Приложение работает, пока не придёт сигнал остановки.

Вне production после запуска в журнале появляется строка:

```text
info: bazis started {"environment":"development","debug":true,"configKeys":2,"configMs":2.2,"containerMs":16.8,"hostedServices":2,"hooks":0,"startupMs":54.3}
```

Ошибка на шагах 1–2 останавливает запуск до открытия порта, с кодом выхода 1:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
auth.jwtSecret — required non-empty secret is not set (BAZIS_AUTH__JWTSECRET).
```

## Опции `runApp`

Все опции необязательны.

| Опция | Что делает |
| --- | --- |
| `http` | Запускает HTTP-сервер; см. ниже |
| `cache` | Кэш приложения: `cache: memory({ maxEntries: 1000 })`, `memory` — из `bazis/core/cache`. Включает `ICache`, `@Cacheable`, `@OutputCache` |
| `infra` | Подключения к базе данных, Redis и т. п. — класс с `@Infra` |
| `config` | Настройки `defineConfig`, которые не принадлежат конкретному модулю |
| `kernel` | Окружение, тайм-ауты запуска и остановки, сигналы; см. ниже |
| `grpc` | gRPC-сервер — независимо от HTTP |
| `validator` | Своя проверка моделей запросов вместо встроенной |
| `configure` | Тонкая настройка ядра: свой логгер, источники настроек |

### Опции `http`

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `port` | `3000` | Порт; `0` — любой свободный |
| `hostname` | Все интерфейсы | Адрес. Созданный CLI проект слушает `127.0.0.1`, если не задан `HOST` |
| `prefix` | — | Общий префикс маршрутов: `prefix: "api"` → `/api/tasks` |
| `health` | Выключено | `true` — маршрут `GET /health` |
| `docs` | Вне production | Документация API: `/docs` и `/docs/openapi.json`; `false` — выключить, `true` — включить и в production |
| `middleware` | — | Глобальные [middleware](middleware.md) |
| `accessLog` | Выключено | Журнал запросов |
| `cors` | Выключено | [CORS](middleware.md#cors-и-журнал-запросов) |
| `securityHeaders` | Включены | Заголовки безопасности; `false` — выключить |
| `maxBodyBytes` | 1 МиБ | Предел размера тела запроса; больше — `413` |
| `exposeErrorDetails` | Вне production | Текст и стек ошибки в ответе `500` — см. [Обработку ошибок](errors.md) |
| `errorHandler` | — | Уведомления о неожиданных ошибках и своя запись в журнал |

`/health` и `/docs` не зависят от `prefix`: с `prefix: "api"` маршруты
контроллеров переезжают на `/api/...`, а `GET /health` остаётся на месте.

```json
// GET /health
{"healthy":true,"checks":[]}
```

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
| `startupReport` | Вне production | Строка `bazis started` в журнале |

Если окружение не задано, приложение считает себя production: забытая
переменная окружения на сервере не включит режим разработки с подробными
ошибками. `bazis dev` запускает приложение в `development`, а `bun test`
(и `bazis test`) выставляет `NODE_ENV=test`.

## Приложение без HTTP

Без опции `http` сервер не запускается — остаются фоновые службы и ядро.
Так пишут обработчики очередей, планировщики и другие фоновые процессы:

```ts
await runApp(WorkerModule);
```

Такое приложение тоже работает до сигнала остановки и останавливается так
же плавно.

## Дальше

- [Модули](modules.md)
- [Обработка ошибок](errors.md)
- [Жизненный цикл](../fundamentals/lifecycle.md) — фоновые службы и хуки
- [Конфигурация](../fundamentals/configuration.md)
