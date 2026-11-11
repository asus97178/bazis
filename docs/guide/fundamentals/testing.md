# Тестирование

Тесты в bazis — обычные тесты `bun:test`. Фреймворк добавляет к ним две
вещи: подмену зависимостей и запуск приложения прямо в процессе теста.

Все примеры проверены на bazis 0.108.0.

## Запуск

```sh
bunx bazis test                 # codegen, затем bun test
bunx bazis test src/app/modules/task   # только тесты из папки
```

`bazis test` сначала обновляет сгенерированный код — тесты всегда видят
актуальные зависимости и маршруты. Аргументы после `test` передаются
`bun test` как есть. Окружение — `test`.

Тесты обычно лежат рядом с модулем: `src/app/modules/task/test/`.

## Пример

Модуль задач: контракт хранилища, его реализация на базе данных, сервис и
контроллер.

```ts
export abstract class ITaskStore {
  abstract find(id: string): Promise<{ id: string; title: string } | undefined>;
}

export class TaskService {
  constructor(private readonly store: ITaskStore) {}

  async title(id: string) {
    const task = await this.store.find(id);
    if (!task) throw new NotFoundError(`task ${id} not found`);
    return task.title.toUpperCase();
  }
}

@Module({
  providers: [scoped(ITaskStore, PgTaskStore), scoped(TaskService)],
  controllers: [TaskController],
  exports: [TaskService],
})
export class TaskModule {}
```

В тестах вместо базы данных — подделка:

```ts
class FakeStore implements ITaskStore {
  async find(id: string) {
    return id === "1" ? { id, title: "write docs" } : undefined;
  }
}
```

Дальше — три уровня тестов, от быстрых к полным.

## Сервис без DI

Сервис — обычный класс, его можно создать вручную:

```ts
test("title of a task", async () => {
  const service = new TaskService(new FakeStore());
  expect(await service.title("1")).toBe("WRITE DOCS");
  await expect(service.title("2")).rejects.toThrow("task 2 not found");
});
```

Самый быстрый и простой вариант: никакого контейнера, только логика.

## Модуль: `createTestContainer`

Когда нужно проверить модуль целиком — регистрации, зависимости, `exports`, —
соберите контейнер и подмените то, что не должно работать по-настоящему:

```ts
import { singleton } from "bazis/core/di";
import { createTestContainer } from "bazis/core/testing";

test("TaskService with a fake store", async () => {
  const container = await createTestContainer(TaskModule, {
    overrides: [singleton(ITaskStore, FakeStore)],
  });
  const tasks = container.createScope().resolve(TaskService);
  expect(await tasks.title("1")).toBe("WRITE DOCS");
});
```

В контейнере есть службы ядра, как в запущенном приложении: `Logger`,
`EventBus`, `ConfigView` объявленных настроек (секция `test`) и
`Environment` (`test`). Ничего не запускается: ни фоновые службы, ни
HTTP-сервер, ни подключения `infra`. Если передать класс с `@App`, в графе
будут и его `infra`, `cache`, `config` — но по-прежнему ничего не запущено.

> [!NOTE]
> Службы ядра в `createTestContainer` — с версии 0.109.0. Раньше модуль,
> которому нужен `Logger`, `EventBus` или `ConfigView`, в таком тесте не
> собирался: `Missing dependency "Logger" for "PaymentService"`.

`overrides` заменяет регистрацию токена во всём приложении, даже если
модуль-владелец сам им пользуется, и не зависит от порядка `imports`. Если
подменять нечего — опечатка в токене, — тест упадёт сразу:

```text
Override of "ITaskStore" replaces nothing: no module registers it. Check the token, or register it in a module first.
```

> [!WARNING]
> Собирайте контейнер в тестах через `createTestContainer`, а не через
> `createContainer`. Помощник сначала подключает сгенерированный код; без
> него у классов нет зависимостей, и тест может пройти по ошибке — граф
> «проверять» нечего.

Обычная регистрация того же токена в тестовом модуле вместо `overrides` не
сработает: в приложении одна реализация на токен, и
[проверка инкапсуляции](encapsulation.md#одна-реализация-на-токен)
остановит сборку.

## Приложение целиком: `startTestApp`

`startTestApp` запускает в процессе теста то приложение, которое объявлено
в `src/app/App.ts`, — на свободном порту:

```ts
import { singleton } from "bazis/core/di";
import { startTestApp } from "bazis/core/testing";
import { Application } from "../App";

test("GET /tasks/:id", async () => {
  const app = await startTestApp(Application, { overrides: [singleton(ITaskStore, FakeStore)] });
  try {
    const response = await app.fetch("/tasks/1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "WRITE DOCS" });
    expect((await app.fetch("/tasks/2")).status).toBe(404);
  } finally {
    await app.stop();
  }
});
```

Модули, инфраструктура, кэш и настройки HTTP берутся из `@App`: тест не
повторяет их и не расходится с production. Проверяется всё, что видит
клиент: маршруты, привязка аргументов, валидация, авторизация, коды ответов
и обработка ошибок.

| У `app` есть | Что это |
| --- | --- |
| `fetch(path, init?)` | `fetch` относительно адреса приложения |
| `url` | `http://127.0.0.1:<порт>`; пусто, если сервера нет |
| `use(Service, work)` | Вызывает сервис в своей области, как запрос, и закрывает её: `await app.use(ITaskService, (tasks) => tasks.create("Отчёт"))`. С версии 0.138.0 |
| `container` | Контейнер приложения — когда `use` мало: singleton, несколько сервисов одной области |
| `stop()` | Плавная остановка, как по `SIGTERM` |

Второй аргумент говорит только о том, чем тест отличается от объявления:

| Опция | Что делает |
| --- | --- |
| `overrides` | Подмены сервисов, как у `createTestContainer` |
| `http: false` | Без HTTP-сервера: тест сервисов и фоновой работы |
| `http: { … }` | Меняет отдельные настройки HTTP, остальные остаются из `@App` |
| Любое поле `@App` (`infra`, `cache`, `config`, `language`…) | Заменяет объявленное: `infra: TestInfra` |

Порт и адрес задаёт сам помощник, окружение — `test`, строки «bazis
started» нет. Ошибка настроек или запуска бросается в тест, а не завершает
процесс. Приложение без `http` в `@App` стартует в тесте тоже без сервера.

Всегда останавливайте приложение в `finally`: иначе следующий тест может
упасть на занятых ресурсах, а `bun test` — не завершиться.

### Часть приложения

`startTestApp` принимает и отдельный модуль — чтобы поднять одну функцию
без остальных. Тогда всё, что ей нужно, задаёт сам тест:

```ts
const app = await startTestApp(TaskModule, { infra: TestInfra, http: { prefix: "api" } });
```

### Права в тестах

Тесту, который не про права, не нужна настоящая система прав:
`allowAll()` из `bazis/core/access/testing` разрешает всё всем.

```ts
import { allowAll } from "bazis/core/access/testing";

const app = await startTestApp(Application, { overrides: [allowAll()] });
```

Запросу по-прежнему нужен вошедший пользователь; `allowAll({ anonymous: "test" })`
пускает и запрос без него — как субъекта `test`. Отдельным субъектам права
сужают: `allowAll({ grants: { "user:2": { "orders.delete": [] } } })`. Тест
самих прав описывает их целиком через `StaticAccessPolicy` — см.
[«Права»](../security/access.md). `allowAll` — с версии 0.138.0.

## Тест нового проекта

`bazis new` создаёт тест `src/app/test/health.test.ts`: он поднимает
приложение из `src/app/App.ts` и проверяет `/health`.

```ts
import { expect, test } from "bun:test";
import { startTestApp } from "bazis/core/testing";
import { Application } from "../App";

test("app starts and answers /health", async () => {
  const app = await startTestApp(Application);
  try {
    expect((await app.fetch("/health")).status).toBe(200);
  } finally {
    await app.stop();
  }
});
```

До версии 0.138.0 этот тест запускал `src/index.ts` отдельным процессом:
опции приложения жили в точке входа, и иначе тест их не видел.

## Конфигурация в тестах

Секция `test` в `defineConfig` задаёт значения для тестов, переменные
`BAZIS_*` работают как обычно:

```ts
export const mailConfig = defineConfig("mail", {
  default: { host: "localhost", apiKey: secret("dev-key") },
  test: { host: "smtp.test" },
  production: { apiKey: secret() },
});
```

## Дальше

- [Тесты процесса](../workflow/processes.md#тесты-процесса) — `testWorkflow` с часами теста
- [DI подробно](dependency-injection.md)
- [Конфигурация](configuration.md)
- [Кодогенерация](codegen.md)
