# Ответы

Метод контроллера возвращает данные, а bazis превращает их в HTTP-ответ.
Обычно достаточно вернуть объект; для остального есть помощники и
`ResponseBuilder`.

## Что вернул метод — что получит клиент

| Возвращаемое значение | Код | `Content-Type` |
| --- | --- | --- |
| Объект, массив, число, `true` / `false` | 200 | `application/json` |
| Строка | 200 | `text/plain` |
| `undefined` или `null` | 204 | — |
| `Uint8Array` | 200 | `application/octet-stream` |
| `ReadableStream` | 200 | Не задаётся — укажите сами |
| `Bun.file(...)` или `File(...)` | 200 | По расширению файла |
| `Response` | Как в самом `Response` | Как в самом `Response` |
| Результат помощника (`Created(...)` и др.) | Из помощника | `application/json` для тела-объекта |

Методы могут быть `async` — тогда важен результат `Promise`.

## Помощники

```ts
import { Created, NoContent, NotFound, Ok, Redirect, StatusCode } from "bazis/core/http";

@Get(":id")
async getById(id: string) {
  const task = await this.tasks.getById(id);
  return task ? Ok(task) : NotFound({ error: `task ${id} not found` });
}

@Post()
async create(body: CreateTaskRequest, ctx: HttpContext) {
  const task = await this.tasks.create(body);
  return Created(`${ctx.path}/${task.id}`, task);   // 201 + Location
}
```

| Помощник | Код |
| --- | --- |
| `Ok(body?)` | 200; без тела — пустой ответ |
| `Created(location?, body?)` | 201 и заголовок `Location` |
| `Accepted(body?)` | 202 |
| `NoContent()` | 204 |
| `BadRequest(body?)` | 400 |
| `Unauthorized(body?)` · `Forbidden(body?)` | 401 · 403 |
| `NotFound(body?)` · `Conflict(body?)` | 404 · 409 |
| `InternalServerError(body?)` | 500 |
| `Redirect(url, permanent?)` | 302, или 301 при `permanent = true` |
| `StatusCode(code, body?)` | Любой код |
| `File(path \| Blob \| Uint8Array, contentType?)` | 200, файл или байты |

## Код и заголовки: `ResponseBuilder`

Когда нужно вернуть обычный объект, но с другим кодом или дополнительными
заголовками, используйте `ctx.res` (или параметр типа `ResponseBuilder`):

```ts
@Post("import")
startImport(ctx: HttpContext) {
  ctx.res.status(202).header("x-job-id", "42");
  return { queued: true };
}
// 202, x-job-id: 42, {"queued":true}

@Post("login")
login(res: ResponseBuilder) {
  res.header("set-cookie", "sid=abc; HttpOnly; Secure; Path=/");
  return { ok: true };
}
```

| Метод | Что делает |
| --- | --- |
| `status(code)` | Код ответа |
| `header(name, value)` | Добавить заголовок |
| `contentType(value)` | `Content-Type` |

Постоянный код успешного ответа удобнее задать в декораторе:
`@Post("import", { code: 202 })`, а постоянный тип содержимого —
`@Get("page", { produces: "text/html; charset=utf-8" })`.

## Файлы

```ts
@Get("report")
report() {
  return File("./reports/latest.pdf");          // тип — по расширению
}

@Get("export")
export() {
  return File(csvBytes, "text/csv; charset=utf-8");
}
```

Для файла по пути работают запросы диапазонов: `Range: bytes=0-4` → `206
Partial Content`. Вместо `File(path)` можно вернуть и `Bun.file(path)`.

## Потоковые ответы

Верните `ReadableStream` — данные уйдут клиенту по мере появления:

```ts
@Get("events")
events() {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const line of ["first", "second"]) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  }), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
```

Пока поток не закончился, сервисы запроса (`scoped`) остаются живыми: поток
может ими пользоваться. Освобождаются они, когда поток дочитан, оборвался или
клиент отключился.

## Ловушки сериализации JSON

Объекты превращаются в JSON через `JSON.stringify`:

| Значение | Что получит клиент |
| --- | --- |
| `Date` | Строка ISO: `"2026-01-02T03:04:05.000Z"` |
| `bigint` | **Ошибка 500** — `JSON.stringify` не умеет `bigint` |
| `Map`, `Set` | **Пустой объект `{}`** — данные молча пропадают |
| `undefined` в поле объекта | Поле не попадает в JSON |

`bigint` преобразуйте в строку или число, `Map` — в объект
(`Object.fromEntries(map)`), `Set` — в массив (`[...set]`). Надёжнее всего
возвращать специальные классы ответа (`TaskResponse`) с простыми полями —
так формат ответа становится явным контрактом.

## Дальше

- [Контроллеры](controllers.md)
- [Middleware](middleware.md)
- Обработка ошибок *(в работе)*
