# DI в Osnova

Практичный гайд по DI-контейнеру для модульного backend-фреймворка на Bun.js.

Быстрая навигация:
- Что использовать каждый день: `singleton/scoped/transient` (разделы 2, 6)
- Как работает auto deps без декораторов и его правила (раздел 3)
- Жизненные циклы и работа со scope (разделы 5, 6.14)
- Когда нужен manual путь через `DI.classProvider(...)` (разделы 2.1, 6.12)
- Продвинутые возможности: keyed, open generic, validateOnBuild (6.12–6.13)
- Async-инициализация и lifecycle приложения (6.15–6.16)
- `Lazy<T>` и валидируемые опции (6.17–6.18)
- Изоляция модулей через `exports` (6.19)
- Вызов DI вне модуля: composition root, scope, `ServiceCollection` (6.20)
- Справочник ошибок (раздел 8)

---

## 1) Что такое DI и зачем он в Osnova

**DI (Dependency Injection)** — это способ получать зависимости из контейнера, а не создавать их вручную.

Что это даёт:
- меньше связности между классами;
- проще тестирование;
- проще замена реализаций;
- стабильная работа при `bun build --compile` ✅

> ⚠️ Мы не используем декораторы и runtime-рефлексию.

---

## 2) Рекомендуемый стиль регистрации (default)

Основной API (используем по умолчанию):
- `singleton(...)`
- `scoped(...)`
- `transient(...)`
- `singletonFactory(...)`
- `singletonFactoryWithResolver(...)` — если фабрике нужен `ServiceResolver`
- `singletonAsyncFactory(...)` — для асинхронной инициализации (БД, конфиг); см. 6.15
- `singletonValue(...)`

Пример:

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface ILogger {
  log(message: string): void;
}
const LOGGER = createToken<ILogger>("ILogger");

class ConsoleLogger implements ILogger {
  log(message: string): void {
    console.log(message);
  }
}

const AppModule: OsnovaModule = {
  providers: [
    singleton(LOGGER, ConsoleLogger),
  ],
};

const container = createContainer(AppModule);
container.resolve(LOGGER).log("DI работает");
```

---

## 2.1) Единый стиль в проекте (правило)

Фиксируем командное правило:
- default: `singleton/scoped/transient`;
- manual: `DI.classProvider(...)` только для нестандартной ручной настройки;
- если кейс решается short API, manual API не используем.

Примеры:
- ✅ `singleton(AdminRepository)`
- ✅ `singleton(IAdminService, AdminService)`
- ⚙️ `DI.singleton(DI.classProvider(...))` (редкий исключительный кейс)

---

## 3) Auto deps без `deps` в модуле (и без декораторов)

Ты можешь писать:

```ts
providers: [
  singleton(IAdminRepository, AdminRepository),
  singleton(IAdminService, AdminService),
]
```

Даже если `AdminService` зависит от `IAdminRepository`.

Как это работает:
1. `di:generate` анализирует конструкторы классов.
2. Генерируется `src/di/generated/deps.ts` (карта: имя класса -> имена типов параметров).
3. `singleton/scoped/transient` подхватывают deps автоматически: имя типа параметра
   сопоставляется с `description` зарегистрированного токена.

### Правила, без которых магия не работает

1. **`description` токена должен совпадать с именем типа параметра.**

```ts
interface IRepo { ... }
const IRepo = createToken<IRepo>("IRepo"); // description === имя типа ✅

class Service {
  constructor(private readonly repo: IRepo) {} // найдёт токен по имени "IRepo"
}
```

   Если назвать токен иначе (`createToken<IRepo>("Repository")`), auto deps не найдут его
   и контейнер кинет `NamedDependencyNotFoundError`.

2. **Класс должен лежать в зоне сканирования генератора**: корень проекта и `src/**`.
   Не сканируются: `node_modules/`, `*.test.ts` и сам `src/di/`.

3. **Имена классов должны быть уникальны в проекте** — карта ключуется именем класса.
   При дубликате генератор напечатает `WARNING`.
   Генератор также проверяет, что для каждого имени типа существует `createToken("Имя")`
   или одноимённый класс — иначе напечатает `WARNING` ещё на build-time.

4. **Примитивные параметры (`string`, `number`, ...) не подхватываются** — для них
   указывай `deps` явно (см. пример 6.6). Генератор предупредит при `di:generate`.

5. **`Lazy<X>` поддерживается из коробки**: параметр `exporter: Lazy<HeavyExporter>`
   кодируется в карте как `"lazy:HeavyExporter"` и в рантайме инжектится
   Lazy-обёрткой вместо немедленного создания (см. 6.17).

Важно:
- `di:generate` запускается автоматически перед `test/build/start/dev/build:bin`;
- вручную запускать нужно только если ты работаешь нестандартным скриптом;
- при несинхронной карте зависимостей контейнер даст понятную ошибку резолва/валидации
  (`ClassDependenciesMismatchError`).

---

## 4) Внутренний контракт (для понимания устройства)

Шорткаты (`singleton(...)` и т.д.) создают `ProviderDefinition` — запись регистрации:

### `ProviderDefinition`

- **`provider`** — сам провайдер (см. ниже);
- **`lifetime`** — `'singleton' | 'scoped' | 'transient'`;
- **`key`** — опциональный ключ для keyed-регистраций (`DI.keyedSingleton(...)`).

### `Provider` (один из трёх видов)

#### `provide`
**Тип:** `Token<T>` (класс или `InjectionToken`)  
**Обязательное:** да, во всех видах  
Ключ сервиса в контейнере.

#### `useClass`
**Тип:** `new (...args) => T`  
**Обязательное:** для class-провайдера  
Класс, который создаётся DI.

#### `useFactory` + `withResolver`
**Тип:** `(...deps) => T` или `(resolver, ...deps) => T` (если `withResolver: true`)  
**Обязательное:** для factory-провайдера  
Фабрика создания. Резолвер передается первым аргументом **только** при явном `withResolver: true`
(хелперы `DI.factoryProviderWithResolver(...)` / `singletonFactoryWithResolver(...)` выставляют его сами).
Контейнер никогда не угадывает сигнатуру фабрики.

#### `useValue`
**Тип:** `T`  
**Обязательное:** для value-провайдера  
Готовое значение. Контейнер его не создаёт и не dispose'ит.

#### `deps`
**Тип:** `readonly (Token | KeyedDependency | NamedDependency)[]`  
Обычно задаётся:
- явно для `useFactory` (обязательное поле);
- автоматически через generated-карту для `singleton/scoped/transient(Class)`;
- через `DI.keyed(token, key)`, когда нужна конкретная keyed-реализация (см. 6.12).

---

## 5) Жизненные циклы

### `singleton`
Один экземпляр на всё приложение. Dispose — при `container.dispose()`.

### `scoped`
Один экземпляр на scope (`container.createScope()`). Dispose — при `scope.dispose()`.

> ⚠️ Резолв scoped-сервиса напрямую из root-контейнера кидает `ScopedServiceFromRootError`.
> Singleton не может зависеть от scoped — это ловит `validateOnBuild`.

### `transient`
Новый экземпляр при каждом `resolve`. Если у инстанса есть `dispose`, он будет
освобождён вместе со scope, из которого его отрезолвили (см. анти-паттерн №6).

Пример работы со scope — в 6.14.

---

## 6) Рабочие примеры

### 6.1 Простой класс

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface ILogger {
  log(message: string): void;
}
const LOGGER = createToken<ILogger>("ILogger");

class ConsoleLogger implements ILogger {
  log(message: string): void {
    console.log(message);
  }
}

const AppModule: OsnovaModule = {
  providers: [singleton(LOGGER, ConsoleLogger)],
};

createContainer(AppModule).resolve(LOGGER).log("ok");
```

---

### 6.2 Класс с зависимостью (без deps в модуле)

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface IRepo {
  count(): number;
}
const IRepo = createToken<IRepo>("IRepo");

class Repo implements IRepo {
  count(): number {
    return 42;
  }
}

class Service {
  constructor(private readonly repo: IRepo) {}

  run(): number {
    return this.repo.count();
  }
}
const IService = createToken<Service>("IService");

const AppModule: OsnovaModule = {
  providers: [
    singleton(IRepo, Repo),
    singleton(IService, Service), // deps подхватятся автоматически через generated deps map
  ],
};

console.log(createContainer(AppModule).resolve(IService).run());
```

---

### 6.3 Фабрика с особой инициализацией

```ts
import { createToken, singletonFactory, createContainer, type OsnovaModule } from "@/core/di";

interface Cache {
  get(key: string): string | undefined;
}
const CACHE = createToken<Cache>("Cache");

class MemoryCache implements Cache {
  private readonly data = new Map<string, string>([["hello", "world"]]);
  get(key: string): string | undefined {
    return this.data.get(key);
  }
}

const AppModule: OsnovaModule = {
  providers: [
    singletonFactory(CACHE, [], () => new MemoryCache()),
  ],
};

console.log(createContainer(AppModule).resolve(CACHE).get("hello"));
```

---

### 6.4 Значения (`useValue`)

```ts
import { createToken, singletonValue, createContainer, type OsnovaModule } from "@/core/di";

const APP_NAME = createToken<string>("APP_NAME");
const PORT = createToken<number>("PORT");
const CONFIG = createToken<{ env: string }>("CONFIG");

const AppModule: OsnovaModule = {
  providers: [
    singletonValue(APP_NAME, "osnova"),
    singletonValue(PORT, 3000),
    singletonValue(CONFIG, { env: "dev" }),
  ],
};

const container = createContainer(AppModule);
console.log(container.resolve(APP_NAME), container.resolve(PORT), container.resolve(CONFIG).env);
```

---

### 6.5 Интерфейсный токен + контроллер

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface IClock {
  now(): string;
}
const IClock = createToken<IClock>("IClock");

class UtcClock implements IClock {
  now(): string {
    return new Date().toISOString();
  }
}

class HealthController {
  constructor(private readonly clock: IClock) {}
  get() {
    return { ok: true, time: this.clock.now() };
  }
}

const CONTROLLER = createToken<HealthController>("HealthController");

const AppModule: OsnovaModule = {
  providers: [
    singleton(IClock, UtcClock),
    singleton(CONTROLLER, HealthController),
  ],
};

console.log(createContainer(AppModule).resolve(CONTROLLER).get());
```

---

### 6.6 Database / dbcontext в модуле

```ts
import { createToken, singleton, singletonValue, createContainer, type OsnovaModule } from "@/core/di";

interface DbContext {
  query(sql: string): string;
}
const DB_CONN = createToken<string>("DB_CONN");
const DB = createToken<DbContext>("DbContext");

class BunDbContext implements DbContext {
  constructor(private readonly conn: string) {}
  query(sql: string): string {
    return `${sql} on ${this.conn}`;
  }
}

const DatabaseModule: OsnovaModule = {
  providers: [
    singletonValue(DB_CONN, "postgres://localhost/app"),
    // Параметр конструктора имеет примитивный тип (string), поэтому auto deps
    // его не подхватят — токен указываем явно.
    singleton(DB, BunDbContext, [DB_CONN]),
  ],
};

console.log(createContainer(DatabaseModule).resolve(DB).query("select 1"));
```

> ⚠️ Auto deps работают только для параметров с именованными типами (интерфейс/класс).
> Для `string`, `number` и других примитивов указывай `deps` явно — генератор предупредит об этом при `di:generate`.

---

### 6.7 Сервис из другого модуля

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface Db {
  ping(): string;
}
const DB = createToken<Db>("Db");

class FakeDb implements Db {
  ping(): string {
    return "pong";
  }
}

class UserService {
  constructor(private readonly db: Db) {}
  check(): string {
    return this.db.ping();
  }
}
const USER_SERVICE = createToken<UserService>("UserService");

const DatabaseModule: OsnovaModule = {
  providers: [singleton(DB, FakeDb)],
};

const UserModule: OsnovaModule = {
  imports: [DatabaseModule],
  providers: [singleton(USER_SERVICE, UserService)],
};

console.log(createContainer(UserModule).resolve(USER_SERVICE).check());
```

---

### 6.8 Фоновая задача (job)

```ts
import { createToken, singleton, transient, createContainer, type OsnovaModule } from "@/core/di";

interface Logger {
  info(message: string): void;
}
const LOGGER = createToken<Logger>("Logger");

class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }
}

class CleanupJob {
  constructor(private readonly logger: Logger) {}
  run(): void {
    this.logger.info("cleanup");
  }
}
const CLEANUP_JOB = createToken<CleanupJob>("CleanupJob");

const AppModule: OsnovaModule = {
  providers: [
    singleton(LOGGER, ConsoleLogger),
    transient(CLEANUP_JOB, CleanupJob),
  ],
};

createContainer(AppModule).resolve(CLEANUP_JOB).run();
```

---

### 6.9 `onStartup` / `onShutdown`

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface Metrics {
  flush(): Promise<void>;
}
const METRICS = createToken<Metrics>("Metrics");

class InMemoryMetrics implements Metrics {
  async flush(): Promise<void> {
    console.log("flushed");
  }
}

const AppModule: OsnovaModule = {
  providers: [singleton(METRICS, InMemoryMetrics)],
};

const container = createContainer(AppModule);

async function onStartup(): Promise<void> {
  container.resolve(METRICS);
}

async function onShutdown(): Promise<void> {
  await container.resolve(METRICS).flush();
  await container.dispose();
}

await onStartup();
await onShutdown();
```

---

### 6.10 Transient для каждого resolve

```ts
import { createToken, transient, createContainer, type OsnovaModule } from "@/core/di";

class RequestContext {
  static seq = 0;
  readonly id: number;
  constructor() {
    RequestContext.seq += 1;
    this.id = RequestContext.seq;
  }
}

const REQUEST_CONTEXT = createToken<RequestContext>("RequestContext");

const AppModule: OsnovaModule = {
  providers: [transient(REQUEST_CONTEXT, RequestContext)],
};

const container = createContainer(AppModule);
console.log(container.resolve(REQUEST_CONTEXT).id, container.resolve(REQUEST_CONTEXT).id);
```

---

### 6.11 Несколько реализаций под одним токеном

Поддерживается: используем несколько регистраций + `resolveAll`.

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface Handler {
  name(): string;
}
const HANDLER = createToken<Handler>("Handler");

class AHandler implements Handler {
  name(): string {
    return "A";
  }
}

class BHandler implements Handler {
  name(): string {
    return "B";
  }
}

const AppModule: OsnovaModule = {
  providers: [
    singleton(HANDLER, AHandler),
    singleton(HANDLER, BHandler),
  ],
};

console.log(createContainer(AppModule).resolveAll(HANDLER).map((x) => x.name()));
```

---

### 6.12 Keyed-сервисы

Когда под одним токеном нужно несколько вариантов реализации:

```ts
import { DI, createContainer, createToken, type OsnovaModule } from "@/core/di";

interface ILogger {
  log(message: string): void;
}
const LOGGER = createToken<ILogger>("ILogger");

class ConsoleLogger implements ILogger {
  log(message: string): void {
    console.log(message);
  }
}

class NullLogger implements ILogger {
  log(_message: string): void {}
}

const AppModule: OsnovaModule = {
  providers: [
    DI.keyedSingleton("console", DI.classProvider(LOGGER, ConsoleLogger)),
    DI.keyedSingleton("null", DI.classProvider(LOGGER, NullLogger)),
  ],
};

const container = createContainer(AppModule);
container.resolveKeyed(LOGGER, "console").log("visible");
container.resolveKeyed(LOGGER, "null").log("silent");
```

Keyed-реализацию можно внедрить и как зависимость — через `DI.keyed(token, key)` в `deps`
(это один из легитимных кейсов manual API):

```ts
class AuditService {
  constructor(private readonly logger: ILogger) {}
  record(action: string): void {
    this.logger.log(`audit: ${action}`);
  }
}

const AppModule: OsnovaModule = {
  providers: [
    DI.keyedSingleton("console", DI.classProvider(LOGGER, ConsoleLogger)),
    DI.keyedSingleton("null", DI.classProvider(LOGGER, NullLogger)),
    DI.singleton(DI.classProvider(AuditService, AuditService, [DI.keyed(LOGGER, "console")])),
  ],
};

createContainer(AppModule).resolve(AuditService).record("login"); // audit: login
```

---

### 6.13 Open generic + validateOnBuild

```ts
import {
  ServiceCollection,
  createOpenGenericTokenFamily,
  createToken,
} from "@/core/di";

const REPO = createOpenGenericTokenFamily<unknown, { kind: string }>("IRepository");
const USER = createToken<{ id: string }>("User");

const services = new ServiceCollection();
services.addOpenGeneric(REPO, "singleton", (arg) => ({
  provide: REPO.of(arg),
  useFactory: () => ({ kind: "repo" }),
  deps: [],
}));

const provider = services.buildServiceProvider({ validateOnBuild: true });
console.log(provider.resolve(REPO.of(USER)).kind);
```

> `of()` канонизирован: `REPO.of(USER) === REPO.of(USER)`, поэтому singleton-инстанс
> закрытого generic-токена всегда один.

Явная регистрация закрытого токена имеет приоритет над open generic для того же
ключа. `resolveAll` возвращает все регистрации и не меняет последующий выбор
`resolve`/`resolveAsync`: сначала перечисляются явные регистрации, затем
материализованные generic-провайдеры; внутри каждой группы сохраняется порядок.

---

### 6.14 Scoped: один экземпляр на запрос

```ts
import { scoped, createContainer, type OsnovaModule } from "@/core/di";

class RequestContext {
  static seq = 0;
  readonly id = (RequestContext.seq += 1);
}

class RequestHandler {
  constructor(public readonly ctx: RequestContext) {}
}

const AppModule: OsnovaModule = {
  providers: [scoped(RequestContext), scoped(RequestHandler)],
};

const container = createContainer(AppModule);

const scopeA = container.createScope();
const scopeB = container.createScope();

console.log(scopeA.resolve(RequestHandler).ctx === scopeA.resolve(RequestContext)); // true
console.log(scopeA.resolve(RequestContext).id, scopeB.resolve(RequestContext).id); // 1 2

// По завершении запроса: освобождает все disposable-сервисы scope
await scopeA.dispose();
await scopeB.dispose();
```

---

### 6.15 Async-фабрики (подключение к БД и т.п.)

Для сервисов с асинхронной инициализацией — `singletonAsyncFactory` + `resolveAsync`:

```ts
import { createToken, singletonAsyncFactory, createContainer, type OsnovaModule } from "@/core/di";

interface IDb {
  query(sql: string): string;
}
const DB = createToken<IDb>("IDb");

const AppModule: OsnovaModule = {
  providers: [
    singletonAsyncFactory(DB, [], async () => {
      // например: await Bun.sql.connect(...)
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { query: (sql) => `${sql}: ok` };
    }),
  ],
};

const container = createContainer(AppModule);
const db = await container.resolveAsync(DB);
console.log(db.query("select 1"));
```

Правила:
- async-провайдер резолвится **только** через `resolveAsync(...)`; синхронный `resolve(...)`
  кинет `AsyncResolutionRequiredError` (кроме случая, когда singleton уже создан ранее);
- конкурентные `resolveAsync` одного singleton'а дедуплицируются — фабрика выполнится один раз;
- класс может зависеть от async-сервиса — резолви сам класс через `resolveAsync`;
- если фабрике нужен резолвер: `singletonAsyncFactoryWithResolver(...)`.

---

### 6.16 Application: запуск и graceful shutdown

Обвязка жизненного цикла поверх hosted services:

```ts
import { ServiceCollection, addHostedService, runApplication } from "@/core/di";

const services = new ServiceCollection();
addHostedService(services, () => ({
  async start() {
    console.log("http server started");
  },
  async stop() {
    console.log("http server stopped");
  },
}));

const provider = services.buildServiceProvider({ validateOnBuild: true });

// Стартует все hosted services, ждёт SIGINT/SIGTERM,
// останавливает их в обратном порядке и dispose'ит контейнер.
await runApplication(provider);
```

Гарантии:
- весь hosted-план проверяется через `planValidator` до первого `start()`;
  общий экземпляр валидатора вызывается один раз на версию плана, асинхронная
  проверка ожидается; валидатор должен быть чистой повторяемой проверкой
  конфигурации — при supervised retry он получает новый полный план с настоящими
  экземплярами, включая уже запущенные службы;
- старт по порядку регистрации, остановка — в обратном порядке;
- упавший `start()` откатывает уже запущенные сервисы и dispose'ит контейнер;
- упавший `stop()` не прерывает остановку остальных — все ошибки собираются
  и бросаются в конце (`AggregateError`, если их несколько);
- повторные и одновременные `app.stop()` возвращают один Promise: каждый
  вызывающий дожидается остановки и dispose, получая тот же результат или ошибку;
- для ручного управления: `const app = await Application.start(provider)` + `await app.stop()`.

Низкоуровневые `startHostedServices(provider)` / `stopHostedServices(provider)`
сохраняют экземпляры перед вызовом их `start()` за тем же объектом `provider`. Регистрация
`addHostedService` остаётся transient: остановка использует сохранённые
экземпляры, повторно фабрику не вызывает. Повторный старт активного набора
присоединяется к нему; повторная или конкурентная остановка выполняет каждый
`stop()` один раз. После завершённой остановки можно начать новый набор.
Остановка дожидается начатого старта и проходит все экземпляры, чей `start()`
был вызван, в обратном порядке: сначала освобождает ресурсы частично запущенного
сервиса, затем ранее запущенных. Ещё не запускавшиеся сервисы она не затрагивает.
Ошибка одного `stop()` не мешает очистке остальных; ошибки возвращаются после
всей очистки (`AggregateError` для нескольких). Первичная ошибка `start()` сохраняется.
После ошибки старта вызывающий код по-прежнему отвечает за вызов stop и dispose.
Helpers не освобождают контейнер: `dispose()` нужно выполнять в `finally`.
Standalone `stopHostedServices` без парного старта сохраняет прежний сценарий
ручного запуска: разрешает зарегистрированные сервисы один раз. Управляющий
запуском код не должен ожидать парный stop из собственного `start()`.

---

### 6.17 `Lazy<T>`: отложенное создание зависимости

Тяжёлая зависимость, нужная в редкой ветке кода, не обязана создаваться
вместе с потребителем — объяви её как `Lazy<T>`:

```ts
import { createContainer, singleton, type Lazy, type OsnovaModule } from "@/core/di";

class HeavyExporter {
  export(): string {
    return "pdf";
  }
}

class OrderService {
  constructor(private readonly exporter: Lazy<HeavyExporter>) {}

  exportPdf(): string {
    // HeavyExporter создаётся только здесь, при первом обращении к .value,
    // и дальше кэшируется внутри Lazy-обёртки.
    return this.exporter.value.export();
  }
}

const AppModule: OsnovaModule = {
  providers: [singleton(HeavyExporter), singleton(OrderService)],
};

createContainer(AppModule).resolve(OrderService);
// HeavyExporter ещё НЕ создан — создастся при первом exportPdf()
```

Auto deps понимает `Lazy<X>` в конструкторе автоматически (codegen кодирует
такую зависимость как `"lazy:X"`). Для ручного пути есть дескриптор:

```ts
DI.classProvider(OrderService, OrderService, [lazyDependency(HeavyExporter)] as const);
// lazyDependency принимает токен, keyedDependency(...) или namedDependency(...)
```

Правила:
- `lazy.value` — создаёт сервис при первом обращении и кэширует; `lazy.isCreated` —
  флаг «уже создан»;
- резолв идёт в том scope, где был создан потребитель: lazy в request-scope
  получит scoped-экземпляр своего scope;
- правила lifetimes действуют в момент обращения: singleton, дёрнувший
  `Lazy<scoped>.value`, получит `ScopedServiceFromRootError`;
- обращение к `.value` после dispose scope — `ScopeDisposedError`, включая
  уже закэшированное значение;
- `validateOnBuild` проверяет существование lazy-зависимости, но не обходит её
  как ребро графа — поэтому `Lazy<T>` легально разрывает циклические зависимости
  (A → Lazy<B>, B → A);
- если `.value` читается прямо при создании потребителя и замыкает ещё активный
  цикл, резолв выбрасывает `CircularDependencyError`; отложенное чтение после
  завершения создания сохраняет возможность разорвать цикл;
- не оборачивай в `Lazy` дешёвые сервисы «на всякий случай» — это лишняя
  обёртка и отложенные ошибки; используй для реально тяжёлых или редких веток.

---

### 6.18 Валидируемые опции (fail-fast конфиг)

Конфиг приходит снаружи (env, файлы) — это граница системы, валидируй её на
старте, а не при первом запросе в 3 часа ночи:

```ts
import {
  ServiceCollection,
  addValidatedOptions,
  createOptionsToken,
  validateOptionsOnStart,
} from "@/core/di";

interface SmtpOptions {
  host: string;
  port: number;
}
const SMTP = createOptionsToken<SmtpOptions>("Smtp");

const services = new ServiceCollection();
addValidatedOptions(services, SMTP, {
  load: () => ({
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? "25"),
  }),
  validate: (o) => {
    const issues: string[] = [];
    if (!o.host) issues.push("SMTP_HOST is required");
    if (!Number.isInteger(o.port) || o.port <= 0) issues.push("SMTP_PORT must be a positive integer");
    return issues;
  },
});

const provider = services.buildServiceProvider();

// Fail-fast: бросит OptionsValidationError со ВСЕМИ проблемами всех опций сразу.
validateOptionsOnStart(provider);

// Использование как обычных options:
const smtp = provider.resolve(SMTP).value;
```

Поведение:
- `load()` выполняется лениво один раз (singleton), `validate()` гейтит значение;
- невалидные опции — `OptionsValidationError` с префиксом имени:
  `IOptions<Smtp>: SMTP_HOST is required`;
- `validateOptionsOnStart(provider)` прогоняет **все** зарегистрированные
  validated options и собирает проблемы в одну ошибку;
- `Application.start` / `runApplication` вызывают эту проверку автоматически —
  приложение с битым конфигом не начнёт стартовать hosted services;
- обычный `addOptions(...)` без валидации никуда не делся — для статических
  значений он по-прежнему уместен.

---

### 6.19 Изоляция модулей (`exports`)

По умолчанию модуль **полностью открыт**: всё, что он регистрирует, видно
импортёрам (плоский граф, как раньше). Изоляция включается явным полем
`exports` — после этого импортёрам видны только перечисленные токены:

```ts
import { createToken, singleton, createContainer, type OsnovaModule } from "@/core/di";

interface Db {
  query(): string;
}
const DB = createToken<Db>("Db");

class PgDb implements Db {
  query(): string {
    return "rows";
  }
}

// Внутренняя деталь модуля — наружу не выходит.
class ConnectionPool {}
const POOL = createToken<ConnectionPool>("ConnectionPool");

@Module({
  providers: [singleton(POOL, ConnectionPool), singleton(DB, PgDb)],
  exports: [DB], // только DB виден импортёрам
})
class DatabaseModule {}

class UserService {
  constructor(private readonly db: Db) {}
}

@Module({
  imports: [DatabaseModule],
  providers: [singleton(UserService)], // зависимость от DB — ок, он экспортирован
})
class UserModule {}

createContainer(UserModule); // ок
// Если бы UserService зависел от POOL — createContainer бросил бы
// ModuleEncapsulationError ещё на старте, до первого resolve.
```

Правила:
- `exports` нет — модуль открыт, видно всё (обратная совместимость);
- `exports: []` — модуль полностью приватный;
- `exports: [TOKEN, SomeClass, FAMILY]` — наружу видны только они
  (можно экспортировать и open generic family);
- re-export: закрытый модуль может экспортировать токен, который сам
  импортировал, — тогда его увидят и импортёры этого модуля;
- `global: true` — модуль-инфраструктура (как `@Global()` в NestJS): его
  экспорты видны всем модулям без импорта. Используется kernel-слоем
  (`Environment`, `Configuration`, `ApplicationLifetime`); в прикладном коде
  применяй только для настоящей инфраструктуры;
- `name` у модуля — для понятных сообщений об ошибках.

Важно понимать:
- обычные регистрации проверяются при `createContainer`; open generic — при
  материализации закрытого провайдера, до его публикации, в том числе при
  `validateOnBuild`. Повторный резолв готовой регистрации проверку не повторяет;
- зависимости generic-провайдера и имена из codegen проверяются и привязываются
  в модуле, объявившем семейство, по тем же правилам `imports`/`exports`;
- корневой контейнер — composition root: `container.resolve(...)` видит всё,
  включая приватные сервисы (как `app.get()` в NestJS);
- нарушение — это `ModuleEncapsulationError` со списком всех проблем сразу:
  `Module "UserModule": "UserService" depends on "ConnectionPool", which is
  provided by another module but not exported.`

---

### 6.20 Вызов DI вне модуля

Модули — это место **регистрации**. Доставать сервисы из контейнера можно
(и нужно) вне модулей. Главное правило: руками резолвит только
**composition root** — entrypoint, HTTP-обвязка, тесты. Бизнес-код получает
зависимости через конструктор и о контейнере не знает.

#### Composition root: entrypoint приложения

```ts
import { createContainer } from "@/core/di";
import { AppModule } from "./app.module";

const container = createContainer(AppModule, { validateOnBuild: true });

// Полный API резолва на корневом контейнере:
const app = container.resolve(AppService);            // обычный резолв
const allJobs = container.resolveAll(JOB);            // все реализации токена
const pg = container.resolveKeyed(DB, "pg");          // keyed-сервис
const db = await container.resolveAsync(DB_ASYNC);    // async-фабрика (см. 6.15)
const maybe = container.tryResolve(METRICS);          // undefined вместо ошибки
const enabled = container.has(METRICS);               // проверка регистрации

app.run();

await container.dispose(); // в конце жизни приложения
```

Корневой контейнер видит всё, включая приватные сервисы закрытых модулей
(см. 6.19) — изоляция действует между модулями, а не для composition root.

#### Scope на запрос (HTTP-обвязка)

```ts
Bun.serve({
  async fetch(request) {
    const scope = container.createScope();
    try {
      // У scope тот же API резолва: resolve / resolveAll / resolveKeyed /
      // resolveAsync / tryResolve / has.
      return await scope.resolve(RequestHandler).handle(request);
    } finally {
      await scope.dispose(); // освобождает все scoped/transient этого запроса
    }
  },
});
```

#### Совсем без модулей: `ServiceCollection`

Для скриптов, тестов и точечных утилит модульный слой не обязателен:

```ts
import { ServiceCollection } from "@/core/di";

const services = new ServiceCollection();
services.addSingleton({ provide: LOGGER, useClass: ConsoleLogger });
services.addScoped({ provide: REQUEST_CONTEXT, useClass: RequestContext });

const provider = services.buildServiceProvider({ validateOnBuild: true });
provider.resolve(LOGGER).info("works without modules");
```

`createContainer(module)` — это сахар поверх того же `ServiceCollection`:
он лишь обходит модули, складывает провайдеры в коллекцию и проверяет
инкапсуляцию.

#### Резолвер внутри фабрики

Если сервис нужно достать в момент создания другого сервиса — не тащи
контейнер через глобальную переменную, возьми резолвер первым аргументом:

```ts
singletonFactoryWithResolver(REPORT_SERVICE, [], (resolver) => {
  const db = resolver.resolve(DB);
  return new ReportService(db);
});
```

Резолвер привязан к правильному scope: scoped-фабрика получит scoped-зависимости
своего scope, а не root.

#### Чего не делать

```ts
// Анти-паттерн: service locator в бизнес-коде.
class OrderService {
  process(): void {
    const db = globalContainer.resolve(DB); // ❌ скрытая зависимость,
  }                                         //    нетестируемо, ломает граф
}

// Правильно: зависимость в конструкторе, резолвит composition root.
class OrderService {
  constructor(private readonly db: Db) {}  // ✅ auto deps подхватит
}
```

- не храни контейнер в глобальной переменной «чтобы было»;
- не передавай контейнер/scope в конструкторы бизнес-сервисов — если очень
  нужно отложенное получение, используй `Lazy<T>` (6.17);
- частые transient с `dispose()` резолвь из scope, а не из root (см. раздел 8).

---

### 6.21 `createInstance`: DI-зависимости + ручные аргументы

Reflection-free аналог .NET `ActivatorUtilities.CreateInstance`. Нужен, когда
объект создаётся на лету и часть параметров берётся из контейнера, а часть —
передаётся вручную (доменные сущности, ad-hoc джобы):

```ts
import { createInstance, createToken, keyedDependency } from "@/core/di";

class ReportJob {
  constructor(private readonly db: Db, private readonly title: string) {}
  run(): string {
    return `${this.title}: ${this.db.query("select 1")}`;
  }
}

// Конвенция: DI-зависимости идут первыми, ручные аргументы — последними.
const job = createInstance(scope, ReportJob, [DB], "Q3 revenue");

// Keyed-зависимость — через keyedDependency(...) в списке deps:
const job2 = createInstance(scope, ReportJob, [keyedDependency(DB, "replica")], "Audit");
```

Правила:
- список DI-зависимостей **явный** (токены или `keyedDependency(...)`) — это
  сознательно, чтобы остаться без runtime-рефлексии;
- резолвер привязан к scope: внутри запроса передавай `scope`, а не root, чтобы
  scoped-зависимости пришли из нужного scope;
- ручные аргументы добавляются после разрезолвленных DI-зависимостей.

---

### 6.22 Перечитываемый конфиг: `OptionsMonitor` / `OptionsSnapshot`

Аналог .NET `IOptionsMonitor<T>` / `IOptionsSnapshot<T>` — когда конфиг может
меняться в рантайме (hot-reload файла, админ-ручка), а не только на старте:

```ts
import {
  ServiceCollection,
  addReloadableOptions,
  createReloadableOptionsTokens,
} from "@/core/di";

interface RateLimits {
  rps: number;
}
const RATE_LIMITS = createReloadableOptionsTokens<RateLimits>("RateLimits");

const services = new ServiceCollection();
addReloadableOptions(services, RATE_LIMITS, {
  load: () => ({ rps: Number(process.env.RPS ?? "100") }),
  validate: (o) => (o.rps > 0 ? [] : ["RPS must be positive"]),
});

const provider = services.buildServiceProvider();

// Monitor (singleton): всегда актуальное значение + подписка + reload.
const monitor = provider.resolve(RATE_LIMITS.monitor);
console.log(monitor.current.rps);
const sub = monitor.onChange((o) => console.log("rate limits changed:", o.rps));
monitor.reload(); // перечитать load(), провалидировать, уведомить подписчиков
sub.dispose();    // отписаться

// Snapshot (scoped): одно значение на scope/запрос, стабильно в его рамках.
const scope = provider.createScope();
const rps = scope.resolve(RATE_LIMITS.snapshot).value.rps;
```

Правила:
- **`monitor`** — singleton: `current` отдаёт последнее валидное значение;
  `reload()` повторно выполняет `load()`+`validate()`, при успехе обновляет
  `current` и уведомляет подписчиков, при провале валидации — бросает
  `OptionsValidationError` и **сохраняет прежнее значение** (подписчиков не дёргает);
- **`snapshot`** — scoped: фиксируется один раз на scope из `monitor.current`,
  поэтому в рамках запроса значение стабильно даже при reload в середине;
- reload **явный** (нет ambient-машинерии config-провайдеров) — дёргай его из
  своего файлового вотчера/админ-эндпойнта;
- интегрируется с `validateOptionsOnStart` (и `Application.start`): битый конфиг
  падает на старте, а не при первом запросе;
- `onChange(...)` возвращает подписку — **обязательно `dispose()`**, иначе
  singleton-monitor будет держать ссылку на подписчика (тот же контракт, что и
  `IDisposable` в .NET);
- для статичного/одноразового конфига по-прежнему используй `addOptions` /
  `addValidatedOptions` (6.18) — не тащи reload, если он не нужен.

---

## 7) Особенности DI в нашем фреймворке

- Без декораторов и runtime reflection.
- Dependency map строится на build-time (`src/di/generated/deps.ts`).
- Работает при `bun build --compile`.
- Есть строгая валидация графа (`validateOnBuild`, `validateScopes`).
- Поддерживаются scoped/keyed/open generic сценарии.

Практика:
- обычно достаточно short API + авто-генерации deps;
- `di:generate` уже встроен в pre-скрипты проекта.

---

## 8) Анти-паттерны и ошибки

1. Циклические зависимости в графе.
2. Резолв токена, который никто не зарегистрировал (`ProviderNotFoundError`).
3. Неверно выбранный lifetime (например, singleton с request-state).
4. Ручная правка generated-файла deps.
5. Резолв scoped-сервиса из root вместо `createScope()`.
6. Частый резолв transient-сервисов с `dispose()` из root-контейнера: их dispose-список
   копится до `container.dispose()`. Резолвь такие сервисы из scope — они освободятся
   вместе со scope.
7. Два токена с одинаковым `description` + auto deps по этому имени: контейнер кинет
   `AmbiguousNamedDependencyError`. Имена токенов должны быть уникальными.

Полезно знать про dispose:
- контейнер dispose'ит **только то, что создал сам** (`useClass` / `useFactory`);
- объекты, отданные через `useValue`, контейнер не трогает — за их жизненный цикл
  отвечает вызывающий код;
- поддерживаются `dispose()`, `disposeAsync()`, `Symbol.dispose`, `Symbol.asyncDispose`.

### Справочник ошибок

Все ошибки наследуются от `DiError`:

| Ошибка | Когда возникает |
|---|---|
| `ProviderNotFoundError` | резолв незарегистрированного токена |
| `CircularDependencyError` | цикл в графе зависимостей |
| `ScopedServiceFromRootError` | scoped-сервис из root или из singleton |
| `ClassDependenciesMismatchError` | у класса больше параметров конструктора, чем известных deps |
| `NamedDependencyNotFoundError` | auto deps не нашли токен по имени типа |
| `AmbiguousNamedDependencyError` | несколько токенов с одинаковым `description` |
| `ServiceValidationError` | проблемы графа, найденные `validateOnBuild` |
| `ScopeDisposedError` | резолв из уже dispose'нутого scope/контейнера |
| `InvalidProviderError` | провайдер без `useClass`/`useFactory`/`useValue` |
| `AsyncResolutionRequiredError` | синхронный `resolve` async-провайдера — используй `resolveAsync` |
| `OptionsValidationError` | невалидные validated options — список всех проблем конфига (см. 6.18) |
| `ModuleEncapsulationError` | зависимость от приватного сервиса чужого модуля (см. 6.19) |

> `ProviderNotFoundError` и `AsyncResolutionRequiredError` включают цепочку резолва:
> `Resolution path: AppService -> UserRepo -> IDb` — сразу видно, кто потянул зависимость.

### Обработка ошибок (рекомендуемый bootstrap)

Контейнер **не пишет в консоль** — все ошибки бросаются как исключения.
Лови их в entrypoint и решай сам, куда выводить:

```ts
import { DiError, createContainer } from "@/core/di";

let container;
try {
  // validateOnBuild соберёт все проблемы графа в один ServiceValidationError
  // на старте — вместо падения на первом resolve посреди работы.
  container = createContainer(AppModule, { validateOnBuild: true });
} catch (error) {
  if (error instanceof DiError) {
    console.error(`[osnova] DI configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
```

Правила:
- `validateOnBuild: true` — всегда включай в entrypoint приложения;
- `error instanceof DiError` отделяет ошибки конфигурации DI от прочих;
- непойманное исключение Bun сам напечатает в stderr и завершит процесс
  с ненулевым кодом (в т.ч. в скомпилированном бинарнике).

---

## 9) FAQ

**Q: Нужно ли писать deps в модуле?**  
A: Нет, для class-регистрации в short API обычно не нужно.

**Q: Когда всё же deps нужны?**  
A: В `singletonFactory(...)` / `useFactory`, а также для конструкторов с примитивными
параметрами (`string`, `number`, ...), которые auto deps подхватить не могут.

**Q: Как получить резолвер внутри фабрики?**  
A: Используй `singletonFactoryWithResolver(...)` или `DI.factoryProviderWithResolver(...)` —
резолвер придёт первым аргументом и будет привязан к правильному scope.

**Q: Как обновлять карту зависимостей?**  
A: `bun run di:generate`; обычно не требуется вручную, т.к. скрипт запускается перед `build/test/start/dev/build:bin`.

**Q: Можно ли несколько реализаций под токеном?**  
A: Да, через повторную регистрацию + `resolveAll`, либо через keyed-регистрации + `resolveKeyed`.

**Q: Как проверить наличие сервиса без исключения?**  
A: `container.has(token)` — проверка регистрации; `container.tryResolve(token)` — вернёт
`undefined` вместо `ProviderNotFoundError` (остальные ошибки пробрасываются).

**Q: Сервису нужна асинхронная инициализация (БД, конфиг)?**  
A: `singletonAsyncFactory(...)` + `await container.resolveAsync(token)` — см. 6.15.

**Q: Как достать сервис вне модуля (в entrypoint, HTTP-обвязке, тесте)?**  
A: Через контейнер в composition root: `container.resolve(...)`, на запрос —
`container.createScope()`, без модулей вообще — `ServiceCollection` напрямую.
Бизнес-код контейнер не трогает — см. 6.20.

**Q: Как спрятать внутренние сервисы модуля от других модулей?**  
A: Добавь модулю `exports: [...]` — наружу будут видны только перечисленные токены.
Нарушения ловятся при `createContainer` как `ModuleEncapsulationError` — см. 6.19.

**Q: Тяжёлая зависимость нужна редко — как не создавать её зря?**  
A: Объяви параметр конструктора как `Lazy<T>` — сервис создастся при первом
обращении к `.value`. Заодно `Lazy<T>` разрывает циклы — см. 6.17.

**Q: Как провалидировать конфиг на старте, а не в рантайме?**  
A: `addValidatedOptions(...)` + `validateOptionsOnStart(container)` (или просто
`Application.start` — он делает это сам) — см. 6.18.

**Q: Конфиг может меняться в рантайме (hot-reload)?**  
A: `addReloadableOptions(...)` + `createReloadableOptionsTokens(...)`: `monitor`
(singleton, `current`/`onChange`/`reload`) и `snapshot` (scoped, стабилен в рамках
запроса) — аналог .NET `IOptionsMonitor`/`IOptionsSnapshot`, см. 6.22.

**Q: Когда использовать `DI.classProvider(...)`?**  
A: Когда нужен ручной контроль провайдера (редкий нестандартный случай). Для обычных кейсов используй short API.

---

## Ссылка на основной документ

[Архитектура модулей](../../../../docs/architecture/MODULE_ARCHITECTURE.md)

Дополнительно: карта структуры папки DI — [`README.md`](./README.md)
