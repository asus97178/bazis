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

## Регистрация по интерфейсу

Чтобы зависеть от абстракции, а не от класса, объявите интерфейс и токен с
тем же именем:

```ts
import { createToken } from "bazis/core/di";

export interface IClock {
  now(): Date;
}
export const IClock = createToken<IClock>("IClock");

export class SystemClock implements IClock {
  now() { return new Date(); }
}
```

```ts
// модуль: токен → реализация
providers: [scoped(IClock, SystemClock)]

// потребитель: тип параметра — интерфейс
constructor(private readonly clock: IClock) {}
```

Токен нужен потому, что интерфейсов в работающем JavaScript нет. Одинаковое
имя у интерфейса и токена — это не ошибка, а приём: по имени типа
кодогенерация находит токен. В тестах вместо `SystemClock` можно
зарегистрировать `FixedClock` — потребители этого не заметят.

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
| `"Y" depends on "X", which is provided by another module but not exported` | `X` из другого модуля не экспортирован или этот модуль не импортирован | Добавить `X` в `exports` и модуль в `imports` |
| `BAZIS_DI_DEPENDENCY_UNKNOWN` (при кодогенерации) | Тип параметра конструктора — не класс и не токен | Создать токен `createToken` с тем же именем |

## Дальше

- [Модули](modules.md)
- Контроллеры *(в работе)*
