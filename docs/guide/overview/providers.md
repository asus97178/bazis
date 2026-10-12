# Провайдеры и внедрение зависимостей

Провайдер объясняет контейнеру, **что** создавать и **сколько это живёт**.
Сервис просит зависимости в конструкторе, а контейнер их подставляет.

```ts
// сервис
export class TaskService {
  constructor(private readonly repository: TaskRepository) {}
}

// модуль
@Module({ providers: [scoped(TaskService), scoped(TaskRepository)], ... })
export class TaskModule {}
```

Никаких `@Injectable` и `@Inject`: перед запуском кодогенерация читает типы
параметров конструктора и записывает связи в `src/generated/bazis`.

## Время жизни

| Функция | Сколько живёт объект |
| --- | --- |
| `scoped(Service)` | Один на HTTP-запрос. Все, кто внедряет его в рамках запроса, получают один и тот же объект; следующий запрос получает новый |
| `singleton(Service)` | Один на всё приложение |
| `transient(Service)` | Новый при каждом внедрении |

Как выбрать:

- **`scoped`** — по умолчанию для сервисов с бизнес-логикой и всего, что
  работает с базой данных: в рамках запроса у них общий контекст БД.
- **`singleton`** — когда состояние должно жить между запросами (кэш,
  счётчики) или объект дорого создавать (клиенты внешних систем).
- **`transient`** — для лёгких объектов без общего состояния.

Пример: контроллер внедряет все три вида, а ещё один `scoped`-сервис внутри
запроса внедряет `RequestState` и `Stamp` повторно. Идентификаторы созданных
объектов в двух запросах подряд:

```text
запрос 1: singleton=1  scoped=[2, 2]  transient=[3, 4]
запрос 2: singleton=1  scoped=[5, 5]  transient=[6, 7]
```

### Правило: долгоживущий не зависит от короткоживущего

`singleton` не может зависеть от `scoped`: он пережил бы запрос и держал бы
его объект вечно. Контейнер проверяет это при старте:

```text
Service graph validation failed:
Singleton "Reader" depends on scoped "RequestState"
```

## Регистрация по контракту

Чтобы зависеть от абстракции, а не от конкретного класса, опишите контракт
абстрактным классом без кода:

```ts
export abstract class IClock {
  abstract now(): Date;
}

export class SystemClock implements IClock {
  now() { return new Date(); }
}
```

```ts
// модуль: контракт → реализация
providers: [scoped(IClock, SystemClock)],
exports: [IClock],

// потребитель: тип параметра — контракт
constructor(private readonly clock: IClock) {}
```

Абстрактный класс работает как интерфейс: кода в нём нет, реализация
подключает его через `implements`. Но в отличие от интерфейса он существует во
время выполнения, поэтому сам служит ключом в DI. Отдельный токен не нужен, а
сервис можно достать и там, где нет конструктора:
`ctx.services.resolve(IClock)` в middleware или проверке доступа. В тестах
вместо `SystemClock` регистрируют `FixedClock` — потребители этого не
заметят. Так создаёт контракты и `bazis g module`.

> [!NOTE]
> Контракты-абстрактные классы работают с версии 0.97.0.

### Интерфейс и токен

Если контракт должен остаться чистым `interface`, рядом объявляют токен с тем
же именем:

```ts
import { createToken } from "bazis/core/di";

export interface IClock {
  now(): Date;
}
export const IClock = createToken<IClock>("IClock");
```

Регистрация и конструктор пишутся так же: `scoped(IClock, SystemClock)`,
`clock: IClock`. Здесь `IClock` в `scoped(...)` — константа-токен, а в
конструкторе — интерфейс: TypeScript разрешает типу и значению носить одно
имя. Без константы не обойтись: `interface` исчезает при компиляции, и
`scoped(IClock, ...)` с одним только интерфейсом не скомпилируется.

Оба способа можно смешивать даже в одном модуле. Мы рекомендуем абстрактный
класс: одна сущность вместо двух.

## Значения и фабрики

Готовое значение или результат функции регистрируют под токеном. Тип и токен
снова называют одинаково — так значение можно внедрить через конструктор:

```ts
export type AppName = string;
export const AppName = createToken<AppName>("AppName");

export type GreetingText = string;
export const GreetingText = createToken<GreetingText>("GreetingText");
```

```ts
providers: [
  singletonValue(AppName, "my-app"),
  singletonFactory(GreetingText, [AppName] as const, (name) => `hello from ${name}`),
]

// потребитель
constructor(private readonly greeting: GreetingText) {}   // "hello from my-app"
```

| Функция | Что делает |
| --- | --- |
| `singletonValue(token, value)` | Регистрирует готовое значение |
| `singletonFactory(token, [deps], factory)` | Вызывает `factory` один раз с разрешёнными зависимостями |

Асинхронные фабрики (`singletonAsyncFactory`) тоже есть, но работают по
своим правилам — они разобраны в разделе «DI подробно».

## Настройки

Настройки из `defineConfig` внедряются по типу `ConfigView<T>` (с версии
0.96.5):

```ts
constructor(private readonly config: ConfigView<GreetingConfig>) {}
```

Подробнее — в [«Основных понятиях»](../introduction/essentials.md#конфигурация-и-окружения).

## Освобождение ресурсов

Если сервису нужно что-то закрыть — соединение, файл, таймер, — добавьте
метод `dispose()` (или `[Symbol.asyncDispose]()` для асинхронной очистки).
Контейнер вызовет его сам:

| Время жизни | Когда вызывается очистка |
| --- | --- |
| `scoped` | Когда запрос завершён |
| `singleton` | При остановке приложения (`Ctrl+C`, `SIGTERM`) |

```ts
export class ReportWriter {
  private readonly file = Bun.file("report.log").writer();

  async [Symbol.asyncDispose]() {
    await this.file.end();
  }
}
```

## Ошибки, которые ловятся при старте

Контейнер проверяет весь граф до первого запроса. Типичные сообщения:

| Сообщение | Причина | Что сделать |
| --- | --- | --- |
| `Missing dependency "X" for "Y"` | `X` не зарегистрирован ни в одном доступном модуле | Добавить `X` в `providers` или импортировать модуль, который его экспортирует |
| `Singleton "Y" depends on scoped "X"` | Долгоживущий сервис зависит от короткоживущего | Сделать `Y` `scoped` или `X` `singleton` |
| `"Y" depends on "X", which module "A" provides but does not export` | `X` из модуля `A` не экспортирован | Добавить `X` в `exports` модуля `A` |
| `"Y" depends on "X", which module "A" exports, but "B" does not list "A" in its imports` | Модуль `A` не импортирован | Добавить `A` в `imports` модуля `B` |
| `BAZIS_DI_DEPENDENCY_UNKNOWN` (при кодогенерации) | Тип параметра конструктора — интерфейс без токена или неизвестный тип | Сделать контракт абстрактным классом или объявить токен `createToken` с тем же именем |

## Дальше

- [Модули](modules.md)
- [Контроллеры](controllers.md)
