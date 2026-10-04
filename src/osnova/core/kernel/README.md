# Kernel Folder Map

Application/Kernel-слой Osnova: единый жизненный цикл приложения поверх DI.
Лучшие практики: .NET Generic Host (two-phase builder, lifetime, shutdown timeout),
Spring (фазы старта, события, profiles), Symfony (явный Kernel, конфиг-схема модуля),
NestJS (granular lifecycle-хуки, global-модули) — всё без рефлексии и AOT-совместимо.

Контракты исправлений lifecycle и конфигурации: [частичный паспорт](MODULE.md).

## Точка входа

- `Osnova.ts` — фасад: `Osnova.run(AppModule)` однострочник, `Osnova.createBuilder(...)` для тонкой настройки.
- `KernelBuilder.ts` — мутабельная фаза конфигурирования; `build()` отдаёт иммутабельный `Kernel`.
- `Kernel.ts` — ядро: `start()/stop()/run()` с общей операцией для повторных вызовов, сигналы, unhandled errors, exit codes, startup report. Startup deadline покрывает также started callbacks и события.

## Жизненный цикл

- `LifecycleCoordinator.ts` — порядок boot/shutdown: options fail-fast → `onInit` → hosted services по фазам → `onBootstrap`; остановка в обратном порядке с `shutdownTimeout`; rollback при падении старта.
- `ApplicationLifetime.ts` — инжектируемый lifetime: `onStarted/onStopping/onStopped` + программный `stop(exitCode)`.
- `lifecycleHooks.ts` — токен `LIFECYCLE_HOOK` (enumerable) + `addLifecycleHook`.
- `Environment.ts` — окружение (`development|production|test`) из `OSNV_ENV`/`NODE_ENV`, флаг `debug`.
- `SupervisedHostedService.ts` — retry с экспоненциальным backoff; передаёт startup signal и прекращает повторы при отмене.
- `logging/ConsoleLogger.ts` — стандартный structured logger; fields
  редактируются через `@osnova/library/redaction` по умолчанию. Сырые fields
  разрешены только явным `redaction: false` для доверенной локальной
  диагностики.

## Конфигурация (`config/`)

- `Configuration.ts` — собственный снимок плоского конфига (`db.host` → строка), типизированные геттеры, `loadConfiguration`.
- `defineConfig.ts` — неизменяемое объявление с overrides окружения, отдельным `resolve(environment?, configuration?)` и DI-токеном `token`. Одно объявление используется в нескольких kernel.
- `ConfigRegistry.ts` — одно проверенное представление объявления на kernel; `get(definition)` возвращает тот же объект, что и DI по `definition.token`.
- `sources.ts` — источники: `memorySource`, `envSource` (`OSNV_DB__HOST` → `db.host`), `argsSource` (`--db.host=x`), `jsonFileSource` (файл рядом с бинарником).
- `addConfigOptions.ts` — `configOptions(token, { bind, validate })`: validated options модуля, читающие из `Configuration`; kernel валидирует все на старте одной ошибкой.
- `Secret.ts` — секрет с redaction: `toString/toJSON/inspect` печатают `***`, значение только через `reveal()`.

Реализована [архитектура конфигурации каждого kernel](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation):
объявление общее и неизменяемое, окружение и рассчитанные значения принадлежат
отдельному kernel. Временный запрет повторного использования объявления снят.
Прямые `get/has` объявления предназначены для standalone-кода; `ensureValid`
больше не переключает их окружение. Контракты и проверки — в
[паспорте](MODULE.md#config-isolation-decision) и [описании config](config/README.md).

## События (`events/`)

- `EventToken.ts` — типизированные события без рефлексии (`createEventToken<T>`).
- `EventBus.ts` — шина поверх DI (`resolveAllKeyed`); ошибки handler агрегируются. Опциональный `signal` прекращает ожидание и запуск оставшихся обработчиков, включая `isolate`-режим. Уже выполняющийся пользовательский код продолжает отвечать за свои эффекты.
- `onEvent.ts` — подписка из модуля (`providers: [onEvent(EVT, handler)]`) или коллекции.
- `kernelEvents.ts` — `APPLICATION_STARTED`, `APPLICATION_STOPPING`.

## Health (`health/`)

- `HealthCheckContracts.ts` — `HEALTH_CHECK` токен (enumerable), типы отчёта.
- `HealthService.ts` — агрегатор: упавший check помечается unhealthy, не валит отчёт; `kernel.health()`.

## Ошибки (`errors/`)

- `KernelError` (база), `StartupAbortedError`, `StartupTimeoutError`, `ShutdownTimeoutError`, `ConfigKeyMissingError`. При тайм-ауте очистки после неудачного старта `ShutdownTimeoutError.cause` сохраняет исходную ошибку.

## Принципы

- Two-phase: после `build()` ничего нельзя дорегистрировать.
- Kernel-инфраструктура (`Environment`, `Configuration`, `ApplicationLifetime`, `EventBus`, `HealthService`) — global-модуль: доступна любому модулю без импорта.
- Никакой рефлексии и dynamic import; конфиг живёт снаружи бинарника.
- Kernel работает только на старте/остановке — горячих путей в рантайме нет.
- Внешний код импортирует kernel через `@osnova/core/kernel`.
