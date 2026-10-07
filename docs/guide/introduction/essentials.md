# Основные понятия

Пять понятий, на которых держится любое приложение на bazis. Здесь — коротко
и с примерами. Подробности — в разделах «Обзор» и «Основы».

## Модуль

Модуль — единица приложения: он объединяет сервисы, контроллеры и настройки
одной функции и решает, что из этого видно снаружи.

```ts
@Module({
  imports: [AuthModule],              // модули, от которых зависим
  config: greetingConfig,             // объявления настроек модуля
  providers: [scoped(GreetingService)],
  controllers: [GreetingController],
  exports: [GreetingService],         // что доступно модулям, импортирующим этот
})
export class GreetingModule {}
```

Приложение — дерево модулей с корнем `AppModule`. Новые модули создаются
командой `bunx bazis g module <Имя>`: она же подключает модуль к корню.

Если модуль объявил `exports`, остальные его сервисы чужим модулям
недоступны. Попытка их внедрить остановит запуск:

```text
Module "OtherModule": "OtherController" depends on "Counter", which module
"LabModule" provides but does not export. Add it to the exports of "LabModule".
```

## Провайдеры и внедрение зависимостей

Провайдер говорит контейнеру, как создать сервис и сколько он живёт.
Зависимости сервис объявляет в конструкторе — без декораторов:

```ts
export class GreetingService {
  constructor(private readonly repository: GreetingRepository) {}
}
```

Время жизни задаётся функцией в `providers`:

| Функция | Сколько живёт объект | Когда выбирать |
| --- | --- | --- |
| `scoped(Service)` | Один на HTTP-запрос: все, кто внедряет его в рамках запроса, получают один объект | По умолчанию для сервисов, особенно работающих с базой |
| `singleton(Service)` | Один на всё приложение | Кэши, клиенты, состояние, которое должно жить между запросами |
| `transient(Service)` | Новый при каждом внедрении | Лёгкие объекты без общего состояния |

Контейнер проверяет граф зависимостей при старте. Ошибки вроде забытого
провайдера или `singleton`, зависящего от `scoped`-сервиса, не доживают до
первого запроса:

```text
Missing dependency "RequestState" for "Reader"
Singleton "Reader" depends on scoped "RequestState"
```

**Зависимость от контракта.** Контракт сервиса описывают абстрактным
классом без кода — он работает как интерфейс, но существует во время
выполнения и поэтому сам служит ключом в DI:

```ts
export abstract class IClock { abstract now(): Date; }
export class SystemClock implements IClock { now() { return new Date(); } }

// в модуле:            scoped(IClock, SystemClock)
// в конструкторе:      constructor(private readonly clock: IClock) {}
```

Можно и чистый `interface`, но тогда рядом нужен токен с тем же именем —
`export const IClock = createToken<IClock>("IClock")`. Подробнее — в главе
[Провайдеры и DI](../overview/providers.md#регистрация-по-контракту).

Токены `createToken` нужны и для значений:
`singletonValue(APP_NAME, "my-app")`, `singletonFactory(TOKEN, [deps], factory)`.

## Контроллер

Контроллер принимает HTTP-запросы и вызывает сервисы:

```ts
@Controller("greetings")
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get(":name")
  getByName(name: string) {
    return { message: `Hello, ${name}!` };
  }
}
```

Откуда брать аргументы метода, bazis понимает по их именам и типам:

| Параметр | Откуда значение |
| --- | --- |
| Имя совпадает с параметром маршрута (`:name`, `*path`)¹ | Из пути |
| Класс модели запроса | Из JSON-тела, с проверкой |
| `HttpContext` | Контекст запроса |
| Простой тип, которого нет в маршруте | Из строки запроса: `?limit=10` |

¹ Параметры из префикса `@Controller("orgs/:org/...")` и wildcard `*path`
привязываются с версии 0.96.4; в более ранних они ошибочно искались в строке
запроса.

Что вернул метод, то и уходит клиенту: объект — JSON с кодом 200, строка —
текст, `undefined` — 204. Для других кодов есть помощники `Created`,
`NotFound`, `BadRequest` и другие.

## Модель запроса

Тело запроса описывается классом с правилами проверки:

```ts
@RequestModel()
export class CreateGreetingRequest {
  @Validator({ required: true, minLength: 1, maxLength: 50 })
  name!: string;
}
```

Неверные данные отклоняются с кодом 400 ещё до вызова контроллера, а ответ
перечисляет все нарушения по полям.

## Кодогенерация

Чтобы обходиться без декораторов на параметрах и без `reflect-metadata`,
bazis перед запуском читает исходники и записывает в `src/generated/bazis`:

- какие зависимости нужны каждому сервису и контроллеру;
- откуда брать каждый аргумент методов контроллеров;
- описания моделей запросов для проверки и OpenAPI.

`bazis dev`, `bazis test` и `bazis build` запускают её сами; вручную —
`bunx bazis codegen`. Папку `src/generated` не правят руками и не хранят в
Git. Если кодогенерация не может что-то понять, она останавливается и
говорит, что именно. Например, `IMailer` — интерфейс, а токен для него забыли:

```text
BAZIS_DI_DEPENDENCY_UNKNOWN: src/app/modules/mail/Mail.service.ts:4:
constructor parameter 1 of "MailService" has type "IMailer", which is
neither a DI token (createToken) nor a class known to codegen.
```

## Конфигурация и окружения

Настройки объявляются с типами и значениями по умолчанию:

```ts
import { defineConfig } from "bazis/core/kernel";

export interface GreetingConfig { prefix: string; times: number; }

export const greetingConfig = defineConfig<GreetingConfig>("greeting", {
  default: { prefix: "Hello", times: 1 },
  production: { prefix: "Hi" },        // поверх default в окружении production
});
```

Модуль подключает объявление через `config: greetingConfig`, а сервис просит
настройки в конструкторе по типу:

```ts
// в модуле
@Module({ config: greetingConfig, providers: [scoped(GreetingService)], ... })

// в сервисе
constructor(private readonly config: ConfigView<GreetingConfig>) {}
greet(name: string) { return `${this.config.get("prefix")}, ${name}!`; }
```

Кодогенерация находит объявление `defineConfig<GreetingConfig>(...)` по типу,
поэтому тип в угловых скобках у `defineConfig` обязателен. Это работает с
версии 0.96.5; в более ранних токен указывали вручную:
`scoped(GreetingService, GreetingService, [greetingConfig.token] as const)`.

Любое значение переопределяется переменной окружения вида
`BAZIS_<ИМЯ>__<КЛЮЧ>`: `BAZIS_GREETING__PREFIX=Hey`. Значение неверного типа
останавливает запуск:

```text
Invalid configuration (environment "development"): greeting.times — expected a finite number.
```

Окружение выбирает переменная `BAZIS_ENV` (если её нет — `NODE_ENV`):

| Окружение | Когда | Особенности |
| --- | --- | --- |
| `development` | `bazis dev` выбирает его сам | Подробности ошибок в ответах, страница OpenAPI `/docs`, подробные логи |
| `test` | Тесты | Как `development`, но со своей секцией настроек |
| `production` | По умолчанию, если окружение не задано | Без подробностей ошибок и `/docs`; секреты без значения останавливают запуск |

## Как проходит запрос

```text
HTTP-запрос
  → глобальные middleware (CORS, журнал, ограничение частоты)
  → проверка доступа @Authorize
  → middleware контроллера и метода
  → привязка аргументов и проверка модели запроса
  → кэш ответа (если включён)
  → метод контроллера → сервисы (scoped — свои на этот запрос)
  → ответ
```

## Дальше

- [Первые шаги](first-steps.md) — всё это на работающем примере
- Раздел «Обзор» — каждое понятие подробно *(в работе)*
