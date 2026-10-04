# Спецификация DI-контейнера Osnova

> Единый документ: **спецификация** + **руководство пользователя** + **сборник лучших практик**.
> Составлен на основе анализа исходников в `src/di/**`. Всё API в примерах — реальное
> (импорты идут из `@/core/di`, то есть из `src/osnova/core/di/index.ts`). Если возможности нет — это
> явно отмечено пометкой «в текущей версии не реализовано».

Версия документа отражает состояние кода на момент анализа. Сопутствующие документы:
`DI.md` (практический гайд), `README.md` (карта папки).

---

## Оглавление

1. [Введение и мотивация](#1-введение-и-мотивация)
2. [Вдохновение](#2-вдохновение)
3. [Архитектура и описание классов](#3-архитектура-и-описание-классов)
4. [Инструкция по использованию](#4-инструкция-по-использованию)
5. [Лучшие практики](#5-лучшие-практики)
6. [Плохие практики и антипаттерны](#6-плохие-практики-и-антипаттерны)
7. [Сценарии использования](#7-сценарии-использования)
8. [API Reference](#8-api-reference)
9. [Пример полного цикла](#9-пример-полного-цикла)

---

## 1. Введение и мотивация

### Что такое Dependency Injection

**Dependency Injection (DI)** — приём, при котором объект не создаёт свои зависимости
сам (через `new`), а получает их извне — обычно через параметры конструктора.
«Кто и как создаёт зависимости» решает отдельный компонент — **DI-контейнер**.

Что это даёт:

- слабая связанность: класс зависит от интерфейса, а не от конкретной реализации;
- тестируемость: в тестах легко подставить фейк/мок;
- управляемый жизненный цикл: контейнер знает, когда создать и когда освободить объект;
- единая точка конфигурации графа зависимостей приложения.

### Какую проблему решает именно этот контейнер

Контейнер Osnova спроектирован под три жёстких ограничения проекта:

1. **Совместимость с `bun build --compile`.** Никакой runtime-рефлексии и
   `emitDecoratorMetadata` для автосвязывания. Карта зависимостей конструкторов
   строится **на build-time** генератором `scripts/di-generate.ts` в статический
   файл `src/di/generated/deps.ts`.
2. **Высокая производительность и предсказуемость.** Нормализованный «план» резолва
   кэшируется на провайдер; горячий путь не аллоцирует лишнего и не делает
   runtime-reflection.
3. **Строгая валидация графа на старте** (циклы, отсутствующие/captive-зависимости,
   несоответствие арности конструктора) — ошибки конфигурации видны при сборке
   контейнера, а не при первом запросе в проде.

### Почему не взяли готовое решение

- Большинство TS-контейнеров (`tsyringe`, `inversify`) полагаются на декораторы +
  `reflect-metadata` (runtime-рефлексия) — это плохо дружит с компиляцией в бинарник
  и добавляет внешнюю зависимость.
- Правила проекта (`.cursor/rules/osnova-core.mdc`): **без внешних npm** в
  framework/infra и совместимость с `bun build --compile`.
- Нужны были .NET-подобные возможности (scoped/keyed/open generic, `IServiceProvider`,
  `IOptions`, hosted services, graceful shutdown) в одном связном пакете без рефлексии.

---

## 2. Вдохновение

Контейнер сочетает идеи из нескольких экосистем:

| Источник | Что заимствовано |
|---|---|
| **.NET `Microsoft.Extensions.DependencyInjection`** | `ServiceCollection` → `ServiceProvider`, lifetimes `singleton/scoped/transient`, keyed-сервисы, open generics, `IServiceProvider` как инъектируемый сервис (`SERVICE_PROVIDER`), `IOptions`/`IOptionsMonitor`/`IOptionsSnapshot`, hosted services, `validateOnBuild`/`validateScopes`, `TryAdd*`/`Replace`/`Remove`, `ActivatorUtilities` (наш `createInstance`). |
| **NestJS** | Модульная модель `@Module({ imports, providers, controllers, exports })`, `@Global()`, инкапсуляция через `exports`. |
| **Angular DI** | Идея `InjectionToken` для неклассовых зависимостей. |
| **.NET Generic Host / Spring** | `Application`/`runApplication` (старт/стоп hosted services, graceful shutdown), `phase` у hosted-сервисов (Spring SmartLifecycle). |

Ключевое отличие от NestJS/Inversify/tsyringe: **нет runtime-декораторов для инъекций**.
Декораторы (`@Module`, `@Global`) применяются только для метаданных модуля; связывание
конструкторов — это codegen на build-time.

---

## 3. Архитектура и описание классов

### 3.1 Слои

```
token.ts            — токены (createToken, open generic family)
provider/           — модель провайдеров и зависимостей (Provider, ProviderDefinition, ...)
ServiceCollection   — накопление регистраций
ServiceProvider     — резолв, кэш, dispose, материализация open generic
ServiceScope        — scoped-резолв и scoped-dispose
container.ts        — DiContainer (alias над ServiceProvider)
internal/           — приватные детали (ResolutionScopeState, ServiceRegistration,
                      ResolutionPlan, NamedTokenIndex, GraphValidator, disposal, ...)
module/             — модульный слой (createContainer, @Module, DI, шорткаты)
extensions/         — интеграции (options, hosted-service, application, http-client,
                      activator, service-provider-token)
generated/deps.ts   — авто-карта зависимостей (codegen)
```

### 3.2 Токены — `token.ts`

#### `Token<T>`
```ts
type Token<T> = Class<T> | InjectionToken<T>;
```
Ключ сервиса в контейнере. Это **либо класс** (класс выступает собственным токеном),
**либо** `InjectionToken<T>` (для интерфейсов/примитивов/значений).

#### `InjectionToken<T>`
| Поле | Тип | Назначение |
|---|---|---|
| `id` | `symbol` | Уникальная идентичность токена. |
| `description` | `string` | Человекочитаемое имя; **должно совпадать с именем типа параметра** для работы auto-deps. |
| `genericFamilyId?` | `symbol` | Для закрытых generic-токенов (заполняется `family.of`). |
| `genericArgId?` | `symbol` | Идентичность аргумента generic. |
| `genericArgToken?` | `Token<unknown>` | Токен-аргумент закрытого generic. |

#### `createToken<T>(description: string): InjectionToken<T>`
Создаёт токен. `description` критичен для auto-deps (см. §4.4).
```ts
import { createToken } from "@/core/di";
interface ILogger { log(m: string): void }
const ILogger = createToken<ILogger>("ILogger"); // description === имя типа
```

#### `OpenGenericTokenFamily<TArg, TResult>` + `createOpenGenericTokenFamily(description)`
Семейство open generic-токенов. Метод `of(argument)` **канонизирован**:
`family.of(USER) === family.of(USER)` (один и тот же токен), поэтому singleton-инстанс
закрытого generic всегда один.
```ts
const REPO = createOpenGenericTokenFamily<unknown, { kind: string }>("IRepository");
const closed = REPO.of(USER); // InjectionToken<...>
```

#### `Class<T>`
```ts
type Class<T> = new (...args: any[]) => T;
```

> `tokenToDebugName(token)` (внутренняя утилита) возвращает `class.name` или
> `token.description` — используется в текстах ошибок.

### 3.3 Провайдеры — `provider/`

**`Provider<T>`** — объединение четырёх видов:

#### `ClassProvider<T, D>`
| Поле | Тип | Обяз. | Назначение |
|---|---|---|---|
| `provide` | `Token<T>` | да | Ключ сервиса. |
| `useClass` | `Class<T>` | да | Класс, создаваемый контейнером. |
| `deps?` | `D` | нет | Явные зависимости; если не заданы — берутся из codegen-карты. |

#### `FactoryProvider<T, D>`
| Поле | Тип | Обяз. | Назначение |
|---|---|---|---|
| `provide` | `Token<T>` | да | Ключ. |
| `useFactory` | `(...args) => T` или `(resolver, ...args) => T` | да | Фабрика. |
| `deps` | `D` | да | Список зависимостей (обязателен). |
| `withResolver?` | `boolean` | нет | Если `true`, первым аргументом приходит `ServiceResolver`. |

#### `AsyncFactoryProvider<T, D>`
То же, что factory, но `useAsyncFactory: (...) => Promise<T>`. Резолвится **только**
через `resolveAsync`.

#### `ValueProvider<T>`
| Поле | Тип | Обяз. | Назначение |
|---|---|---|---|
| `provide` | `Token<T>` | да | Ключ. |
| `useValue` | `T` | да | Готовое значение. Контейнер его **не создаёт и не dispose'ит**. |

#### `ProviderDefinition<T>` (класс)
Запись регистрации: `provider: Provider<T>`, `lifetime: ProviderLifetime`, `key?: ServiceKey`.

#### Дескрипторы зависимостей
- `KeyedDependency<T>` — `{ token, key }`, фабрика `keyedDependency(token, key)`.
- `NamedDependency<T>` — `{ name }`, фабрика `namedDependency(name)` (резолв по имени типа).
- `LazyDependency<T>` — `{ lazy: true, inner }`, фабрика `lazyDependency(inner)`.
- `Lazy<T>` — обёртка с полями `value: T` и `isCreated: boolean` (создаётся при первом
  обращении к `.value`).

#### `ProviderLifetime`
```ts
type ProviderLifetime = "singleton" | "scoped" | "transient";
```

#### `ResolvedDeps<D>`
Тип-маппинг: превращает список дескрипторов `D` в кортеж разрешённых значений
(`LazyDependency<X>` → `Lazy<X>`, `Token<X>`/keyed/named → `X`). Используется для
типобезопасных фабрик.

#### Type guards
`isClassProvider`, `isFactoryProvider`, `isAsyncFactoryProvider`, `isValueProvider`,
`isKeyedDependency`, `isNamedDependency`, `isLazyDependency`.

### 3.4 `ServiceCollection`

Накопитель регистраций (аналог .NET `IServiceCollection`). Методы — в §8.2.

### 3.5 `ServiceProvider` (и `DiContainer`)

Корневой контейнер. Реализует интерфейс `ServiceResolver`. Хранит:
- `registrationsByToken: Map<Token, ServiceRegistration[]>` — регистрации;
- `openGenericRegistrations` — open generic;
- `rootScopeState` — кэш/disposables/pendingAsync корня;
- `planCache: WeakMap<Provider, ResolutionPlan>` — кэш нормализованных зависимостей (горячий путь);
- `namedTokenIndex: NamedTokenIndex` — индекс «имя → токен» для name-based auto-deps;
- `options: { validateOnBuild, validateScopes }`.

`DiContainer` — тонкий наследник `ServiceProvider` без дополнительного поведения
(совместимый alias).

Конфигурация сборки — **`BuildServiceProviderOptions`**:

| Поле | Тип | По умолчанию | Назначение |
|---|---|---|---|
| `validateOnBuild?` | `boolean` | `false` | Прогнать полную валидацию графа при сборке (`GraphValidator`). |
| `validateScopes?` | `boolean` | `true` | Проверять captive-зависимости (singleton → scoped) и резолв scoped из root. |

### 3.6 `ServiceScope`

Обёртка над scope-состоянием (`ResolutionScopeState`). Тот же API резолва, что и у
контейнера, плюс `dispose()`. Создаётся через `container.createScope()`.

> **Вложенные scope не поддерживаются**: у `ServiceScope` нет метода `createScope` —
> scope создаётся только от корневого `ServiceProvider`. (в текущей версии не реализовано)

### 3.7 `ServiceResolver` (интерфейс резолва)

Реализуется и контейнером, и scope, и резолвером, который приходит в `withResolver`-фабрики:

```ts
interface ServiceResolver {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): readonly T[];
  resolveKeyed<T>(token: Token<T>, key: ServiceKey): T;
  resolveAllKeyed<T>(token: Token<T>, key: ServiceKey): readonly T[];
  resolveAsync<T>(token: Token<T>): Promise<T>;
  resolveKeyedAsync<T>(token: Token<T>, key: ServiceKey): Promise<T>;
  tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined;
  has(token: Token<unknown>, key?: ServiceKey): boolean;
}
```

`ServiceKey = string | number | symbol`.

### 3.8 Внутренние классы (`internal/`, приватные)

| Класс/файл | Назначение |
|---|---|
| `ServiceRegistration` | Неизменяемая запись: `id, token, provider, lifetime, key`. |
| `ResolutionScopeState` | Состояние scope: `cache`, `pendingAsync`, `disposables`, `disposed`, `isRoot`. |
| `ResolutionPlan` / `PlannedDependency` | Нормализованный список зависимостей провайдера (кэш). |
| `NamedTokenIndex` | Индекс «debug-имя → токен», ловит коллизии (`AmbiguousNamedDependencyError`). |
| `GraphValidator` | Build-time валидация графа (циклы, missing/captive, арность). |
| `OpenGenericRegistration` | Регистрация open generic family + фабрика провайдера. |
| `disposal.ts` | `disposeTracked` — LIFO-освобождение (`dispose`/`disposeAsync`/`Symbol.dispose`/`Symbol.asyncDispose`). |

### 3.9 Модульный слой (`module/`)

- **`@Module(metadata)`** — кладёт метаданные на класс (`Object.assign`).
- **`@Global()` / `markGlobal(module)`** — помечает модуль глобальным.
- **`createContainer(rootModule, options?)`** — обходит дерево модулей, собирает
  `ServiceCollection`, проверяет инкапсуляцию, строит `DiContainer`. Автоматически
  регистрирует `SERVICE_PROVIDER`.
- **`DI`** — статический низкоуровневый конструктор провайдеров/определений.
- **Шорткаты** — `singleton/scoped/transient/singletonFactory/...` (см. §8.4).
- **`ModuleRegistrar`** (реализует `DiRegistrar`) — императивная регистрация в `configure(di)`.
- **`collectModuleControllers(roots, extra?)`** — собирает `@Controller`-классы из дерева модулей.

**`OsnovaModuleMetadata`** (поля модуля):

| Поле | Тип | Назначение |
|---|---|---|
| `imports?` | `readonly OsnovaModuleRef[]` | Импортируемые модули. |
| `config?` | `ModuleConfig \| readonly ModuleConfig[]` | Config-объекты владельца модуля; `runApp` валидирует их до старта. |
| `providers?` | `readonly ProviderDefinition[]` | Регистрации (через шорткаты/`DI`). |
| `controllers?` | `readonly Class<object>[]` | HTTP-контроллеры (регистрируются scoped). |
| `exports?` | `readonly ModuleExport[]` | Что видно импортёрам. Нет поля → модуль открыт; `[]` → полностью приватный. |
| `global?` | `boolean` | Экспорты видны всем без импорта. |
| `configure?(di)` | `(di: DiRegistrar) => void` | Императивная донастройка. |

`ModuleExport = Token<unknown> | OpenGenericTokenFamily`.

### 3.10 Расширения (`extensions/`)

- **`SERVICE_PROVIDER`** — токен самого контейнера (`IServiceProvider`).
- **Options**: `Options<T>`, `createOptionsToken`, `addOptions`, `addValidatedOptions`,
  `validateOptionsOnStart`, `OPTIONS_STARTUP_VALIDATOR`, `ValidatedOptionsConfig`.
- **Reloadable options**: `OptionsMonitor<T>`, `OptionsSnapshot<T>`,
  `addReloadableOptions`, `createReloadableOptionsTokens` и т.д.
- **Hosted services**: `HostedService`, `HOSTED_SERVICE`, `addHostedService`,
  `startHostedServices`, `stopHostedServices`.
- **Application**: `Application`, `runApplication`, `RunApplicationOptions`.
- **Activator**: `createInstance`, `ActivatorDependency`.
- **HTTP client**: `HttpClient`, `addHttpClientFactory`, `HTTP_CLIENT_FACTORY` и др.
  (интеграция, не ядро DI).

### 3.11 Расширяемость через хуки

- `registerClassProviderHook(hook)` — инфраструктура (кэш и т.п.) может перехватить
  регистрацию class-провайдера (`ClassProviderHook`, `ClassProviderRegistration`).
- `registerNamedDependencyEncapsulationHook(hook)` — кастомные правила видимости для
  named-зависимостей (open generics ORM и т.п.).

---

## 4. Инструкция по использованию

### 4.1 Создание контейнера

Способ A — **из модулей** (рекомендуется для приложения):

```ts
import { createContainer, Module, singleton } from "@/core/di";

@Module({ providers: [singleton(ILogger, ConsoleLogger)] })
class AppModule {}

const container = createContainer(AppModule, { validateOnBuild: true });
```

Способ B — **без модулей**, напрямую через `ServiceCollection` (скрипты, тесты, утилиты):

```ts
import { ServiceCollection } from "@/core/di";

const services = new ServiceCollection();
services.addSingleton({ provide: ILogger, useClass: ConsoleLogger });
const provider = services.buildServiceProvider({ validateOnBuild: true });
```

`createContainer` — это «сахар» над `ServiceCollection`: он обходит модули, складывает
провайдеры в коллекцию и дополнительно проверяет инкапсуляцию (`exports`).

### 4.2 Регистрация: по классу

```ts
import { singleton, scoped, transient } from "@/core/di";

class UserService {}

// Класс как собственный токен:
singleton(UserService);
// Через интерфейсный токен:
singleton(IUserService, UserService);
// С явными deps (нужно для примитивов):
singleton(IDbContext, BunDbContext, [DB_CONN]);
```

### 4.3 Регистрация: фабрики и значения

```ts
import {
  singletonFactory,
  singletonFactoryWithResolver,
  singletonAsyncFactory,
  singletonValue,
} from "@/core/di";

singletonValue(APP_NAME, "osnova");

singletonFactory(CACHE, [], () => new MemoryCache());

// Резолвер первым аргументом:
singletonFactoryWithResolver(REPORT, [], (resolver) => new ReportService(resolver.resolve(DB)));

// Асинхронная инициализация (БД, конфиг):
singletonAsyncFactory(DB, [], async () => connectToDb());
```

> Шорткаты-фабрики есть **только для singleton** (`singletonFactory`, `singletonAsyncFactory`,
> и `*WithResolver`). Для scoped/transient-фабрики используй низкоуровневый путь:
> `DI.scoped(DI.factoryProvider(TOKEN, deps, factory))`.

### 4.4 Разрешение: автоматическое внедрение через конструктор

Контейнер **не использует рефлексию**. Карта `имя класса → имена типов параметров`
генерируется командой `bun run di:generate` в `src/di/generated/deps.ts`. Шорткаты
(`singleton/scoped/transient`) подхватывают её автоматически.

Правила (иначе «магия» не сработает):
1. `description` токена **совпадает** с именем типа параметра конструктора.
2. Класс лежит в зоне сканирования (корень и `src/**`, кроме `node_modules`,
   `*.test.ts`, самого `src/di/`).
3. Имена классов уникальны (карта ключуется именем класса).
4. Примитивные параметры (`string`, `number`) auto-deps **не подхватывают** — задавай
   `deps` явно.
5. `Lazy<X>` поддержан из коробки (кодируется как `lazy:X`).

```ts
interface IRepo { count(): number }
const IRepo = createToken<IRepo>("IRepo");

class Repo implements IRepo { count() { return 42 } }
class Service {
  constructor(private readonly repo: IRepo) {} // найдётся по имени "IRepo"
  run() { return this.repo.count() }
}
const IService = createToken<Service>("IService");

createContainer({
  providers: [singleton(IRepo, Repo), singleton(IService, Service)],
}).resolve(IService).run(); // 42
```

`di:generate` запускается автоматически перед `test/build/start/dev/build:bin`
(скрипты `pre*` в `package.json`).

### 4.5 Разрешение: ручной резолв

```ts
const svc = container.resolve(IService);            // обычный
const all = container.resolveAll(HANDLER);          // все реализации токена
const pg  = container.resolveKeyed(DB, "pg");        // keyed
const db  = await container.resolveAsync(DB_ASYNC);  // async-фабрика
const maybe = container.tryResolve(METRICS);         // undefined вместо ошибки
const ok = container.has(METRICS);                   // проверка регистрации
```

### 4.6 Жизненные циклы

| Lifetime | Сколько экземпляров | Когда dispose |
|---|---|---|
| `singleton` | один на контейнер | при `container.dispose()` |
| `scoped` | один на scope | при `scope.dispose()` |
| `transient` | новый на каждый `resolve` | вместе со scope, из которого отрезолвлен |

```ts
const scope = container.createScope();
try {
  const handler = scope.resolve(RequestHandler); // scoped-граф запроса
} finally {
  await scope.dispose();
}
```

Правила (при `validateScopes: true`, по умолчанию):
- резолв `scoped` напрямую из корня → `ScopedServiceFromRootError`;
- `singleton`, зависящий от `scoped` (captive dependency) → ловится `validateOnBuild`
  и в рантайме.

`useValue` контейнер **не dispose'ит** (объект отдан извне). Поддерживаются
`dispose()`, `disposeAsync()`, `Symbol.dispose`, `Symbol.asyncDispose`; порядок — LIFO.

### 4.7 Keyed-сервисы, open generic, Lazy, async

```ts
// keyed
DI.keyedSingleton("console", DI.classProvider(LOGGER, ConsoleLogger));
container.resolveKeyed(LOGGER, "console");
// keyed как зависимость: DI.keyed(LOGGER, "console") в deps

// open generic
services.addOpenGeneric(REPO, "singleton", (arg) => ({
  provide: REPO.of(arg), useFactory: () => new Repository(arg), deps: [],
}));
container.resolve(REPO.of(USER));

// Lazy<T> в конструкторе разрывает циклы и откладывает создание
class OrderService { constructor(private readonly exporter: Lazy<HeavyExporter>) {} }

// async
const db = await container.resolveAsync(DB);
```

### 4.8 Опции (`IOptions`) и валидация на старте

```ts
import { addValidatedOptions, createOptionsToken, validateOptionsOnStart } from "@/core/di";

const SMTP = createOptionsToken<{ host: string; port: number }>("Smtp");
addValidatedOptions(services, SMTP, {
  load: () => ({ host: process.env.SMTP_HOST ?? "", port: Number(process.env.SMTP_PORT ?? "25") }),
  validate: (o) => (o.host ? [] : ["SMTP_HOST is required"]),
});
const provider = services.buildServiceProvider();
validateOptionsOnStart(provider);        // fail-fast: соберёт все проблемы
const smtp = provider.resolve(SMTP).value;
```

### 4.9 Перечитываемый конфиг (`IOptionsMonitor` / `IOptionsSnapshot`)

```ts
import { addReloadableOptions, createReloadableOptionsTokens } from "@/core/di";

const LIMITS = createReloadableOptionsTokens<{ rps: number }>("RateLimits");
addReloadableOptions(services, LIMITS, {
  load: () => ({ rps: Number(process.env.RPS ?? "100") }),
  validate: (o) => (o.rps > 0 ? [] : ["RPS must be positive"]),
});
const provider = services.buildServiceProvider();

const monitor = provider.resolve(LIMITS.monitor);  // singleton
monitor.current.rps;
const sub = monitor.onChange((o) => console.log(o.rps));
monitor.reload(); // перечитать + провалидировать + уведомить
sub.dispose();

const scope = provider.createScope();
scope.resolve(LIMITS.snapshot).value.rps; // scoped, стабилен в рамках scope
```

> `reload()` — **явный**. Автоматического отслеживания изменений конфига
> (change-tokens/file-watcher) в ядре нет (в текущей версии не реализовано) — вызывай
> `reload()` сам из своего вотчера/админ-ручки.

### 4.10 Hosted services и graceful shutdown

```ts
import { addHostedService, runApplication, Application } from "@/core/di";

addHostedService(services, () => ({
  async start() { /* поднять http-сервер */ },
  async stop() { /* остановить */ },
}));
const provider = services.buildServiceProvider({ validateOnBuild: true });

// Вариант 1: блокирующий запуск до SIGINT/SIGTERM
await runApplication(provider);

// Вариант 2: ручное управление
const app = await Application.start(provider);
await app.stop();
```

Гарантии: старт по порядку регистрации, стоп — в обратном; упавший `start()` откатывает
уже запущенные сервисы и dispose'ит контейнер; упавший `stop()` не прерывает остановку
остальных (ошибки собираются в `AggregateError`). `Application.start` сам вызывает
`validateOptionsOnStart`.

### 4.11 Интеграция с HTTP (scope на запрос)

```ts
import { SERVICE_PROVIDER } from "@/core/di";

const provider = container.resolve(SERVICE_PROVIDER); // сам контейнер
Bun.serve({
  async fetch(request) {
    const scope = provider.createScope();
    try {
      return await scope.resolve(RequestHandler).handle(request);
    } finally {
      await scope.dispose();
    }
  },
});
```

### 4.12 `createInstance` — DI + ручные аргументы

```ts
import { createInstance, keyedDependency } from "@/core/di";

class ReportJob { constructor(private readonly db: Db, private readonly title: string) {} }

// Конвенция: DI-зависимости первыми, ручные аргументы последними.
const job = createInstance(scope, ReportJob, [DB], "Q3");
const job2 = createInstance(scope, ReportJob, [keyedDependency(DB, "replica")], "Audit");
```

> Это reflection-free аналог .NET `ActivatorUtilities.CreateInstance`: список
> DI-зависимостей **явный** (токены/keyed), авто-подбор по типам отсутствует.

---

## 5. Лучшие практики

### 5.1 Организация модулей

- Один модуль = одна зона ответственности; wiring — в `@Module`, поведение — в
  классах-сервисах (см. `osnova-modules.mdc`).
- Прячь внутренние сервисы через `exports`: импортёрам видно только перечисленное.
- `global: true` — **только** для настоящей инфраструктуры (kernel, конфиг, lifetime).

```ts
@Module({
  providers: [singleton(POOL, ConnectionPool), singleton(DB, PgDb)],
  exports: [DB], // POOL остаётся приватным
})
class DatabaseModule {}
```

### 5.2 Интерфейсы и токены вместо классов

Завязывайся на абстракцию: токен интерфейса + реализация. Это упрощает подмену в
тестах и не тянет конкретный класс в потребителя.

```ts
const IUserStore = createToken<IUserStore>("IUserStore");
scoped(IUserStore, UserService); // потребители зависят от IUserStore
```

### 5.3 Тестирование (подмена зависимостей)

Самый простой путь — собрать граф через `ServiceCollection` и подменить нужное:

```ts
const services = new ServiceCollection();
services.addSingleton({ provide: IClock, useValue: { now: () => "2020-01-01" } });
services.addSingleton({ provide: IUserService, useClass: UserService });
const provider = services.buildServiceProvider({ validateOnBuild: true });
```

Либо `replace(token, provider, lifetime)` поверх уже накопленных регистраций, либо
keyed-варианты для нескольких реализаций.

### 5.4 Как избежать циклических зависимостей

- Пересмотри дизайн (выдели третий сервис/интерфейс).
- Разорви цикл через `Lazy<T>`: `validateOnBuild` проверяет существование lazy-зависимости,
  но **не обходит** её как ребро графа — поэтому `A → Lazy<B>`, `B → A` легально.

```ts
class A { constructor(private readonly b: Lazy<B>) {} }
class B { constructor(private readonly a: A) {} }
```

Прямые циклы без `Lazy` ловятся как `CircularDependencyError` (рантайм) и
`Cycle detected: ...` (`validateOnBuild`).

### 5.5 Singleton vs Scoped vs Transient

- **Singleton** — без состояния запроса: логгеры, конфиг, пулы, кэши.
- **Scoped** — состояние одного запроса: контекст запроса, контроллеры, per-request
  репозитории.
- **Transient** — каждый раз новый, обычно лёгкий и короткоживущий. Если у transient
  есть `dispose()`, резолвь его **из scope**, а не из root (иначе dispose-список копится
  до `container.dispose()`).

---

## 6. Плохие практики и антипаттерны

### 6.1 Service Locator в бизнес-коде

```ts
// ❌ Плохо: класс тащит контейнер и сам достаёт зависимости.
class OrderService {
  constructor(private readonly provider: ServiceProvider) {}
  process() { const db = this.provider.resolve(DB); /* ... */ }
}
```
Почему плохо: зависимость скрыта, класс нетестируем без контейнера, граф ломается,
`validateOnBuild` не видит реальных рёбер.

```ts
// ✅ Хорошо: зависимости в конструкторе, резолвит composition root.
class OrderService { constructor(private readonly db: Db) {} }
```

### 6.2 Прямое обращение к контейнеру из домена

```ts
// ❌ Глобальный контейнер «чтобы было».
export const globalContainer = createContainer(AppModule);
class PriceCalculator { calc() { return globalContainer.resolve(RATES); } }
```
Контейнер резолвит **только composition root** (entrypoint, HTTP-обвязка, тесты).
Если нужно отложенное получение — `Lazy<T>`, а не контейнер в конструкторе.

### 6.3 Сложная логика в фабриках

```ts
// ❌ Фабрика делает ветвление, IO и валидацию.
singletonFactory(SERVICE, [], () => {
  if (process.env.MODE === "a") { /* 30 строк */ } else { /* ещё 30 */ }
});
```
Фабрика должна только **собрать** объект. Логику вынеси в сам сервис или в отдельные
keyed-реализации; для конфигурации — `addValidatedOptions`.

### 6.4 Переусложнение токенов

```ts
// ❌ Токен ради токена там, где класс — сам себе токен.
const USER_SERVICE = createToken<UserService>("UserServiceTokenV2");
singleton(USER_SERVICE, UserService);
```
Если нет интерфейса/нескольких реализаций — регистрируй класс напрямую: `singleton(UserService)`.
Также: **не давай двум токенам одинаковый `description`** — при name-based auto-deps это
`AmbiguousNamedDependencyError`.

### 6.5 Неверный lifetime

```ts
// ❌ Singleton с состоянием запроса.
class RequestContext { userId?: string }
singleton(RequestContext); // утечёт состояние между запросами
```
Состояние запроса — это `scoped`.

### 6.6 Ручная правка `generated/deps.ts`

Файл генерируется. Меняй конструкторы и запускай `bun run di:generate`, а не правь карту руками.

---

## 7. Сценарии использования

**Где DI уместен:**

| Компонент | Lifetime (типично) |
|---|---|
| HTTP-контроллеры (`@Controller`) | scoped (регистрируются автоматически) |
| Сервисы приложения / use-cases | singleton или scoped |
| Репозитории / доступ к данным | scoped (per-request) или singleton |
| Обработчики команд/событий, джобы | transient или scoped |
| Мидлвары/инфраструктура | singleton |
| Конфиг (`IOptions`/`OptionsMonitor`) | singleton (snapshot — scoped) |
| Hosted services (фоновые процессы) | через `addHostedService` |

**Где DI не нужен:**

- чистые функции без состояния и зависимостей (утилиты, мапперы, хелперы) — их проще
  импортировать напрямую;
- константы и литералы, не требующие подмены;
- мелкие value-объекты, создаваемые в большом количестве в горячем цикле, — DI добавит
  ненужный overhead (если только это не явный transient через `createInstance`).

---

## 8. API Reference

> `ServiceKey = string | number | symbol`. Все импорты — из `@/core/di`.

### 8.1 Создание токенов

| Сигнатура | Описание |
|---|---|
| `createToken<T>(description: string): InjectionToken<T>` | Токен для интерфейса/значения. |
| `createOpenGenericTokenFamily<TArg, TResult>(description): OpenGenericTokenFamily<TArg,TResult>` | Семейство open generic; `.of(arg)` канонизирован. |

```ts
const ILogger = createToken<ILogger>("ILogger");
const REPO = createOpenGenericTokenFamily<unknown, IRepo>("IRepository");
```

### 8.2 `ServiceCollection`

| Метод | Возврат | Описание |
|---|---|---|
| `add(def: ProviderDefinition)` | `this` | Добавить готовое определение. |
| `addMany(defs)` | `this` | Добавить несколько. |
| `addSingleton<T>(provider)` | `this` | Singleton. |
| `addScoped<T>(provider)` | `this` | Scoped. |
| `addTransient<T>(provider)` | `this` | Transient. |
| `addKeyedSingleton/Scoped/Transient<T>(key, provider)` | `this` | Keyed-варианты. |
| `tryAddSingleton/Scoped/Transient<T>(provider)` | `boolean` | Добавить, если токен+key ещё не зарегистрирован. |
| `tryAddKeyedSingleton/Scoped/Transient<T>(key, provider)` | `boolean` | Keyed try-варианты. |
| `tryAddEnumerable(def)` | `boolean` | Добавить, если нет дубля по (token, key, реализация). |
| `replace<T>(token, provider, lifetime, key?)` | `this` | Удалить прежние и зарегистрировать заново. |
| `remove(token, key?)` | `number` | Удалить регистрации, вернуть количество. |
| `addOpenGeneric(family, lifetime, providerFactory, key?)` | `this` | Open generic. |
| `buildServiceProvider(options?)` | `ServiceProvider` | Собрать контейнер. |
| `toArray()` | `readonly ProviderDefinition[]` | Снимок определений. |
| `size` (get) | `number` | Кол-во определений. |
| `definitionsFrom(start)` | `readonly ProviderDefinition[]` | Определения с индекса (атрибуция модулей). |
| `openGenericSize` (get) | `number` | Кол-во open generic. |
| `openGenericsFrom(start)` / `openGenericToArray()` | `readonly OpenGenericRegistration[]` | Снимки open generic. |

```ts
const services = new ServiceCollection();
services.addSingleton({ provide: ILogger, useClass: ConsoleLogger });
const provider = services.buildServiceProvider({ validateOnBuild: true });
```

### 8.3 `ServiceProvider` / `DiContainer` / `ServiceScope` (резолв)

| Метод | Возврат | Описание |
|---|---|---|
| `resolve<T>(token)` | `T` | Резолв (последняя регистрация токена). |
| `resolveAll<T>(token)` | `readonly T[]` | Все реализации токена. |
| `resolveKeyed<T>(token, key)` | `T` | Keyed-резолв. |
| `resolveAllKeyed<T>(token, key)` | `readonly T[]` | Все реализации с этим key. |
| `resolveAsync<T>(token)` | `Promise<T>` | Резолв цепочки с async-фабриками. |
| `resolveKeyedAsync<T>(token, key)` | `Promise<T>` | Async keyed. |
| `tryResolve<T>(token, key?)` | `T \| undefined` | `undefined` вместо `ProviderNotFoundError` (прочие ошибки пробрасываются). |
| `has(token, key?)` | `boolean` | Зарегистрирован ли токен. |
| `createScope()` *(только ServiceProvider)* | `ServiceScope` | Новый scope. |
| `dispose()` *(только ServiceProvider)* | `Promise<void>` | Освободить singletons + корень. |
| `scope.dispose()` *(только ServiceScope)* | `Promise<void>` | Освободить scoped/transient этого scope. |

```ts
const a = container.resolve(AppService);
const all = container.resolveAll(JOB);
const db = await container.resolveAsync(DB_ASYNC);
const scope = container.createScope();
await scope.dispose();
await container.dispose();
```

### 8.4 Шорткаты регистрации (`module/shortcuts.ts`)

| Сигнатура | Описание |
|---|---|
| `singleton<T>(useClass)` / `singleton<T>(provide, useClass, deps?)` | Singleton по классу/токену. |
| `scoped<T>(useClass)` / `scoped<T>(provide, useClass, deps?)` | Scoped. |
| `transient<T>(useClass)` / `transient<T>(provide, useClass, deps?)` | Transient. |
| `singletonFactory<T,D>(provide, deps, useFactory)` | Singleton-фабрика. |
| `singletonFactoryWithResolver<T,D>(provide, deps, useFactory(resolver, ...))` | Фабрика с резолвером. |
| `singletonAsyncFactory<T,D>(provide, deps, useAsyncFactory)` | Async-фабрика. |
| `singletonAsyncFactoryWithResolver<T,D>(provide, deps, useAsyncFactory(resolver, ...))` | Async-фабрика с резолвером. |
| `singletonValue<T>(provide, useValue)` | Значение. |

> Возвращают `ProviderDefinition<T>` — кладутся в `providers` модуля или `collection.add(...)`.
> Фабричных шорткатов для scoped/transient нет — используй `DI.scoped(DI.factoryProvider(...))`.

### 8.5 `DI` (низкоуровневые конструкторы)

| Метод | Возврат | Описание |
|---|---|---|
| `DI.singleton/scoped/transient<T>(provider)` | `ProviderDefinition<T>` | Определение нужного lifetime. |
| `DI.keyedSingleton/keyedScoped/keyedTransient<T>(key, provider)` | `ProviderDefinition<T>` | Keyed-определения. |
| `DI.classProvider<T,D>(provide, useClass, deps?)` | `ClassProvider<T,D>` | Class-провайдер. |
| `DI.factoryProvider<T,D>(provide, deps, useFactory)` | `FactoryProvider<T,D>` | Factory-провайдер. |
| `DI.factoryProviderWithResolver<T,D>(provide, deps, useFactory)` | `FactoryProvider<T,D>` | Factory + резолвер. |
| `DI.asyncFactoryProvider<T,D>(provide, deps, useAsyncFactory)` | `AsyncFactoryProvider<T,D>` | Async-фабрика. |
| `DI.asyncFactoryProviderWithResolver<T,D>(...)` | `AsyncFactoryProvider<T,D>` | Async-фабрика + резолвер. |
| `DI.valueProvider<T>(provide, useValue)` | `ValueProvider<T>` | Value-провайдер. |
| `DI.keyed<T>(token, key)` | `KeyedDependency<T>` | Дескриптор keyed-зависимости для `deps`. |
| `DI.bindDeps(useClass, ...deps)` | `useClass` | Привязать deps к классу (runtime, типобезопасно к ctor). |
| `DI.injectFor(useClass, ...deps)` | `D` | То же + вернуть сам список deps. |

```ts
DI.singleton(DI.classProvider(IUserStore, UserService));
DI.singleton(DI.classProvider(Audit, Audit, [DI.keyed(LOGGER, "console")]));
```

### 8.6 Дескрипторы зависимостей

| Функция | Возврат | Описание |
|---|---|---|
| `keyedDependency<T>(token, key)` | `KeyedDependency<T>` | Конкретная keyed-реализация в `deps`. |
| `namedDependency<T>(name)` | `NamedDependency<T>` | Резолв по имени типа. |
| `lazyDependency<T>(inner)` | `LazyDependency<T>` | Ленивая зависимость (`inner` — токен/keyed/named). |

### 8.7 Модули

| Сигнатура | Описание |
|---|---|
| `createContainer(rootModule, options?: BuildServiceProviderOptions): DiContainer` | Собрать контейнер из дерева модулей. |
| `Module(metadata): ClassDecorator` | Метаданные модуля. |
| `Global(): ClassDecorator` / `markGlobal(module)` | Пометить модуль глобальным. |
| `collectModuleControllers(roots, extra?): Class<object>[]` | Собрать контроллеры из дерева модулей. |

### 8.8 Options и lifecycle

| Сигнатура | Описание |
|---|---|
| `createOptionsToken<T>(name?): InjectionToken<Options<T>>` | Токен опций (`IOptions<name>`). |
| `addOptions<T>(services, token, value): void` | Статические опции (`useValue`). |
| `addValidatedOptions<T>(services, token, config: ValidatedOptionsConfig<T>): void` | Лениво-валидируемые опции. |
| `validateOptionsOnStart(provider): void` | Fail-fast валидация всех validated-опций. |
| `createReloadableOptionsTokens<T>(name?): { monitor, snapshot }` | Пара токенов для reloadable. |
| `createOptionsMonitorToken<T>(name?)` / `createOptionsSnapshotToken<T>(name?)` | Отдельные токены monitor/snapshot. |
| `addReloadableOptions<T>(services, tokens, config): void` | Регистрирует monitor (singleton) + snapshot (scoped). |
| `addHostedService(services, factory): void` | Зарегистрировать hosted service. |
| `startHostedServices(p)` / `stopHostedServices(p)` | Старт/стоп всех hosted services. |
| `Application.start(host): Promise<Application>` / `app.stop(): Promise<void>` | Управляемый lifecycle. |
| `runApplication(host, options?): Promise<void>` | Старт + ожидание сигнала + graceful stop. |

`ValidatedOptionsConfig<T>`: `{ load: () => T; validate?: (v: T) => readonly string[] | undefined }`.

`OptionsMonitor<T>`: `current: T`, `onChange(listener): OptionsChangeSubscription`, `reload(): void`.
`OptionsSnapshot<T>`: `value: T`.

### 8.9 Activator

| Сигнатура | Описание |
|---|---|
| `createInstance<T>(resolver, useClass, deps?: ActivatorDependency[], ...runtimeArgs): T` | Создать объект: DI-зависимости (по `deps`) + ручные аргументы. |

`ActivatorDependency<T> = Token<T> | KeyedDependency<T>`.

### 8.10 Хуки расширяемости

| Сигнатура | Описание |
|---|---|
| `registerClassProviderHook(hook: ClassProviderHook): void` | Перехват регистрации class-провайдера. |
| `registerNamedDependencyEncapsulationHook(hook): void` | Кастомные правила видимости named-зависимостей. |

### 8.11 Ошибки

Все наследуют `DiError`.

| Ошибка | Когда |
|---|---|
| `ProviderNotFoundError` | резолв незарегистрированного токена (с `Resolution path`). |
| `CircularDependencyError` | цикл в графе. |
| `ScopedServiceFromRootError` | scoped из root или из singleton. |
| `ClassDependenciesMismatchError` | у класса больше ctor-параметров, чем известных deps. |
| `NamedDependencyNotFoundError` | auto-deps не нашли токен по имени типа. |
| `AmbiguousNamedDependencyError` | несколько токенов с одинаковым `description`. |
| `ServiceValidationError` | проблемы графа от `validateOnBuild`. |
| `ScopeDisposedError` | резолв из dispose'нутого scope/контейнера (в т.ч. singleton через scope после dispose корня). |
| `InvalidProviderError` | провайдер без `useClass`/`useFactory`/`useValue`. |
| `AsyncResolutionRequiredError` | синхронный `resolve` async-провайдера. |
| `OptionsValidationError` | невалидные validated/reloadable опции. |
| `ModuleEncapsulationError` | зависимость от приватного сервиса чужого модуля. |

---

## 9. Пример полного цикла

Сквозной пример: токены → реализации → модуль → контейнер → бизнес-логика → dispose.

```ts
import {
  createToken,
  createContainer,
  Module,
  scoped,
  singleton,
  type Lazy,
} from "@/core/di";

// 1. Контракты (интерфейсы) + токены.
interface IClock { now(): string }
const IClock = createToken<IClock>("IClock");

interface IUserRepo { find(id: string): string }
const IUserRepo = createToken<IUserRepo>("IUserRepo");

// Тяжёлый сервис, нужный редко — внедряем лениво.
class PdfExporter { export(data: string): string { return `pdf:${data}` } }

// 2. Реализации (deps подхватятся из generated/deps.ts по именам типов).
class UtcClock implements IClock { now() { return new Date().toISOString() } }

class UserRepo implements IUserRepo {
  find(id: string) { return `user:${id}` }
}

class UserService {
  constructor(
    private readonly repo: IUserRepo,
    private readonly clock: IClock,
    private readonly exporter: Lazy<PdfExporter>,
  ) {}

  describe(id: string): string {
    return `${this.repo.find(id)} @ ${this.clock.now()}`;
  }

  exportCard(id: string): string {
    // PdfExporter создаётся только здесь, при первом обращении к .value.
    return this.exporter.value.export(this.repo.find(id));
  }
}
const IUserService = createToken<UserService>("IUserService");

// 3. Модуль: только wiring.
@Module({
  providers: [
    singleton(IClock, UtcClock),
    singleton(PdfExporter),
    scoped(IUserRepo, UserRepo),
    scoped(IUserService, UserService),
  ],
})
class AppModule {}

// 4. Composition root: создаём контейнер с валидацией графа на старте.
const container = createContainer(AppModule, { validateOnBuild: true });

// 5. На «запрос» создаём scope и резолвим бизнес-сервис.
const scope = container.createScope();
try {
  const users = scope.resolve(IUserService);
  console.log(users.describe("42"));     // user:42 @ 2026-...
  console.log(users.exportCard("42"));   // pdf:user:42
} finally {
  // 6. Освобождаем scoped-сервисы запроса.
  await scope.dispose();
}

// 7. По завершении жизни приложения — освобождаем singletons.
await container.dispose();
```

Перед запуском/тестами карта зависимостей конструкторов обновляется автоматически
(`pretest`/`prestart`/`prebuild` → `bun run di:generate`). Для нестандартных скриптов
запусти генерацию вручную: `bun run di:generate`.

---

## Приложение: чего нет в текущей версии

Явно отсутствующие возможности (чтобы не искать их зря):

- **Декораторы инъекции** (`@Injectable`/`@Inject`) и **property/method injection** —
  только constructor injection через build-time карту.
- **Runtime-рефлексия** (`reflect-metadata`, `emitDecoratorMetadata`) — не используется.
- **Вложенные scope** (scope от scope) — `ServiceScope.createScope` отсутствует.
- **Автоматический reload конфига** по change-tokens/file-watcher — `OptionsMonitor.reload()`
  только ручной.
- **Type-based авто-подбор аргументов в `createInstance`** — список DI-зависимостей задаётся явно.
- **Декорирование/перехват уже зарезолвленных сервисов** (`Decorate`-стиль) — нет
  (есть только `registerClassProviderHook` на этапе регистрации).
- **Фабричные шорткаты для scoped/transient** — есть только `singletonFactory*`.
```
