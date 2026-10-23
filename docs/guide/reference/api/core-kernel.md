# `bazis/core/kernel`

Ядро приложения: запуск и остановка, окружение, настройки и секреты,
журнал, события, здоровье, жизненный цикл. Список — по пакету 0.115.1.

## Настройки и секреты

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `defineConfig(prefix, schema)` | Объявление настроек: значения по умолчанию, окружения, переменные, проверки | [Конфигурация](../../fundamentals/configuration.md) |
| `secret(value?)`, `Secret` | Секрет: не попадает в журнал, `reveal()` даёт значение | [Секреты](../../security/secrets.md) |
| `configEnum(values, default)` | Перечисление в настройках | [Объявление](../../fundamentals/configuration.md#объявление) |
| `envSource`, `argsSource`, `jsonFileSource`, `memorySource`, `secretFilesSource` | Источники значений: переменные `BAZIS_*`, `--db.host=…`, JSON-файл, объект, файлы `/run/secrets` | [Откуда берутся значения](../../fundamentals/configuration.md#откуда-берутся-значения) |
| `loadConfiguration(sources)` | Слить источники; поздние важнее | — |
| `Configuration` | Неизменяемый набор ключей `db.host` → строка | [Настройки вне DI](../../fundamentals/configuration.md#настройки-вне-di) |
| `ConfigRegistry` | Готовые настройки модулей одного ядра | — |
| `configOptions`, `addConfigOptions` | Опции, привязанные к настройкам, для пакетов | — |
| `ConfigValidationError`, `ConfigKeyMissingError` | Ошибки настроек | [Ошибки запуска](../errors/startup.md#configvalidationerror) |

## Запуск и жизненный цикл

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Bazis` | Точка входа ядра: `Bazis.run(root, options)`; `runApp` вызывает его сам | [Приложение](../../overview/application.md) |
| `KernelBuilder`, `Kernel` | Сборка и работа ядра (как `HostApplicationBuilder` в .NET) | там же |
| `Environment` | Окружение: `name`, `debug`, `isDevelopment`, `isTest`, `isProduction` | [Окружения](../../fundamentals/configuration.md#окружения) |
| `ApplicationLifetime` | Моменты жизни приложения и `stop(exitCode)` из любого сервиса | [Жизненный цикл](../../fundamentals/lifecycle.md) |
| `LIFECYCLE_HOOK`, `addLifecycleHook` | Хуки `onInit`, `onBootstrap`, `onShutdown`, `onDestroy` | [Хуки](../../fundamentals/lifecycle.md#хуки-жизненного-цикла) |
| `LifecycleCoordinator` | Порядок запуска и остановки служб и хуков | [Порядок](../../fundamentals/lifecycle.md#порядок-запуска-и-остановки) |
| `SupervisedHostedService`, `supervised` | Перезапуск службы с паузой, если её запуск упал | [Падения и перезапуск](../../fundamentals/lifecycle.md#падения-и-перезапуск) |
| `StartupReport` | Что нашёл и сделал запуск: подключения, схема, маршруты; для экрана запуска | [Экран запуска](../../cli/commands.md#экран-запуска) |
| `KernelError`, `StartupFailuresError`, `StartupTimeoutError`, `StartupAbortedError`, `ShutdownTimeoutError` | Ошибки запуска и остановки | [Ошибки запуска](../errors/startup.md) |

## Журнал и сквозной идентификатор

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `LOGGER` | Токен журнала; сервисы получают `Logger` по типу | [Журнал](../../fundamentals/logging.md) |
| `ConsoleLogger` | Журнал по умолчанию: строка на запись, фильтр уровней | [Уровни](../../fundamentals/logging.md#уровни) |
| `getRequestId()`, `REQUEST_ID_HEADER`, `REQUEST_ID_STATE_KEY` | Идентификатор текущего запроса | [Correlation id](../../fundamentals/logging.md#correlation-id) |
| `getTraceparent()`, `TRACEPARENT_HEADER`, `TRACEPARENT_STATE_KEY` | W3C `traceparent` текущего запроса | там же |
| `getOutboundCorrelationHeaders()` | Заголовки для исходящих вызовов | там же |
| `runWithRequestContext`, `runWithRequestContextAsync` | Выполнить код с контекстом запроса — например, в фоновой задаче | — |

## События

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `createEventToken<T>(name)` | Событие с типом данных | [Событие](../../fundamentals/events.md#событие) |
| `EventBus` | Публикация: `publish`, `publishScoped` | [Публикация](../../fundamentals/events.md#публикация) |
| `onEvent(EVENT, handler)`, `addEventHandler` | Подписка функцией | [Функцией](../../fundamentals/events.md#функцией) |
| `OnEvent(EVENT)`, `withEventSubscribers`, `eventSubscriptionsOf`, `eventsModule` | Подписка методом класса | [Методом класса](../../fundamentals/events.md#методом-класса) |
| `EVENT_HANDLER` | Токен подписок | — |
| `APPLICATION_STARTED`, `APPLICATION_STOPPING` | События приложения | [События приложения](../../fundamentals/events.md#события-приложения) |
| `EventHandlerTimeoutError` | Обработчик дольше `handlerTimeoutMs` | [Ошибки](../../fundamentals/events.md#ошибки) |

## Здоровье

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `HEALTH_CHECK`, `addHealthCheck` | Своя проверка для `/health` | [Своя проверка](../../fundamentals/health-checks.md#своя-проверка) |
| `HealthService` | Выполняет проверки с пределом времени, собирает отчёт | [Health](../../fundamentals/health-checks.md) |

## Типы

- **Настройки:** `AppConfig`, `ConfigDefinition`, `ConfigSchema`,
  `ConfigShape`, `ConfigView`, `ConfigEnum`, `ConfigValueType`,
  `ConfigSource`, `ConfigInspection`, `ConfigIssue`, `ConfigIssueKind`,
  `ConfigOptionsBinding`, `SchemaFor`, `SecretSpec`, `ValidatableConfig`.
- **Ядро:** `KernelOptions`, `KernelRuntimeOptions`, `KernelTimings`,
  `EnvironmentName`, `UnhandledErrorPolicy`, `RootModuleInput`,
  `LifecycleHook`, `RestartPolicy`, `StartupFailure`.
- **Отчёт о запуске:** `ConnectionDescription`, `ConnectionFact`,
  `ListenerFact`, `RouteFact`, `SchemaFact`, `TimingFact`.
- **Журнал:** `Logger`, `LogLevel`, `LogFields`, `ConsoleLoggerOptions`,
  `RequestLogContext`.
- **События:** `EventToken`, `EventHandler`, `EventSubscription`,
  `OnEventOptions`, `SubscribeOptions`, `PublishOptions`,
  `PublishErrorContext`, `EventsModuleConfig`, `ApplicationStartedEvent`,
  `ApplicationStoppingEvent`.
- **Здоровье:** `HealthCheck`, `HealthCheckOptions`, `HealthCheckResult`,
  `HealthReport`, `HealthReportEntry`.

Параметры ядра — в [Параметрах конфигурации](../configuration.md#kernel).
