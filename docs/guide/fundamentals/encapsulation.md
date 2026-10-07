# Инкапсуляция модулей

Основы описаны в главе [Модули](../overview/modules.md#что-видно-другим-модулям-exports):
модуль `B` может внедрить сервис модуля `A`, только если `B` импортирует `A`,
а `A` отдаёт этот сервис в `exports`. Здесь — правила подробнее и случаи,
на которых обычно спотыкаются.

Все примеры проверены на bazis 0.97.7.

## Видимость не передаётся по цепочке

```ts
@Module({ providers: [scoped(IClock, SystemClock)], exports: [IClock] })
export class ClockModule {}

@Module({ imports: [ClockModule], providers: [scoped(ReportService)], exports: [ReportService] })
export class ReportModule {}

@Module({ imports: [ReportModule], providers: [scoped(PageService)], exports: [] })
export class AppModule {}
```

`ReportService` может зависеть от `IClock`. А `PageService` из `AppModule` —
нет, хотя `AppModule` импортирует `ReportModule`, а тот — `ClockModule`:

```text
Module "AppModule": "PageService" depends on "IClock", which module "ClockModule" exports,
but "AppModule" does not list "ClockModule" in its imports. Add "ClockModule" to the imports of "AppModule".
```

Каждый модуль перечисляет в `imports` всё, чем пользуется сам. Так по
объявлению модуля видно, от чего он зависит на самом деле.

## Реэкспорт

Модуль может отдать дальше токен, который сам импортировал:

```ts
@Module({ imports: [ClockModule], providers: [scoped(ReportService)], exports: [ReportService, IClock] })
export class ReportModule {}
```

Теперь `IClock` видят все, кто импортирует `ReportModule`. Реэкспортировать
модуль целиком нельзя: в `exports` перечисляются только токены и классы.

Отдать то, чего у модуля нет, тоже нельзя:

```text
Module "Empty" exports "IClock" which it neither provides nor imports.
```

## Общий модуль у нескольких

Если `ClockModule` импортируют два модуля, сервис создаётся один раз: оба
получают один и тот же экземпляр singleton. Повторные импорты и «ромбы» в
графе модулей — обычное дело.

## Одна реализация на токен

В приложении один реестр сервисов. Если один и тот же токен
зарегистрирован в нескольких модулях, всё приложение получает **последнюю**
регистрацию.

Так можно подменить реализацию из чужого модуля:

```ts
@Module({ providers: [scoped(IClock, SystemClock)], exports: [IClock] })
export class ClockModule {}

@Module({ imports: [ClockModule], providers: [scoped(IClock, FixedClock), scoped(PageService)], exports: [] })
export class AppModule {}
// PageService получает FixedClock
```

Но если исходный модуль сам пользуется этим токеном, подмена ломает его:
сервисы `ClockModule` получили бы реализацию из `AppModule`, которую
`ClockModule` не видит. Запуск останавливается:

```text
Module "ClockModule": "ReportService" depends on "IClock", but "IClock" is registered in "ClockModule"
and "AppModule", and the application uses one implementation per token, the last registered one, from
"AppModule", which "ClockModule" cannot see. Register "IClock" in one module, or give the
implementations different keys (DI.keyedSingleton).
```

Если разным частям приложения действительно нужны разные реализации,
зарегистрируйте их под [ключами](dependency-injection.md#ключи).

> [!NOTE]
> Сообщение в таком виде — с версии 0.97.7.

## Модуль без `exports`

Если поле `exports` не указано, модуль открыт целиком: импортирующим видны
все его сервисы. `exports: []` — наоборот, всё приватно. Указывайте
`exports` всегда; CLI так и создаёт модули.

## Глобальные модули

`@Global()` делает `exports` модуля видимыми всем без `imports`. Но сам
модуль должен попасть в приложение — быть импортированным хотя бы раз,
обычно в корневом модуле или через `infra`. Иначе его сервисов в
приложении просто нет:

```text
Service graph validation failed:
Missing dependency "IClock" for "PageService"
```

## Модули с параметрами

Модуль не обязан быть классом: подходит и обычный объект с теми же полями.
Это удобно, когда модулю нужны настройки:

```ts
export function clockModule(options: { fixed: boolean }) {
  return {
    providers: [singleton(IClock, options.fixed ? FixedClock : SystemClock)],
    exports: [IClock],
  };
}

@Module({ imports: [clockModule({ fixed: true })], providers: [scoped(PageService)], exports: [] })
export class AppModule {}
```

Так устроены `memory()` для кэша и `httpModule(...)` внутри `runApp`.

## Чего `exports` не ограничивает

- **Ручное получение сервиса.** `ctx.services.resolve(PrivateService)` в
  middleware, проверке доступа или через `ServiceProvider` вернёт сервис из
  любого модуля: границы проверяются для конструкторов и при сборке
  приложения, а ручной `resolve` — точка сборки, ей видно всё. Не
  обходите так `exports` в коде функций.
- **HTTP, фоновые службы, AI-инструменты.** Контроллеры работают при любых
  `exports` — доступ к ним настраивается через
  [`@Authorize`](../overview/authorization.md).
- **Импорты TypeScript.** `exports` в `@Module` — граница для DI, а не для
  `import` в коде. Что модуль отдаёт как TypeScript-API, решает его
  `index.ts`.

## Дальше

- [Модули](../overview/modules.md)
- [DI подробно](dependency-injection.md)
- Архитектура модулей *(в работе)*
