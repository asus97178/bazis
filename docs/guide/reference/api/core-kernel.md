# `bazis/core/kernel`

Ядро приложения: запуск и остановка, окружение, настройки и секреты,
журнал, события, здоровье, жизненный цикл. Список — по пакету 0.128.0.

## Настройки и секреты

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `defineConfig(prefix, schema)` | Объявление настроек: значения по умолчанию, окружения, переменные, проверки | [Конфигурация](../../module/config/configuration.md) |
| `secret(value?)`, `Secret` | Секрет: не попадает в журнал, `reveal()` даёт значение | [Секреты](../../module/config/secrets.md) |
| `configEnum(values, default)` | Перечисление в настройках | [Объявление](../../module/config/configuration.md#объявление) |
| `ConfigView<typeof config>`, `ResolvedConfigView<T>` | Настройки в конструкторе сервиса по самому объявлению; интерфейс представления | [Объявление](../../module/config/configuration.md#объявление) |
| `configList(default?)` | Список строк в настройках: массив в коде, через запятую в окружении | [Объявление](../../module/config/configuration.md#объявление) |
| `envSource`, `argsSource`, `jsonFileSource`, `memorySource`, `secretFilesSource` | Источники значений: переменные `BAZIS_*`, `--db.host=…`, JSON-файл, объект, файлы `/run/secrets` | [Откуда берутся значения](../../module/config/configuration.md#откуда-берутся-значения) |
| `loadConfiguration(sources)` | Слить источники; поздние важнее | — |
| `Configuration` | Неизменяемый набор ключей `db.host` → строка | [Настройки вне DI](../../module/config/configuration.md#настройки-вне-di) |
| `ConfigRegistry` | Готовые настройки модулей одного ядра | — |
| `configOptions`, `addConfigOptions` | Опции, привязанные к настройкам, для пакетов | — |
| `ConfigValidationError`, `ConfigKeyMissingError` | Ошибки настроек | [Ошибки запуска](../errors/startup.md#configvalidationerror) |

## Запуск и жизненный цикл

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Bazis` | Точка входа ядра: `Bazis.run(root, options)`; `runApp` вызывает его сам | [Приложение](../../startup/application.md) |
| `KernelBuilder`, `Kernel` | Сборка и работа ядра (как `HostApplicationBuilder` в .NET) | там же |
| `Environment` | Окружение: `name`, `debug`, `isDevelopment`, `isTest`, `isProduction` | [Окружения](../../module/config/configuration.md#окружения) |
| `ApplicationLifetime` | Моменты жизни приложения и `stop(exitCode)` из любого сервиса | [Жизненный цикл](../../startup/lifecycle.md) |
| `LIFECYCLE_HOOK`, `addLifecycleHook` | Хуки `onInit`, `onBootstrap`, `onShutdown`, `onDestroy` | [Хуки](../../startup/lifecycle.md#хуки-жизненного-цикла) |
| `LifecycleCoordinator` | Порядок запуска и остановки служб и хуков | [Порядок](../../startup/lifecycle.md#порядок-запуска-и-остановки) |
| `SupervisedHostedService`, `supervised` | Перезапуск службы с паузой, если её запуск упал | [Падения и перезапуск](../../startup/lifecycle.md#падения-и-перезапуск) |
| `StartupReport` | Что нашёл и сделал запуск: подключения, схема, маршруты; для экрана запуска | [Экран запуска](../../cli/commands.md#экран-запуска) |
| `KernelError`, `StartupFailuresError`, `StartupTimeoutError`, `StartupAbortedError`, `ShutdownTimeoutError` | Ошибки запуска и остановки | [Ошибки запуска](../errors/startup.md) |

## Журнал и сквозной идентификатор

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `LOGGER` | Токен журнала; сервисы получают `Logger` по типу | [Журнал](../../deployment/logging.md) |
| `ConsoleLogger` | Журнал по умолчанию: строка на запись, фильтр уровней | [Уровни](../../deployment/logging.md#уровни) |
| `getRequestId()`, `REQUEST_ID_HEADER`, `REQUEST_ID_STATE_KEY` | Идентификатор текущего запроса | [Correlation id](../../deployment/logging.md#correlation-id) |
| `getTraceparent()`, `TRACEPARENT_HEADER`, `TRACEPARENT_STATE_KEY` | W3C `traceparent` текущего запроса | там же |
| `getOutboundCorrelationHeaders()` | Заголовки для исходящих вызовов | там же |
| `runWithRequestContext`, `runWithRequestContextAsync` | Выполнить код с контекстом запроса — например, в фоновой задаче | — |

## События

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `createEventToken<T>(name)` | Событие с типом данных | [Событие](../../module/services/events.md#событие) |
| `EventBus` | Публикация: `publish`, `publishScoped` | [Публикация](../../module/services/events.md#публикация) |
| `onEvent(EVENT, handler)`, `addEventHandler` | Подписка функцией | [Функцией](../../module/services/events.md#функцией) |
| `OnEvent(EVENT)`, `withEventSubscribers`, `eventSubscriptionsOf`, `eventsModule` | Подписка методом класса | [Методом класса](../../module/services/events.md#методом-класса) |
| `EVENT_HANDLER` | Токен подписок | — |
| `APPLICATION_STARTED`, `APPLICATION_STOPPING` | События приложения | [События приложения](../../module/services/events.md#события-приложения) |
| `EventHandlerTimeoutError` | Обработчик дольше `handlerTimeoutMs` | [Ошибки](../../module/services/events.md#ошибки) |

## Здоровье

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `HEALTH_CHECK`, `addHealthCheck` | Своя проверка для `/health` | [Своя проверка](../../deployment/health-checks.md#своя-проверка) |
| `HealthService` | Выполняет проверки с пределом времени, собирает отчёт | [Health](../../deployment/health-checks.md) |

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
