# Тестирование

Тесты в bazis — обычные тесты `bun:test`. Фреймворк добавляет к ним две
вещи: подмену зависимостей и запуск приложения прямо в процессе теста.

Все примеры проверены на bazis 0.98.0.

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
  const container = await createTestContainer(AppModule, {
    overrides: [singleton(ITaskStore, FakeStore)],
  });
  const tasks = container.createScope().resolve(TaskService);
  expect(await tasks.title("1")).toBe("WRITE DOCS");
});
```

`overrides` заменяет регистрацию токена во всём приложении, даже если
модуль-владелец сам им пользуется, и не зависит от порядка `imports`. Если
подменять нечего — опечатка в токене, — тест упадёт сразу:

```text
Override of "ITaskStore" replaces nothing: no module registers it.
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

## HTTP: `startTestApp`

`startTestApp` запускает приложение в процессе теста — так же, как
`runApp`, — на свободном порту:

```ts
import { singleton } from "bazis/core/di";
import { startTestApp } from "bazis/core/testing";

test("GET /tasks/:id", async () => {
  const app = await startTestApp(AppModule, { overrides: [singleton(ITaskStore, FakeStore)] });
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

Проверяется всё, что видит клиент: маршруты, привязка аргументов,
валидация, авторизация, коды ответов и обработка ошибок.

| У `app` есть | Что это |
| --- | --- |
| `fetch(path, init?)` | `fetch` относительно адреса приложения |
| `url` | `http://127.0.0.1:<порт>` |
| `container` | Контейнер приложения: `app.container.createScope().resolve(TaskService)` |
| `stop()` | Плавная остановка, как по `SIGTERM` |

Опции — те же, что у `runApp` (`cache`, `infra`, `config`, `http`…), плюс
`overrides`. Порт и адрес задаёт сам помощник, окружение — `test`, строки
«bazis started» нет. Ошибка настроек или запуска бросается в тест, а не
завершает процесс.

Всегда останавливайте приложение в `finally`: иначе следующий тест может
упасть на занятых ресурсах, а `bun test` — не завершиться.

## Запуск как в production

`bazis new` создаёт тест `src/app/test/health.test.ts`: он запускает
`src/index.ts` отдельным процессом — ровно так, как `bazis dev`, — и
проверяет `/health`. Оставьте его: он ловит ошибки в самой точке входа,
которые `startTestApp` не увидит, потому что не выполняет `src/index.ts`.

## Конфигурация в тестах

Секция `test` в `defineConfig` задаёт значения для тестов, переменные
`BAZIS_*` работают как обычно:

```ts
export const mailConfig = defineConfig<MailConfig>("mail", {
  default: { host: "localhost", apiKey: secret("dev-key") },
  test: { host: "smtp.test" },
  production: { apiKey: secret() },
});
```

## Дальше

- [DI подробно](dependency-injection.md)
- [Конфигурация](configuration.md)
- [Кодогенерация](codegen.md)
