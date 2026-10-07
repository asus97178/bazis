# Обработка ошибок

Ошибку в bazis достаточно бросить. Встроенный обработчик ошибок стоит снаружи
всех middleware и контроллеров: он ловит исключение и превращает его в
HTTP-ответ.

```ts
import { NotFoundError } from "bazis/core/http";

@Get(":id")
async getById(id: string) {
  const task = await this.tasks.getById(id);
  if (!task) throw new NotFoundError(`task ${id} not found`);
  return task;
}
// 404 {"error":"task 42 not found"}
```

## Ошибки HTTP

Всё, что наследует `HttpError` из `bazis/core/http`, становится ответом со
своим кодом:

| Класс | Код | Что ещё |
| --- | --- | --- |
| `BadRequestError(message?, details?)` | 400 | |
| `UnauthorizedError(message?, details?)` | 401 | Заголовок `WWW-Authenticate: Bearer` |
| `ForbiddenError(message?, details?)` | 403 | |
| `NotFoundError(message?, details?)` | 404 | |
| `HttpError(status, message, details?)` | Любой | Для кодов без своего класса: 409, 422 и т. д. |

Тело ответа — `{ "error": message }`, а если переданы `details`, то и они:

```ts
throw new HttpError(409, "Name is taken", { field: "name" });
// 409 {"error":"Name is taken","details":{"field":"name"}}
```

`details` уходят клиенту как есть — не кладите туда внутренние данные.

### Ошибки, которые bazis бросает сам

| Ситуация | Ответ |
| --- | --- |
| Нет такого маршрута | `404 {"error":"Not Found"}` |
| Маршрут есть, метода нет | `405 {"error":"Method Not Allowed"}` и заголовок `Allow: GET, HEAD` |
| Тело — не JSON | `400 {"error":"Malformed JSON in request body"}` |
| Неверный `Content-Type` тела | `415 {"error":"Unsupported Media Type: expected application/json"}` |
| Тело больше предела | `413 {"error":"Payload Too Large","details":{"maxBytes":…}}` |
| Модель запроса не прошла проверку | `400` со списком нарушений — см. [валидацию](validation.md) |
| Сработал `rateLimit` | `429` и заголовок `Retry-After` |
| Проверка `@Authorize` вернула `false` | `403 {"error":"Forbidden"}` |

## Неожиданные ошибки

Любое другое исключение — `Error`, `TypeError`, ошибка драйвера базы — даёт
`500`. Что увидит клиент, зависит от окружения:

| Окружение | Ответ |
| --- | --- |
| `development`, `test` | `{"error":"Internal Server Error","message":"…","stack":"…"}` |
| `production` | `{"error":"Internal Server Error"}` |

В production текст и стек ошибки клиенту не уходят. Явно включить или
выключить подробности можно опцией `runApp(AppModule, { http: {
exposeErrorDetails: false } })`.

Код ответа берётся только из `HttpError`. Обычный `Error` со свойством
`status: 418` всё равно даст `500`: так случайный объект ошибки из чужой
библиотеки не управляет ответами вашего API.

## Журнал ошибок

Каждая неожиданная ошибка попадает в журнал приложения одной строкой уровня
`error` — в том же формате, что и журнал запросов:

```text
error: GET /errors/crash failed {"method":"GET","path":"/errors/crash","requestId":"req-42","error":{"name":"Error","message":"connection to db lost: password=***","stack":"…"}}
info: GET /errors/crash 500 1.2ms {"method":"GET","path":"/errors/crash","status":500,"durationMs":1.18,"requestId":"req-42"}
```

- `requestId` появляется, если подключён `createCorrelationIdMiddleware()`
  (см. [Middleware](middleware.md#встроенные-middleware)): по нему строка
  ошибки находится рядом со строкой запроса.
- Пароли, токены и другие секреты в тексте ошибки маскируются — и в журнале,
  и в подробном ответе для разработки.
- Ошибки `HttpError` (404, 403 и т. д.) в журнал ошибок не пишутся: это
  нормальные ответы API, они видны в журнале запросов.

Чтобы ещё и отправлять ошибки в систему отслеживания (Sentry и подобные),
подключите обработчик `onUnexpectedError`. Он получает контекст запроса и
саму ошибку и **не отменяет** запись в журнал:

```ts
await runApp(AppModule, {
  http: {
    errorHandler: {
      onUnexpectedError: (ctx, error) => tracker.capture(error, { path: ctx.path }),
    },
  },
});
```

Ошибка приходит в обработчик как есть, без маскировки: что отправлять наружу,
решает он сам. Полностью заменить запись в журнал можно опцией
`errorHandler.logError: (error) => { ... }`.

> [!NOTE]
> Запись неожиданных ошибок через журнал приложения с `requestId` и маскировка
> в ответе для разработки — с версии 0.97.1. Раньше ошибки писались
> напрямую в `console.error`.

## Бросить ошибку или вернуть ответ

`throw new NotFoundError()` и `return NotFound()` из
[помощников ответа](responses.md#помощники) дают один и тот же `404`. Удобное
правило:

- В методе контроллера, где решение очевидно, — **вернуть** помощник:
  `return task ? Ok(task) : NotFound({ error: "…" })`.
- Глубже — в проверке доступа, middleware, общей функции — **бросить**
  `HttpError`: так ответ можно задать, не протаскивая его через все вызовы.

## Доменные ошибки

Сервисам лучше не знать про HTTP: тот же сервис вызывают из фоновой задачи,
AI-инструмента или теста. Поэтому сервис бросает свою ошибку, а в HTTP-ответ
её переводит слой HTTP:

```ts
// ошибка предметной области — без кодов HTTP
export class TaskNotFound extends Error {
  constructor(readonly id: string) {
    super(`task ${id} not found`);
    this.name = "TaskNotFound";
  }
}
```

**В контроллере** — если ошибка нужна одному методу:

```ts
@Get(":id")
async getById(id: string) {
  try {
    return await this.tasks.getById(id);
  } catch (error) {
    if (error instanceof TaskNotFound) throw new NotFoundError(error.message);
    throw error;                                     // остальное — дальше, обработчику
  }
}
```

**Одним middleware на всё приложение** — если ошибка встречается во многих
местах:

```ts
import { NotFoundError, type HttpMiddleware } from "bazis/core/http";

export const domainErrors: HttpMiddleware = async (_ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof TaskNotFound) throw new NotFoundError(error.message, { id: error.id });
    throw error;
  }
};

await runApp(AppModule, { http: { middleware: [domainErrors] } });
```

```text
GET /tasks/7 → 404 {"error":"task 7 not found","details":{"id":"7"}}
```

Глобальные middleware выполняются внутри встроенного обработчика ошибок,
поэтому брошенный ими `HttpError` превращается в ответ как обычно.
Не забывайте `throw error` для остальных ошибок. Middleware, который
проглотил исключение и не задал `ctx.response`, превращает падение в
`404 {"error":"Not Found"}`: клиент думает, что ресурса нет, а в журнале
ошибки не остаётся.

## Дальше

- [Ответы](responses.md)
- [Middleware](middleware.md)
- [Авторизация](authorization.md)
