# DI подробно

Глава [Провайдеры и DI](../overview/providers.md) покрывает обычный случай:
класс, время жизни, контракт и реализация. Здесь — всё остальное: значения
и фабрики, несколько реализаций одного контракта, ключи, ленивые
зависимости и освобождение ресурсов.

Все примеры проверены на одном модуле с bazis 0.97.3.

## Способы регистрации

| Запись | Что регистрирует |
| --- | --- |
| `scoped(Service)`, `singleton(...)`, `transient(...)` | Класс — сам себе ключ |
| `scoped(IContract, Implementation)` | Реализацию под [контрактом](../overview/providers.md#регистрация-по-контракту) |
| `singletonValue(TOKEN, value)` | Готовое значение |
| `singletonFactory(TOKEN, [deps], factory)` | Результат функции |
| `singletonFactoryWithResolver(TOKEN, [deps], factory)` | То же, функция получает ещё и контейнер |
| `DI.keyedSingleton(key, provider)` и др. | Реализацию под ключом |

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

## Фабрики

Когда объект надо собрать функцией — клиент внешнего API, обёртка над
чужой библиотекой, — используйте фабрику:

```ts
export interface HttpClient { get(path: string): string }
export const HttpClient = createToken<HttpClient>("HttpClient");
```

```ts
singletonFactory(HttpClient, [AppName] as const, (name) => ({
  get: (path) => `${name} GET https://api.example.com${path}`,
})),
```

Зависимости фабрики перечисляются явно, вторым аргументом, — codegen не
заглядывает внутрь функций. `as const` нужен, чтобы TypeScript вывел типы
аргументов фабрики: здесь `name` получает тип `AppName`.

## Явный список зависимостей класса

Обычно зависимости класса codegen берёт из конструктора. Список можно
задать вручную третьим аргументом — это нужно, когда тип параметра не
говорит, что именно внедрить, например при [ключах](#ключи):

```ts
scoped(Notifier, Notifier, [keyedDependency(ISender, "sms"), keyedDependency(ISender, "email")] as const),
```

Явный список полностью заменяет то, что вывел бы codegen.

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

## Ключи

Если реализаций несколько и потребителю нужна конкретная, регистрируйте их
под ключами:

```ts
import { DI, keyedDependency, scoped } from "bazis/core/di";

providers: [
  DI.keyedSingleton("sms", DI.classProvider(ISender, SmsSender)),
  DI.keyedSingleton("email", DI.classProvider(ISender, EmailSender)),
  scoped(Notifier, Notifier, [keyedDependency(ISender, "sms"), keyedDependency(ISender, "email")] as const),
],
```

```ts
export class Notifier {
  constructor(private readonly sms: ISender, private readonly email: ISender) {}
}
// notifier.both("hi") → ["sms: hi", "email: hi"]
```

По одному типу `ISender` codegen не поймёт, какой ключ нужен, поэтому у
потребителя ключи указываются в [явном списке
зависимостей](#явный-список-зависимостей-класса). Вне конструктора —
`services.resolveKeyed(ISender, "sms")`.

Есть также `DI.keyedScoped` и `DI.keyedTransient`.

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
| Класс, фабрика | Да |
| `singletonValue(TOKEN, value)` | Нет — значение создано снаружи |
| `DI.singleton(DI.externallyOwned(provider))` | Нет — владелец объекта кто-то другой |

## Контейнер вручную

В конструкторе можно попросить сам контейнер — `ServiceProvider`, — а в
middleware и проверках доступа он доступен как `ctx.services`:

| Метод | Что делает |
| --- | --- |
| `resolve(Token)` | Сервис; нет регистрации — ошибка |
| `tryResolve(Token)` | Сервис или `undefined` |
| `has(Token)` | Есть ли регистрация |
| `resolveAll(Token)` | Все реализации |
| `resolveKeyed(Token, key)` | Реализация под ключом |

Пользуйтесь этим, когда набор зависимостей заранее неизвестен — плагины,
выбор реализации по данным запроса. В остальных случаях лучше обычный
параметр конструктора: зависимость видна в сигнатуре и проверяется до
запуска.

## Асинхронные фабрики *(в работе)*

## Дальше

- [Провайдеры и DI](../overview/providers.md)
- [Кодогенерация](codegen.md)
- Инкапсуляция модулей *(в работе)*
