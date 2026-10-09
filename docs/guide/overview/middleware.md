# Middleware

Middleware — функция, которая выполняется до и после обработчика запроса. Она
получает контекст запроса и функцию `next`, которая передаёт управление
дальше по цепочке.

```ts
import type { HttpMiddleware } from "bazis/core/http";

export const timing: HttpMiddleware = async (ctx, next) => {
  const started = performance.now();
  await next();                                  // всё остальное, включая контроллер
  ctx.response?.headers.set("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
};
```

## Где подключать

| Уровень | Как подключить | Для чего |
| --- | --- | --- |
| Всё приложение | `runApp(AppModule, { http: { middleware: [timing] } })` | Журнал, замеры, общие заголовки |
| Контроллер | `@Middleware(mw)` на классе | Всё, что касается этого контроллера |
| Метод | `@Middleware(mw)` на методе или `{ middleware: [mw] }` в декораторе маршрута | Один маршрут |

```ts
import { Controller, Get, Middleware, rateLimit } from "bazis/core/http";

@Controller("reports")
@Middleware(auditLog)
export class ReportController {
  @Get("heavy")
  @Middleware(rateLimit({ windowMs: 60_000, max: 10 }))
  heavy() { ... }
}
```

## Порядок выполнения

```text
запрос
 → встроенные: журнал запросов, CORS, заголовки безопасности, обработчик ошибок
 → глобальные middleware (из runApp)
 → проверка доступа @Authorize
 → middleware контроллера → middleware метода
 → привязка аргументов и проверка модели → ActionFilter.before
 → кэш ответа (если включён)
 → метод контроллера
 ← ActionFilter.after ← метод ← контроллер ← глобальные ← встроенные
```

Проверено на запросе к методу, где на каждом уровне стоит middleware,
записывающий своё имя:

```text
global:before → controller:before → method:before → filter:before → action
→ filter:after → method:after → controller:after → global:after
```

Middleware маршрута выполняется **после** проверки доступа: запрос без
прав не доходит до логики контроллера. Глобальные middleware выполняются
**до** неё — поэтому журнал и ограничение частоты видят и отклонённые
запросы.

## Остановить запрос

Чтобы ответить сразу, установите `ctx.response` и не вызывайте `next()`:

```ts
export const requireApiKey: HttpMiddleware = async (ctx, next) => {
  if (ctx.header("x-api-key") !== process.env.API_KEY) {
    ctx.response = Response.json({ error: "api key required" }, { status: 401 });
    return;
  }
  await next();
};
```

Другой способ — бросить ошибку, например `throw new UnauthorizedError()` из
`bazis/core/http`: встроенный обработчик превратит её в ответ с нужным кодом.

## Изменить ответ

После `await next()` готовый ответ лежит в `ctx.response`:

```ts
export const noStore: HttpMiddleware = async (ctx, next) => {
  await next();
  ctx.response?.headers.set("cache-control", "no-store");
};
```

## Сервисы внутри middleware

Middleware — обычная функция, конструктора у неё нет. Сервисы текущего
запроса берите из `ctx.services`:

```ts
export const auditLog: HttpMiddleware = async (ctx, next) => {
  await next();
  await ctx.services.resolve(AuditService).record(ctx.method, ctx.path, ctx.response?.status);
};
```

## Фильтры действий

`@ActionFilter` выполняется ближе всего к методу: `before` — после привязки
аргументов, `after` — получает результат метода и может его заменить:

```ts
@Get()
@ActionFilter({
  before: (ctx) => { /* аргументы уже проверены */ },
  after: (ctx, result) => ({ ...(result as object), servedAt: new Date().toISOString() }),
})
list() { return { items: [] }; }
```

## Встроенные middleware

| Middleware | Как включить | Что делает |
| --- | --- | --- |
| Заголовки безопасности | Включены по умолчанию; `securityHeaders: false` в `http` отключает | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` и др. |
| CORS | `http: { cors: { ... } }` | Заголовки CORS и ответы на preflight-запросы |
| Журнал запросов | `http: { accessLog: true }` | Строка в лог на каждый запрос |
| Ограничение частоты | `rateLimit({ windowMs, max })` как middleware | После `max` запросов за окно — `429` с `Retry-After` |
| Correlation id | `createCorrelationIdMiddleware()` | Идентификатор запроса для логов и исходящих вызовов |

Обработчик ошибок тоже встроенный и стоит перед глобальными middleware —
поэтому ошибки из middleware, контроллеров и сервисов превращаются в
корректные HTTP-ответы. Подробнее — в главе [Обработка ошибок](errors.md).

### CORS и журнал запросов

```ts
await runApp(AppModule, {
  http: {
    port: 3000,
    accessLog: true,
    cors: { origin: ["https://app.example.com"], credentials: true },
  },
});
```

Ответ получает `Access-Control-Allow-Origin` только для разрешённых
источников, preflight-запрос `OPTIONS` получает `204`. Настройки CORS:
`origin` (строка, список или функция), `methods`, `allowedHeaders`,
`exposedHeaders`, `credentials`, `maxAgeSeconds`. Подробнее — в главе
[CORS, заголовки безопасности, журнал запросов](../http/cors-headers-log.md).

Строка журнала на каждый запрос:

```text
info: GET /mw/corr 200 0.9ms {"method":"GET","path":"/mw/corr","status":200,"durationMs":0.94,"requestId":"3591e739-..."}
```

`requestId` появляется, когда подключён `createCorrelationIdMiddleware()`: он
берёт идентификатор из входящего заголовка или создаёт новый и возвращает его
клиенту в заголовке `x-request-id`.

### `rateLimit`

```ts
rateLimit({ windowMs: 60_000, max: 30 })                         // по IP клиента
rateLimit({ windowMs: 60_000, max: 100, keyOf: (ctx) => ctx.header("x-api-key") ?? "anon" })
```

```text
запрос 1, 2 → 200
запрос 3    → 429 Too Many Requests, Retry-After: 60
```

| Параметр | Что задаёт |
| --- | --- |
| `windowMs` | Длина окна в миллисекундах |
| `max` | Сколько запросов разрешено за окно |
| `keyOf` | Кого считать: по умолчанию IP клиента |
| `trustProxy` | Брать IP из `X-Forwarded-For` (только за доверенным прокси) |
| `maxBuckets` | Сколько разных ключей помнить; по умолчанию 10 000 |

Счётчики живут в памяти процесса. Если приложение запущено в нескольких
экземплярах, у каждого свой лимит.

## Дальше

- [Авторизация](authorization.md)
- [Контроллеры](controllers.md)
