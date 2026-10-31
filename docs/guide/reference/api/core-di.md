# `bazis/core/di`

Внедрение зависимостей: модули, регистрации, токены, контейнер, ошибки
графа. Список — по пакету 0.126.0.

## Модули

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Module(metadata)` | Декоратор модуля: `imports`, `providers`, `exports`, `controllers`, `config`, `background`, `gateways`… | [Модули](../../overview/modules.md) |
| `Global()` | Модуль, чьи `exports` видны всем без `imports` | [Глобальные модули](../../overview/modules.md#глобальные-модули) |
| `markGlobal(module)` | То же для модуля, созданного кодом | — |

## Регистрация

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `singleton(X)`, `scoped(X)`, `transient(X)` | Класс с временем жизни; `singleton(Contract, Impl)` — реализация по контракту | [Провайдеры](../../overview/providers.md) |
| `singletonValue(TOKEN, value)` | Готовое значение | [Значения и фабрики](../../overview/providers.md#значения-и-фабрики) |
| `singletonFactory(TOKEN, [deps], factory)`, `singletonFactoryWithResolver` | Результат функции; `WithResolver` получает ещё и контейнер | [Фабрики](../../fundamentals/dependency-injection.md#фабрики) |
| `singletonAsyncFactory`, `singletonAsyncFactoryWithResolver` | Результат асинхронной функции; создаётся при запуске | там же |
| `createToken<T>(name)` | Токен для значения или интерфейса | [Интерфейс и токен](../../overview/providers.md#интерфейс-и-токен) |
| `keyedDependency`, `namedDependency`, `lazyDependency`, `optionalDependency` | Зависимость по ключу, по имени, ленивая, необязательная — в списке зависимостей фабрики | [Внедрение зависимостей](../../fundamentals/dependency-injection.md) |
| `DI` | Низкоуровневые регистрации: `DI.keyedSingleton`, `DI.classProvider`, `DI.factoryProvider`, `DI.valueProvider`, `DI.externallyOwned`, `DI.bindDeps`… | [Ключи](../../fundamentals/dependency-injection.md#ключи) |
| `ProviderDefinition` | Регистрация, которую возвращают функции выше | — |
| `SERVICE_PROVIDER` | Токен самого контейнера (как `IServiceProvider` в .NET) | — |

## Контейнер

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `createContainer(root, options)` | Контейнер из дерева модулей; `overrides` — замены для тестов | [Контейнер вручную](../../fundamentals/dependency-injection.md#контейнер-вручную) |
| `DiContainer`, `ServiceProvider`, `ServiceScope`, `ServiceCollection` | Контейнер, провайдер сервисов (в scoped-сервисе — область запроса), область, набор регистраций | там же |
| `createInstance(resolver, Class, deps?)` | Создать класс с зависимостями из контейнера, без регистрации (как `ActivatorUtilities` в .NET) | — |

## Службы хоста

| Экспорт | Что это |
| --- | --- |
| `HOSTED_SERVICE` | Токен служб, которые запускаются и останавливаются с приложением |
| `HOSTED_SERVICE_HEALTH` | Проверки здоровья фоновых служб модулей |
| `addHostedService`, `startHostedServices`, `stopHostedServices` | Регистрация и запуск служб без ядра |
| `Application`, `runApplication` | Запуск служб поверх контейнера без ядра; приложения запускают `runApp` |

## Опции

Механизм в духе `IOptions` .NET. Настройки приложения объявляются через
`defineConfig` ([Конфигурация](../../fundamentals/configuration.md)); эти
функции — для пакетов.

| Экспорт | Что это |
| --- | --- |
| `addOptions`, `addValidatedOptions`, `addReloadableOptions` | Опции: обычные, с проверкой, перечитываемые |
| `createOptionsToken`, `createOptionsMonitorToken`, `createOptionsSnapshotToken`, `createReloadableOptionsTokens` | Токены опций |
| `OPTIONS_STARTUP_VALIDATOR`, `validateOptionsOnStart` | Проверка всех опций при запуске одной `OptionsValidationError` |

## Ошибки

`DiError` и наследники: `ServiceValidationError`, `ModuleEncapsulationError`,
`ProviderNotFoundError`, `ScopedServiceFromRootError`,
`AsyncResolutionRequiredError`, `ScopeDisposedError`, `CircularDependencyError`,
`ClassDependenciesMismatchError`, `InvalidProviderError`,
`NamedDependencyNotFoundError`, `AmbiguousNamedDependencyError`,
`ModuleOwnedProviderConflictError`, `OptionsValidationError`. Тексты и что
делать — [Ошибки DI](../errors/di.md).

`isConfigurationError(error)` — ошибка ли это конфигурации: такие запуск
печатает одной строкой `[bazis] configuration error`. Это `DiError` и
ошибки, помеченные `markConfigurationError(error)`.

## Для пакетов

Расширение модулей собственными полями и каналами. Приложению не нужны.

`collectModuleConfigs`, `collectModuleControllers`, `collectModuleGateways`,
`collectModuleUiProfiles`, `expandModuleMetadata`,
`registerModuleMetadataExpander`, `createModuleOwnedMetadataChannel`,
`createModuleOwnedProviderChannel`, `registerModuleOwnedProviderContributor`,
`registerModuleOwnedContributionValidator`, `deferModuleDeclarationError`,
`markConfigurationError`, `registerNamedDependencyEncapsulationHook`, `CLASS_PROVIDER_HOOK`,
`createOpenGenericTokenFamily`.

## Типы

- **Модули:** `BazisModule`, `BazisModuleMetadata`, `BazisModuleRef`,
  `ModuleConfig`, `ModuleExport`, `DiRegistrar`, `ModuleMetadataExpander`.
- **Регистрации и токены:** `Provider`, `ClassProvider`, `FactoryProvider`,
  `AsyncFactoryProvider`, `ValueProvider`, `ProviderLifetime`,
  `ProviderDependencyList`, `ResolvedDeps`, `Token`, `InjectionToken`,
  `Class`, `AbstractClass`, `ServiceKey`, `KeyedDependency`,
  `NamedDependency`, `LazyDependency`, `Lazy`, `OptionalDependency`,
  `ActivatorDependency`, `OpenGenericTokenFamily`.
- **Контейнер:** `CreateContainerOptions`, `BuildServiceProviderOptions`,
  `ServiceResolver`, `ClassProviderHook`, `ClassProviderRegistration`.
- **Службы хоста:** `HostedService`, `HostedServiceDiagnostics`,
  `HostedServiceHealth`, `HostedServiceHealthCheck`,
  `HostedServicePlanValidator`, `RunApplicationOptions`.
- **Опции:** `Options`, `OptionsMonitor`, `OptionsSnapshot`,
  `OptionsChangeSubscription`, `ReloadableOptionsTokens`,
  `ValidatedOptionsConfig`.
- **Каналы модулей:** `ModuleOwnedContributionChannel`,
  `ModuleOwnedContributionSnapshot`, `ModuleOwnedContributionValidator`,
  `ModuleOwnedMetadataChannel`, `ModuleOwnedMetadataContribution`,
  `ModuleOwnedProviderActivation`, `ModuleOwnedProviderChannel`,
  `ModuleOwnedProviderContribution`,
  `ModuleOwnedProviderContributionContext`, `ModuleOwnedProviderContributor`,
  `ModuleOwnedValidationSnapshot`, `NamedDependencyEncapsulationContext`,
  `NamedDependencyEncapsulationHook`.
