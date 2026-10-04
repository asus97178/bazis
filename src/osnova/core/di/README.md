# DI Folder Map

Карта структуры `src/osnova/core/di`. Границы ответственности и контракты ядра
описаны в [MODULE.md](MODULE.md).

## Публичный API

- `index.ts` — единая публичная точка входа DI.
- `DI.md` — подробная документация по использованию DI.

## Ядро контейнера

- `ServiceProvider.ts` — координация resolve, планы зависимостей и создание объектов.
- `ServiceCollection.ts` — регистрация сервисов.
- `ServiceScope.ts` — scoped-резолв и scoped-dispose.
- `container.ts` — совместимый alias-обертка над `ServiceProvider`.
- `token.ts` — токены DI (`createToken`, open generic family).

## Внутренние детали (не использовать напрямую)

- `internal/`:
  - `ServiceRegistry.ts` — регистрационная идентичность, keyed-поиск и материализация generics.
  - `ResolutionTracker.ts` — активные создания объектов, граф ожиданий и обнаружение циклов.
  - `ScopeLifecycle.ts` — владение scopes и ресурсами, правила lifetime и завершение dispose.
  - `classDeps.ts` — runtime map deps класса.
  - `ResolutionScopeState.ts` — состояние root/scope.
  - `ServiceRegistration.ts` — внутренняя запись регистрации.
  - `ResolutionPlan.ts` — нормализованный список зависимостей провайдера (кэш горячего пути).
  - `NamedTokenIndex.ts` — индекс «имя типа → токен» для name-based auto deps.
  - `GraphValidator.ts` — build-time валидация графа (циклы, missing/captive deps, арность класса).
  - `OpenGenericRegistration.ts` — внутренняя модель open generic registration.
  - `disposal.ts` — dispose/disposeAsync helper.

## Модульный слой

- `module/DI.ts` — low-level конструкторы провайдеров.
- `module/shortcuts.ts` — короткий API (`singleton/scoped/transient`).
- `module/createContainer.ts` — сборка контейнера из модулей.
- `module/encapsulation.ts` — build-time проверка изоляции модулей (`exports`).
- `module/ModuleRegistrar.ts` — helper-регистратор для `configure(di)`.
- `module/types/` — контракты модулей (`OsnovaModule`, `DiRegistrar`).
- `module/autoDeps.ts` — автоподхват deps из generated map.

## Провайдеры и типы

- `provider/`:
  - `index.ts` — экспорты провайдеров.
  - `providerGuards.ts` — type guards.
  - `types/` — все provider-контракты (`Provider`, `ClassProvider`, `FactoryProvider`, ...).

## Ошибки

- `errors/` — все DI-ошибки (один класс = один файл).

## Расширения

- `extensions/` — options, hosted services, запуск приложения и создание объектов с ручными аргументами.
- `extensions/options.ts` — options + validated options (`addValidatedOptions`, fail-fast на старте).
- `extensions/options-reloadable.ts` — reloadable options (`OptionsMonitor`/`OptionsSnapshot`, `addReloadableOptions`) — аналог .NET `IOptionsMonitor`/`IOptionsSnapshot`.
- `extensions/application.ts` — `Application`/`runApplication`: запуск hosted services и graceful shutdown.
- `extensions/activator.ts` — `createInstance`: создание объекта с миксом DI-зависимостей и ручных аргументов (аналог .NET `ActivatorUtilities`).

## Codegen

- `generated/deps.ts` — автогенерируемая карта зависимостей классов.
- `../scripts/di-generate.ts` — генератор карты.

> ⚠️ `generated/deps.ts` не редактируется вручную.

## Правила структуры

- Один класс — один файл.
- Типы лежат рядом с доменом в `types/`.
- Внешний код импортирует DI через `osnova` для common path или через
  `@/core/di` для точечного доступа.
- `internal/` считается приватным слоем контейнера.

## Style Rule (DI usage)

- По умолчанию используем только короткие шорткаты:
  - `singleton(...)`
  - `scoped(...)`
  - `transient(...)`
- Низкоуровневый путь (`DI.classProvider(...)`, `DI.factoryProvider(...)`) используем только для редких кейсов, где действительно нужна ручная настройка.

## Contributing Checklist

Перед коммитом DI-изменений проверь:

1. **Структура файлов**
   - runtime-классы в доменных папках (`module/`, `errors/`, `extensions/`, root ядро);
   - внутренние служебные детали только в `internal/`;
   - type-only контракты в ближайшем `types/`.

2. **Публичный API**
   - если добавляешь внешний API, экспортируй его из `src/osnova/core/di/index.ts`;
   - не экспортируй `internal/*` во внешний контракт.

3. **Codegen магия**
   - настрой закреплённый Bun по [инструкции toolchain](../../../../toolchain/README.md);
   - после изменения конструкторов сервисов запусти `./scripts/osnova-bun run di:generate`;
   - не редактируй `src/osnova/core/di/generated/deps.ts` вручную;
   - выполняй тесты и сборку через `./scripts/osnova-bun run test` и
     `./scripts/osnova-bun run build:bin` (в них есть автогенерация).
