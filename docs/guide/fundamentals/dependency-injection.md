# DI подробно

Глава [Провайдеры и DI](../overview/providers.md) покрывает обычный случай:
класс, время жизни, контракт и реализация. Здесь — всё остальное: значения,
вычисляемые и асинхронные сервисы, несколько реализаций одного контракта,
ленивые зависимости и освобождение ресурсов.

Все примеры проверены на bazis 0.129.0.

## Способы регистрации

В `providers` модуля пишут только эти формы:

| Запись | Что регистрирует |
| --- | --- |
| `scoped(IContract, Implementation)`, `singleton(...)`, `transient(...)` | Реализацию под [контрактом](../overview/providers.md#регистрация-по-контракту) |
| `scoped(Service)`, `singleton(Service)`, `transient(Service)` | Класс — сам себе ключ |
| `singletonValue(TOKEN, value)` | Готовое значение |
| `singletonAsyncFactory(TOKEN, [deps], async factory)` | Результат асинхронной функции; создаётся при запуске |
| `...withEventSubscribers(Class)` | Подписчиков на [события](events.md) |

Зависимости класса codegen берёт из конструктора, поэтому третьего
аргумента со списком зависимостей нет. Всё остальное — список
зависимостей, синхронные фабрики, `DI.*` — codegen отклоняет:

```text
BAZIS_DI_PROVIDER_FORM: src/app/modules/notes/Notes.module.ts:12: providers of NotesModule:
"scoped(NotesService, NotesService, [INotesRepository])" passes a dependency list. Remove it:
codegen reads the constructor. Agreed forms: scoped(IService, Service), singleton(IService, Service),
transient(IService, Service) (or the class alone), singletonValue(TOKEN, value),
singletonAsyncFactory(TOKEN, [deps], async factory) or ...withEventSubscribers(Class).
```

В `controllers`, `background`, `gateways`, `grpcControllers` и `tools`
перечисляют сами классы.

## Значения

Значение регистрируют под токеном. Тип и токен называют одинаково — тогда
codegen внедрит значение по типу параметра:

```ts
import { createToken } from "bazis/core/di";

export type AppName = string;
export const AppName = createToken<AppName>("AppName");
```

```ts
providers: [singletonValue(AppName, "di-lab")],

constructor(private readonly appName: AppName) {}   // "di-lab"
```

Обычный `string` в конструкторе внедрить нельзя: строк в приложении много, и
DI не знает, какая нужна. Нужен именованный тип с токеном, как `AppName`.
Если оставить `string`, codegen остановится и подскажет, как сделать:

```text
BAZIS_DI_DEPENDENCY_UNKNOWN: src/app/modules/Prim.ts:3: constructor parameter 1 "prefix" of "Greeter"
has type "string", which cannot be injected: DI resolves dependencies by class, contract or token,
and a plain type does not say which value to inject. Declare a token with the same name as a type
alias (export type Prefix = string; export const Prefix = createToken<Prefix>("Prefix")), register
a value with singletonValue(Prefix, "…") and type the parameter with it: prefix: Prefix.
```

## Вычисляемый сервис — класс

Когда объект надо собрать из других — клиент внешнего API, обёртка над
чужой библиотекой, — это класс с конструктором под своим контрактом:

```ts
export abstract class HttpClient {
  abstract get(path: string): string;
}

export class ApiClient extends HttpClient {
  constructor(private readonly appName: AppName) {
    super();
  }

  get(path: string) {
    return `${this.appName} GET https://api.example.com${path}`;
  }
}
```

```ts
providers: [singletonValue(AppName, "di-lab"), singleton(HttpClient, ApiClient)],
```

Зависимости видны в конструкторе и проверяются codegen до запуска — как у
любого сервиса.

## Несколько реализаций одного контракта

Один контракт можно зарегистрировать несколько раз:

```ts
providers: [
  singleton(IPlugin, PluginA),
  singleton(IPlugin, PluginB),
],
```

- Параметр конструктора `plugin: IPlugin` получит **последнюю** регистрацию —
  `PluginB`. Так модуль может подменить реализацию, объявленную раньше.
- Все реализации сразу отдаёт `resolveAll`:

```ts
import { ServiceProvider } from "bazis/core/di";

export class Plugins {
  constructor(private readonly services: ServiceProvider) {}

  names() {
    return this.services.resolveAll(IPlugin).map((plugin) => plugin.name);   // ["a", "b"]
  }
}
```

## Конкретная реализация из нескольких

Если потребителю нужна конкретная реализация, дайте ей свой контракт:

```ts
export abstract class ISmsSender extends ISender {}
export abstract class IEmailSender extends ISender {}

providers: [
  singleton(ISmsSender, SmsSender),
  singleton(IEmailSender, EmailSender),
],
```

```ts
export class Notifier {
  constructor(private readonly sms: ISmsSender, private readonly email: IEmailSender) {}
}
```

Тип параметра сам говорит, что внедрить, и codegen справляется без
подсказок.

## Ленивые зависимости

`Lazy<T>` откладывает создание сервиса до первого обращения:

```ts
import type { Lazy } from "bazis/core/di";

export class ReportController {
  constructor(private readonly heavy: Lazy<HeavyService>) {}

  @Get("fast") fast() { return { ok: true }; }                 // HeavyService не создаётся
  @Get("slow") slow() { return this.heavy.value.run(); }       // создаётся здесь
}
```

| Свойство | Что даёт |
| --- | --- |
| `value` | Сам сервис; при первом обращении он создаётся и запоминается |
| `isCreated` | Создан ли уже сервис |

Это полезно для дорогих сервисов, которые нужны не каждому запросу.
Регистрировать `HeavyService` нужно как обычно; codegen сам распознаёт
`Lazy<...>` в конструкторе.

## Необязательные зависимости

Параметр конструктора со знаком `?` или значением по умолчанию —
необязательная зависимость:

```ts
import { ICache } from "bazis/core/cache";

export class Reporter {
  constructor(
    private readonly clock: Clock = new FixedClock(),
    private readonly cache?: ICache,
  ) {}
}
```

| Параметр | Сервис зарегистрирован | Не зарегистрирован |
| --- | --- | --- |
| `cache?: ICache` | Внедряется | `undefined` |
| `clock: Clock = new FixedClock()` | Внедряется зарегистрированный | Значение по умолчанию |
| `options: Options = {}` — тип, не известный DI | Не внедряется | Значение по умолчанию |

Так сервис работает и с модулем кэша, и без него.

> [!NOTE]
> Необязательные зависимости — с версии 0.98.10. Раньше `cache?: ICache`
> не давал приложению запуститься с ошибкой `requires at least 1
> constructor deps … run bazis codegen`.

## Освобождение ресурсов

Если у сервиса есть метод `dispose()`, `[Symbol.dispose]()` или
`[Symbol.asyncDispose]()`, контейнер вызывает его сам:

| Время жизни | Когда освобождается |
| --- | --- |
| `scoped` | В конце запроса — после того, как ответ отправлен |
| `singleton` | При остановке приложения |
| `transient` | Вместе с областью, в которой создан |

```ts
export class Pool {
  async [Symbol.asyncDispose]() {
    await this.connections.close();
  }
}
```

Контейнер освобождает только то, что создал сам:

| Регистрация | Освобождается контейнером |
| --- | --- |
| Класс, асинхронная фабрика | Да |
| `singletonValue(TOKEN, value)` | Нет — значение создано снаружи |

## Контейнер вручную

В конструкторе можно попросить сам контейнер — `ServiceProvider`, — а в
middleware и проверках доступа он доступен как `ctx.services`:

| Метод | Что делает |
| --- | --- |
| `resolve(Token)` | Сервис; нет регистрации — ошибка |
| `tryResolve(Token)` | Сервис или `undefined` |
| `has(Token)` | Есть ли регистрация |
| `resolveAll(Token)` | Все реализации |

Что именно получит конструктор, зависит от того, где живёт сервис:

| Сервис | `ServiceProvider` в конструкторе |
| --- | --- |
| `scoped` (и `transient`, созданный для него) | Область этого запроса: `resolve` отдаёт те же экземпляры, что получил контроллер |
| `singleton`, фоновая служба, хук | Корневой контейнер |

У области запроса `createScope()` открывает новую, независимую область, а
`dispose()` отказывает — область закрывает тот, кто её создал:

```text
DiError: This ServiceProvider is the scope that resolved the service; whoever created the scope disposes it.
To own a scope, call createScope() and dispose that one.
```

> [!NOTE]
> С версии 0.106.0, как `IServiceProvider` в ASP.NET Core. Раньше
> scoped-сервис тоже получал корневой контейнер, и scoped-сервис через
> него не находился: `ScopedServiceFromRootError`.

Пользуйтесь этим, когда набор зависимостей заранее неизвестен — плагины,
выбор реализации по данным запроса. В остальных случаях лучше обычный
параметр конструктора: зависимость видна в сигнатуре и проверяется до
запуска.

## Асинхронные фабрики

Когда объект нельзя получить без `await` — подключение к базе, загрузка
ключей, запрос к сервису настроек, — используйте асинхронную фабрику:

```ts
export interface Db { readonly connectedAt: string }
export const Db = createToken<Db>("Db");

providers: [
  singletonAsyncFactory(Db, [], async () => {
    const connection = await connect(process.env.DATABASE_URL);
    return connection;
  }),
],
```

Такой singleton создаётся **при запуске приложения** — до фоновых служб и
HTTP-сервера. После этого его можно внедрять через конструктор, как любой
другой сервис:

```ts
export class DbController {
  constructor(private readonly db: Db) {}
}
```

Если фабрика упала — база недоступна, ключ не найден, — приложение не
запустится и завершится с кодом 1:

```text
[bazis] application failed: Error: database is unreachable
    at <anonymous> (src/app/infra/Db.ts:12:11)
    ...
```

Ошибка запуска печатается как `Имя [код]: сообщение` со стеком и причиной
(`Caused by:`) — с версии 0.98.20. Раньше выводился весь объект ошибки.

Это лучше, чем сервер, который стартовал и отвечает `500` на каждый запрос.

Асинхронные фабрики могут зависеть друг от друга: bazis создаст их в нужном
порядке.

> [!NOTE]
> Создание асинхронных singleton при запуске и ошибка codegen для
> примитивных параметров — с версии 0.97.4. Раньше сервис из асинхронной
> фабрики нельзя было внедрить через конструктор: каждый запрос падал с
> `AsyncResolutionRequiredError`.

## Дальше

- [Провайдеры и DI](../overview/providers.md)
- [Кодогенерация](codegen.md)
- [Инкапсуляция модулей](encapsulation.md)
