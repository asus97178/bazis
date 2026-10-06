# Контроллеры

Контроллер принимает HTTP-запросы. Это класс с декоратором `@Controller`,
методы которого помечены декораторами маршрутов. Логику контроллер держит
тонкой: разбирает запрос, вызывает сервис и возвращает результат.

```ts
import { Controller, Created, Get, HttpContext, NotFound, Post } from "bazis/core/http";

@Controller("tasks")
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get(":id(uuid)")
  async getById(id: string) {
    const task = await this.tasks.getById(id);
    return task ?? NotFound({ error: `task ${id} not found` });
  }

  @Post()
  async create(body: CreateTaskRequest, ctx: HttpContext) {
    const task = await this.tasks.create(body);
    return Created(`${ctx.path}/${task.id}`, task);
  }
}
```

Контроллер подключают в модуле через `controllers: [TaskController]`.
Регистрировать его в `providers` не нужно: на каждый запрос создаётся новый
экземпляр, а зависимости приходят через конструктор, как у сервисов.

## Маршруты

Адрес метода складывается из префикса контроллера и шаблона метода:
`@Controller("tasks")` + `@Get(":id")` → `GET /tasks/:id`.

| Декоратор | HTTP-метод |
| --- | --- |
| `@Get` · `@Post` · `@Put` · `@Patch` · `@Delete` | Соответствующий метод |
| `@Head` · `@Options` | `HEAD`, `OPTIONS` |
| `@All` | Любой метод |

Части шаблона:

| Запись | Что значит | Пример |
| --- | --- | --- |
| `items` | Обычный сегмент пути | `/tasks/items` |
| `:id` | Параметр — любая строка в этом сегменте | `/tasks/abc` → `id = "abc"` |
| `:id(int)` | Параметр с ограничением | `/tasks/42` → `id = 42`; `/tasks/abc` → 404 |
| `*path` | Остаток пути, только в конце шаблона | `/files/a/b.txt` → `path = "a/b.txt"` |
| `*` | То же, параметр называется `rest` | |

Ограничения параметров: `int`, `number`, `bool`, `uuid`, `alpha` (только
латинские буквы). Если значение не подходит, маршрут не совпадает и клиент
получает 404. Неизвестное ограничение — ошибка при запуске.

Параметры можно ставить и в префикс контроллера:
`@Controller("projects/:projectId/tasks")`.

## Аргументы методов

Декораторов на параметрах нет: источник значения bazis определяет по имени и
типу параметра.

| Параметр метода | Откуда значение |
| --- | --- |
| Имя совпадает с параметром маршрута | Из пути, с преобразованием по ограничению или типу |
| Класс модели запроса | Из JSON-тела, с проверкой `@Validator` |
| `HttpContext`, `Request`, `ResponseBuilder` | Контекст запроса, исходный запрос, построитель ответа |
| `string` / `number` / `boolean`, которого нет в маршруте | Из строки запроса |

Параметр строки запроса без значения по умолчанию обязателен:

```ts
@Get("search")
search(q: string, limit = 10) { ... }
```

```text
GET /tasks/search?q=bun&limit=5   → q = "bun", limit = 5
GET /tasks/search?q=bun           → q = "bun", limit = 10
GET /tasks/search                 → 400 Missing required query parameter "q"
GET /tasks/search?q=bun&limit=abc → 400
```

Если по сигнатуре нельзя понять, откуда брать параметр — например, у него нет
типа или в методе две модели тела, — кодогенерация останавливается с ошибкой
`BAZIS_HTTP_BINDING_UNRESOLVED` и называет метод и причину.

> [!NOTE]
> Параметры из префикса контроллера и `*path` привязываются с версии 0.96.4.

### `HttpContext`

Через контекст доступно всё остальное о запросе:

| Свойство или метод | Что даёт |
| --- | --- |
| `ctx.method`, `ctx.path`, `ctx.url` | Метод, путь, полный URL |
| `ctx.params` | Все параметры маршрута |
| `ctx.query(name)` | Значение из строки запроса |
| `ctx.header(name)` | Заголовок запроса |
| `ctx.text()`, `ctx.formData()` | Тело как текст или форма |
| `ctx.request` | Исходный `Request` |
| `ctx.state` | Данные, которые middleware передают дальше по запросу |

## Ответы

Что вернул метод, то и уходит клиенту:

| Возвращаемое значение | Ответ |
| --- | --- |
| Объект или массив | `200`, JSON |
| Строка | `200`, `text/plain` |
| `undefined` | `204 No Content` |
| `Response` | Отправляется как есть |
| Результат помощника (`NotFound(...)` и др.) | Код и тело из помощника |

Методы могут быть асинхронными — возвращайте `Promise`.

Помощники из `bazis/core/http`:

| Помощник | Код |
| --- | --- |
| `Ok(body)` | 200 |
| `Created(location, body)` | 201 + заголовок `Location` |
| `Accepted(body)` | 202 |
| `NoContent()` | 204 |
| `BadRequest(body)` · `Unauthorized(body)` · `Forbidden(body)` · `NotFound(body)` · `Conflict(body)` | 400 · 401 · 403 · 404 · 409 |
| `InternalServerError(body)` | 500 |
| `Redirect(url, permanent?)` | 302, или 301 при `permanent = true` |
| `StatusCode(code, body)` | Любой код |
| `File(path \| Blob \| Uint8Array, contentType?)` | Файл; для пути — с поддержкой `Range` |

Код успешного ответа можно задать в декораторе вместо помощника:

```ts
@Post("import", { code: 202 })
startImport() { return { queued: true }; }
```

## Параметры маршрута в декораторе

Второй аргумент декоратора маршрута — объект настроек:

| Настройка | Что делает |
| --- | --- |
| `code` | Код успешного ответа |
| `produces` | `Content-Type` ответа для простых результатов |
| `consumes` | Обязательный `Content-Type` запроса для методов с телом |
| `maxBodySize` | Предельный размер тела, например `"4mb"` |
| `middleware` | Middleware только для этого метода |
| `version` | Версия API метода |

## Дальше

- [Модели запросов и валидация](validation.md)
- [Провайдеры и DI](providers.md)
