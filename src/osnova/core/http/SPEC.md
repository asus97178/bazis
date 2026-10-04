# HTTP Middleware и `@Middleware` — спецификация

Per-request конвейер middleware в стиле ASP.NET Core / Koa: функции `(ctx, next)`,
скомпилированные **один раз на маршрут** при старте сервера. Декоратор `@Middleware`
— декларативный способ повесить middleware на контроллер или action.

Быстрая навигация:
- [1. Что это и зачем](#1-что-это-и-зачем)
- [2. Архитектура pipeline](#2-архитектура-pipeline)
- [3. Быстрый старт](#3-быстрый-старт)
- [4. `@Middleware` — справочник](#4-middleware--справочник)
- [5. Контракт `HttpMiddleware`](#5-контракт-httpmiddleware)
- [6. Способы подключения middleware](#6-способы-подключения-middleware)
- [7. Встроенные фабрики middleware](#7-встроенные-фабрики-middleware)
- [8. `HttpContext` в middleware](#8-httpcontext-в-middleware)
- [9. Сценарии и примеры](#9-сценарии-и-примеры)
- [10. Порядок выполнения и нюансы](#10-порядок-выполнения-и-нюансы)
- [11. Интеграция с auth и cache](#11-интеграция-с-auth-и-cache)
- [12. Middleware vs ActionFilter vs `@Catch`](#12-middleware-vs-actionfilter-vs-catch)
- [13. Хорошие и плохие практики](#13-хорошие-и-плохие-практики)
- [14. Ограничения и анти-паттерны](#14-ограничения-и-анти-паттерны)
- [15. FAQ](#15-faq)
- [16. Карта папки](#16-карта-папки)

---

## 1. Что это и зачем

**Middleware** — функция, которая выполняется **до** (и/или **после**) action
контроллера в рамках одного HTTP-запроса. Типичные задачи:

| Задача | Пример |
| --- | --- |
| Аутентификация | `jwtBearer()` — разбор Bearer JWT |
| Авторизация | `authorize()` — из `@Authorize` (см. `@/auth`) |
| Кэш ответа | `outputCacheMiddleware()` — из `@OutputCache` |
| CORS | `cors({ origin: "..." })` |
| Rate limiting | `rateLimit({ windowMs, max })` |
| Логирование / трассировка | кастомный middleware с заголовком `x-request-id` |
| Проверка API key | middleware до action, без binding body |

**`@Middleware`** — TC39-декоратор, который записывает одну или несколько
middleware-функций в metadata контроллера или метода. На старте `RouterBuilder`
собирает из metadata **готовый массив** — на горячем пути metadata не читается.

Зачем декоратор, а не только `httpModule({ middleware })`:

| Критерий | Глобальный middleware | `@Middleware` |
| --- | --- | --- |
| Область | все маршруты | один controller / один action |
| Декларативность | конфиг модуля | рядом с `@Get` / `@Post` |
| Переиспользование | одна функция на всё приложение | разные цепочки per controller |
| Compile-time | массив в `httpModule` | metadata → pipeline на старте |

Импорт:

```ts
import {
  Middleware,
  type HttpMiddleware,
  rateLimit,
  cors,
  HttpContext,
  UnauthorizedError,
} from "@/core/http";
```

---

## 2. Архитектура pipeline

### Полная цепочка одного маршрута

```
HTTP Request
    │
    ▼
[1] correlationId + accessLog  ← LoggingModule.forRoot().httpIntegration
[2] cors?                           ← httpModule({ cors })
[3] errorHandler                    ← всегда (глобальная граница ошибок)
[4] httpModule.middleware           ← глобальные hook'и (jwtBearer, …)
[5] @Middleware (класс)     ← декоратор на контроллере
[6] routeMiddlewareComposer ← @Authorize, @OutputCache, … (compile-time)
[7] @Middleware (метод)     ← декоратор или RouteOptions.middleware
[8] terminal                ← bind → ActionFilter → action → @Catch
    │
    ▼
HTTP Response
```

Сборка в `RouterBuilder`:

```ts
const chain = [
  ...serverChain,           // [1]–[4]
  ...meta.middleware,       // [5]
  ...composed,              // [6]
  ...action.middleware,     // [7]
  terminal,                 // [8]
];
```

### Что **не** проходит через pipeline

| Ситуация | Поведение |
| --- | --- |
| CORS preflight (`OPTIONS` + `Access-Control-Request-Method`) | ответ до routing |
| 404 Not Found | JSON без pipeline |
| 405 Method Not Allowed | JSON без pipeline |
| Malformed path (`..`, `%zz`) | 400 без pipeline |

### Lifetime и DI

Каждый запрос создаёт **новый DI scope** (`ctx.services`). Middleware и action
разделяют один scope на время запроса; после ответа scope dispose'ится.

---

## 3. Быстрый старт

### Middleware на контроллере

```ts
import { Controller, Get, Middleware, type HttpMiddleware } from "@/core/http";

const requestId: HttpMiddleware = async (ctx, next) => {
  const id = crypto.randomUUID();
  ctx.state.set("requestId", id);
  await next();
  ctx.response?.headers.set("x-request-id", id);
};

@Controller("users")
@Middleware(requestId)
class UsersController {
  @Get()
  list() {
    return [{ id: 1 }];
  }
}
```

### Middleware на одном action

```ts
@Controller("webhooks")
class WebhooksController {
  @Post("stripe")
  @Middleware(verifyStripeSignature)
  handleStripe() {
    return { ok: true };
  }
}
```

### Глобально через `httpModule`

```ts
import { Module } from "@/core";
import { httpModule } from "@/core/http";
import { jwtModule } from "@/auth";

const jwt = jwtModule({ options: { /* … */ } });

@Module({
  imports: [
    httpModule({
      imports: [FeatureModule],
      middleware: [...jwt.httpIntegration.serverMiddleware],
      routeMiddlewareComposer: jwt.httpIntegration.routeMiddlewareComposer,
    }),
  ],
})
class AppModule {}
```

---

## 4. `@Middleware` — справочник

### Сигнатура

```ts
function Middleware(...middleware: HttpMiddleware[]): ClassOrMethodDecorator;
```

| Параметр | Тип | Обязательно | Описание |
| --- | --- | --- | --- |
| `...middleware` | `HttpMiddleware[]` | ✅ (≥1) | Одна или несколько функций в порядке выполнения |

**У `@Middleware` нет объекта опций** — только variadic список функций.
Настройки передаются через замыкание фабрики (`rateLimit({ max: 100 })`).

### Где можно использовать

| Место | Область действия | Metadata |
| --- | --- | --- |
| Класс контроллера | все actions контроллера | `ControllerMeta.middleware` |
| Метод с `@Get`/`@Post`/… | только этот action | `ActionMeta.middleware` |

### Накопление

Несколько декораторов **добавляют** middleware в массив (не перезаписывают):

```ts
@Controller("api")
@Middleware(mwA)
@Middleware(mwB)
class ApiController {}
// порядок на маршруте: mwA → mwB → …
```

### Наследование (copy-on-write)

Metadata контроллера наследуется от базового класса через TC39 `Symbol.metadata`.
При первой записи в подклассе выполняется **clone** — базовый класс не мутируется.

```ts
@Controller("base")
@Middleware(sharedMiddleware)
class BaseController {}

@Controller("derived")
class DerivedController extends BaseController {}
// DerivedController наследует sharedMiddleware
```

### Эквивалент через inline-опции маршрута

`RouteOptions.middleware` на `@Get`/`@Post` пишет в тот же `ActionMeta.middleware`:

```ts
@Get("export", { middleware: [exportOnlyMiddleware] })
export() { ... }

// эквивалентно:
@Get("export")
@Middleware(exportOnlyMiddleware)
export() { ... }
```

При нескольких route-декораторах на одном методе поле `middleware`
**накапливается** (как push), скалярные поля (`code`, `produces`) перезаписываются.

---

## 5. Контракт `HttpMiddleware`

```ts
type HttpMiddleware = (
  ctx: HttpContext,
  next: () => Promise<void>,
) => void | Promise<void>;
```

### Правила

| Правило | Описание |
| --- | --- |
| Вызов `next()` | передаёт управление следующему звену цепочки |
| Без `next()` | **short-circuit** — pipeline останавливается; нужен `ctx.response` |
| Повторный `next()` | **ошибка** — `next() called multiple times` |
| Исключение | перехватывается `errorHandler` (если middleware внутри его `try`) |
| Синхронный / async | оба варианта допустимы |

### Short-circuit (ответ без action)

```ts
const maintenanceMode: HttpMiddleware = async (ctx, next) => {
  if (process.env.MAINTENANCE === "1") {
    ctx.response = new Response(JSON.stringify({ error: "Maintenance" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    return; // next() не вызываем
  }
  await next();
};
```

### «Around» middleware (до и после action)

```ts
const timing: HttpMiddleware = async (ctx, next) => {
  const started = performance.now();
  await next();
  const ms = (performance.now() - started).toFixed(1);
  ctx.response?.headers.set("x-duration-ms", ms);
};
```

### Middleware с DI

```ts
import { IAuditLog } from "./tokens";

const audit: HttpMiddleware = async (ctx, next) => {
  await next();
  const log = ctx.services.resolve(IAuditLog);
  await log.write({ method: ctx.method, path: ctx.path, status: ctx.response?.status });
};
```

> Middleware — **функция**, не DI-класс. Зависимости резолвятся из `ctx.services`
> внутри функции. Для переиспользуемых guard-подобных классов см. раздел
> [13. Хорошие и плохие практики](#13-хорошие-и-плохие-практики).

---

## 6. Способы подключения middleware

| # | Способ | Когда | Где в pipeline |
| --- | --- | --- | --- |
| 1 | `httpModule({ requestLogging, cors })` | встроенные cross-cutting | [1]–[2] |
| 2 | `httpModule({ middleware })` | глобально на всё API | [4] |
| 3 | `@Middleware` на классе | все actions контроллера | [5] |
| 4 | `routeMiddlewareComposer` | compile-time per route (auth, cache) | [6] |
| 5 | `@Middleware` на методе | один action | [7] |
| 6 | `RouteOptions.middleware` | inline на `@Get`/… | [7] |

### `HttpModuleOptions.middleware`

```ts
interface HttpModuleOptions {
  /** Global middleware after errorHandler, before controller ones. */
  readonly middleware?: readonly HttpMiddleware[];
}
```

| Поле | Тип | Default | Описание |
| --- | --- | --- | --- |
| `middleware` | `readonly HttpMiddleware[]` | `[]` | Глобальные middleware приложения |

Типичное содержимое: `jwtBearer()`, custom headers, metrics.

### `RouteMiddlewareComposer`

```ts
type RouteMiddlewareComposer = (
  controllerClass: Class<object>,
  methodName: string | symbol,
  httpMeta: ControllerMeta,
  action: ActionMeta,
) => readonly HttpMiddleware[];
```

| Поле | Тип | Описание |
| --- | --- | --- |
| return | `readonly HttpMiddleware[]` | Middleware для **конкретного** action |

Вызывается **один раз** при `HttpServer.start()`. Модули (`@/auth`, `@/core/cache`)
регистрируют composer через `httpIntegration.routeMiddlewareComposer`.
Несколько composer'ов объединяются:

```ts
import { composeRouteMiddlewareComposers } from "@/core/http";

routeMiddlewareComposer: composeRouteMiddlewareComposers(
  jwt.httpIntegration.routeMiddlewareComposer,
  cache.httpIntegration.routeMiddlewareComposer,
),
```

### `RouteOptions.middleware`

```ts
interface RouteOptions {
  readonly middleware?: readonly HttpMiddleware[];
  // также: code, produces, consumes, version
}
```

| Поле | Тип | Описание |
| --- | --- | --- |
| `middleware` | `readonly HttpMiddleware[]` | Middleware только для actions с этим route-декоратором |

---

## 7. Встроенные фабрики middleware

Экспорт из `@/core/http`. Подключаются через `@Middleware(...)`, `httpModule({ middleware })`
или встроенные опции модуля.

### `errorHandler(options?)`

**Всегда** в `serverChain` (позиция [3]). Вручную на маршрут не вешать.

| Поле `ErrorHandlerOptions` | Тип | Default | Описание |
| --- | --- | --- | --- |
| `exposeDetails` | `boolean` | `Environment.debug` | message/stack в 500 |
| `sink` | `LogSink` | resolve `LOG_SINK` | structured error log (`http.error`) |
| `logError` | `(error) => void` | `console.error` | fallback без `LOG_SINK` |

Unexpected errors (не `HttpError`) пишутся в {@link LOG_SINK} как `category:
http.error` с `requestId` из `ctx.state`. `HttpError` → JSON с `error.status`;
прочие → 500.

### `accessLogMiddleware(options?)`

В `@/logging/http/accessLogMiddleware`. Включается через `LoggingModule.forRoot().httpIntegration`
(второй middleware после correlation ID) или напрямую для тестов.

| Поле | Тип | Default | Описание |
| --- | --- | --- | --- |
| `sink` | `LogSink` | resolve `LOG_SINK` | Куда писать access {@link LogRecord} |
| `sanitizer` | `LogSanitizer` | resolve `LOG_SANITIZER` | Redaction полей access metadata |
| `includeQuery` | `boolean` | из `LOGGING_OPTIONS` | query object (sanitized) |
| `log` | `(line: string) => void` | `console.log` | fallback без `LOG_SINK` |

Lazy-resolvит `LOGGING_OPTIONS` из request scope: при `accessLog.enabled: false`
middleware no-op (correlation ID уже установлен предыдущим middleware).

Без `LOG_SINK`: текст `[http] GET /api/users 200 12.3ms req=<uuid>`.

С `LOG_SINK`: запись `type: "access"` с top-level `requestId` → composite sink.

Подробнее: `@/logging` SPEC (HTTP integration, correlation).

### `cors(options?)`

Глобально: `httpModule({ cors: { origin: "..." } })` — **и** preflight, **и** headers.

Per-route: `@Middleware(cors({ origin: "https://admin.example.com" }))` — только headers
на ответ (preflight по-прежнему обрабатывается глобально, если `cors` в `httpModule`).

| Поле `CorsOptions` | Тип | Default | Описание |
| --- | --- | --- | --- |
| `origin` | `string \| string[] \| fn \| "*"` | `"*"` | allowed origins |
| `methods` | `readonly string[]` | GET, POST, … | для preflight |
| `allowedHeaders` | `readonly string[]` | echo request | для preflight |
| `exposedHeaders` | `readonly string[]` | — | `Access-Control-Expose-Headers` |
| `credentials` | `boolean` | `false` | cookies; требует явный origin allow-list или predicate |
| `maxAgeSeconds` | `number` | — | preflight cache |

`credentials: true` нельзя сочетать с omitted origin, `"*"` или `["*"]`:
сервер падает на старте, чтобы не открыть credentialed allow-any-origin.

### `rateLimit(options)`

| Поле `RateLimitOptions` | Тип | Default | Описание |
| --- | --- | --- | --- |
| `windowMs` | `number` | — | размер окна (мс) |
| `max` | `number` | — | max запросов на key за окно |
| `keyOf` | `(ctx) => string` | `x-forwarded-for` или `"*"` | ключ bucket'а |

Превышение → `TooManyRequestsError` (429 + `Retry-After`).

> In-memory, per-process. Для кластера — свой middleware с Redis или
> `keyOf` по user id после `jwtBearer`.

---

## 8. `HttpContext` в middleware

| API | Описание |
| --- | --- |
| `ctx.request` | нативный Bun `Request` |
| `ctx.url` | parsed URL (query: `ctx.url.searchParams`) |
| `ctx.params` | route params после конверсии (`:id(int)` → `number`) |
| `ctx.method`, `ctx.path` | shortcuts |
| `ctx.header(name)` | заголовок (case-insensitive) |
| `ctx.query(name)` | query-параметр |
| `ctx.services` | request-scoped DI (`resolve`, `tryResolve`) |
| `ctx.state` | `Map<string, unknown>` — данные между middleware |
| `ctx.response` | итоговый `Response` (read/write) |
| `ctx.json()` | body JSON (кэшируется на запрос) |
| `ctx.text()`, `ctx.formData()` | альтернативные body |
| `ctx.apiVersion` | версия API, если включено versioning |

### Передача данных между middleware

```ts
// middleware A
ctx.state.set("tenantId", tenantId);

// middleware B или action
const tenantId = ctx.state.get("tenantId");
```

Auth-модуль кладёт principal в `ctx.state` (`AUTH_PRINCIPAL_STATE_KEY`) и в
scoped `ICurrentUser` — см. `@/auth` SPEC §7.

---

## 9. Сценарии и примеры

### 9.1. Request ID на всех маршрутах (глобально)

Используйте `LoggingModule.forRoot()` — correlation middleware уже в
`httpIntegration.serverMiddleware`:

```ts
import { LoggingModule } from "@/logging";

const logging = LoggingModule.forRoot({ bindFromConfig: true });

httpModule({
  imports: [logging.module],
  middleware: [...logging.httpIntegration.serverMiddleware],
});
```

Ключи: `REQUEST_ID_HEADER` (`x-request-id`), `REQUEST_ID_STATE_KEY` в
`ctx.state`. App logs в том же запросе получают `requestId` через
`AsyncLocalStorage` — см. `@/kernel` (`runWithRequestContext`).

Кастомный middleware (если logging module не подключён):

```ts
import { createCorrelationIdMiddleware } from "@/core/http";

httpModule({
  middleware: [createCorrelationIdMiddleware()],
});
```

### 9.2. Rate limit только на публичных endpoint'ах

```ts
import { AllowAnonymous, Authorize } from "@/auth";
import { rateLimit, Middleware } from "@/core/http";

const publicLimiter = rateLimit({ windowMs: 60_000, max: 30 });

@Controller("search")
@AllowAnonymous()
@Middleware(publicLimiter)
class SearchController {
  @Get()
  search(q: string) { /* … */ }
}

@Controller("admin")
@Authorize({ roles: "Admin" })
class AdminController {
  // publicLimiter не применяется
}
```

### 9.3. API key на webhook (один action)

```ts
import { UnauthorizedError } from "@/core/http";

function requireApiKey(expected: string): HttpMiddleware {
  return async (ctx, next) => {
    const key = ctx.header("x-api-key");
    if (key !== expected) {
      throw new UnauthorizedError("Invalid API key");
    }
    await next();
  };
}

@Controller("integrations")
class IntegrationsController {
  @Post("partner")
  @Middleware(requireApiKey(process.env.PARTNER_KEY!))
  partnerWebhook() {
    return { received: true };
  }
}
```

### 9.4. Проверка Content-Type до binding

```ts
import { UnsupportedMediaTypeError } from "@/core/http";

const requireJson: HttpMiddleware = async (ctx, next) => {
  const ct = ctx.header("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new UnsupportedMediaTypeError("application/json");
  }
  await next();
};

@Post("bulk")
@Middleware(requireJson)
@Consumes("application/json")
bulkImport(dto: BulkDto) { /* body binding + validation */ }
```

> `@Consumes` проверяет Content-Type **в terminal** (при binding). Middleware
> даёт ранний отказ до парсинга body — полезно для больших upload'ов.

### 9.5. CORS только для admin-контроллера

```ts
@Controller("admin")
@Middleware(cors({
  origin: ["https://admin.example.com"],
  credentials: true,
}))
class AdminController {
  @Get("stats")
  stats() { return { users: 100 }; }
}
```

Для browser preflight всё равно нужен глобальный `httpModule({ cors })` или
отдельная обработка OPTIONS.

### 9.6. Tenant из subdomain

```ts
const resolveTenant: HttpMiddleware = async (ctx, next) => {
  const host = ctx.header("host") ?? "";
  const tenant = host.split(".")[0];
  if (!tenant || tenant === "www") {
    throw new BadRequestError("Unknown tenant");
  }
  ctx.state.set("tenant", tenant);
  await next();
};

@Controller("app")
@Middleware(resolveTenant)
class AppController {}
```

### 9.7. Логирование тела (осторожно — PII)

```ts
const logBody: HttpMiddleware = async (ctx, next) => {
  if (ctx.method === "POST" || ctx.method === "PUT") {
    const clone = ctx.request.clone();
    const text = await clone.text();
    console.log("[debug-body]", ctx.path, text.slice(0, 500));
  }
  await next();
};
```

### 9.8. Несколько middleware в одном декораторе

```ts
@Post("submit")
@Middleware(verifyCsrf, rateLimit({ windowMs: 60_000, max: 5 }))
submit(dto: SubmitDto) { /* … */ }
```

### 9.9. Inline + декоратор на одном методе

```ts
@Get("report", { middleware: [cacheBustHeaders] })
@Middleware(requireReportAccess)
report() { /* … */ }
```

Оба попадают в `ActionMeta.middleware` [7]. Если порядок критичен — объединяйте
в один декоратор: `@Middleware(cacheBustHeaders, requireReportAccess)`.

### 9.10. Middleware + `@Authorize` + `@OutputCache`

```ts
import { Authorize } from "@/auth";
import { OutputCache } from "@/core/cache";

@Controller("catalog")
@Authorize()
@Middleware(rateLimit({ windowMs: 60_000, max: 120 }))
class CatalogController {
  @Get()
  @OutputCache({ policy: "catalog", varyByUser: true })
  list() {
    return this.service.list();
  }
}
```

Pipeline для `list`:

```
jwtBearer → authorize → rateLimit → outputCache → action
```

(auth и cache — через `routeMiddlewareComposer`, rate limit — `@Middleware` на классе)

### 9.11. Ownership check (guard-like без отдельного `@Guard`)

```ts
import { ForbiddenError, Param } from "@/core/http";
import { ICurrentUser } from "@/auth";

function requirePostOwner(store: IPostStore): HttpMiddleware {
  return async (ctx, next) => {
    const id = ctx.params.id as number;
    const user = ctx.services.resolve(ICurrentUser);
    const post = await store.byId(id);
    if (!post || post.authorId !== user.principal?.subject) {
      throw new ForbiddenError("Not your post");
    }
    await next();
  };
}

// фабрика с closure на store — store в middleware резолвится из DI:
function postOwnerGuard(): HttpMiddleware {
  return async (ctx, next) => {
    const store = ctx.services.resolve(IPostStore);
    const id = ctx.params.id as number;
    const user = ctx.services.resolve(ICurrentUser);
    const post = await store.byId(id);
    if (!post || post.authorId !== user.principal?.subject) {
      throw new ForbiddenError("Not your post");
    }
    await next();
  };
}

@Controller("posts")
@Authorize()
class PostsController {
  @Patch(":id(int)")
  @Middleware(postOwnerGuard())
  update(id: number, dto: UpdatePostDto) { /* … */ }
}
```

Для JWT/roles предпочитайте `@Authorize` / `@Policy`, не дублируйте auth в middleware.

### 9.12. Metrics / Prometheus

```ts
const httpMetrics: HttpMiddleware = async (ctx, next) => {
  const end = metrics.startTimer({ method: ctx.method });
  try {
    await next();
  } finally {
    end({ path: ctx.path, status: ctx.response?.status ?? 0 });
  }
};

httpModule({ middleware: [httpMetrics] });
```

---

## 10. Порядок выполнения и нюансы

### Направление «внутрь» и «наружу»

Middleware с `await next()` выполняют код **до** `next` на входе и **после**
`next` на выходе (как onion):

```
global BEFORE → controller BEFORE → composed BEFORE → action BEFORE
    → action
action AFTER ← composed AFTER ← controller AFTER ← global AFTER
```

E2E-тест фиксирует порядок заголовков при append **после** `next()`:

```
GET /api/users/1  →  x-trace: controller, global
```

`controller` ближе к action (append первым), `global` — снаружи.

### `@Middleware` класс vs метод vs composer

На одном маршруте:

```
[5] controller @Middleware  →  раньше
[6] routeMiddlewareComposer →  authorize, output cache
[7] method @Middleware      →  позже
```

**Auth (`authorize`) выполняется после controller middleware и до method middleware.**
Если controller middleware должен видеть уже аутентифицированного пользователя —
вешайте его **ниже** auth: на метод или через отдельный composer, не на класс
**выше** `@Authorize` в pipeline… На практике `@Authorize` в [6], class `@Middleware` в [5] —
**до** auth. Для проверок, требующих `ICurrentUser`, используйте method-level
`@Middleware` или policy.

### Short-circuit и CORS

`cors()` middleware добавляет headers **после** `next()`, когда `ctx.response` уже есть.
При short-circuit без `next()` CORS headers не добавятся — задайте headers вручную
или вызывайте `next()` до установки response (или используйте глобальный `cors`).

### Ошибки в middleware

| Источник ошибки | Кто обрабатывает |
| --- | --- |
| throw `HttpError` в middleware | `errorHandler` → JSON + status |
| throw `Error` в middleware | `errorHandler` → 500 |
| throw в action | `@Catch` на контроллере, затем `errorHandler` |

`@Catch` **не** перехватывает ошибки из middleware [5]–[7] — только из terminal [8].

### Парсинг body

`ctx.json()` кэшируется. Первый вызов (middleware или binding) парсит body;
повторные вызовы — тот же promise. Битый JSON → `BadRequestError` (400).

### Состояние в closure

```ts
const buckets = new Map(); // в rateLimit — OK для singleton factory

@Middleware(createOnce()) // createOnce() вызывается при загрузке модуля — OK
```

Не создавайте **новую** middleware-функцию на каждый запрос — только на load/startup.

---

## 11. Интеграция с auth и cache

### Auth (`@/auth`)

| Компонент | Тип подключения | Pipeline |
| --- | --- | --- |
| `jwtBearer()` | `httpModule({ middleware })` | [4] — authentication |
| `authorize()` / `requireAuthenticated()` | `routeMiddlewareComposer` | [6] — authorization |

`@Authorize` / `@AllowAnonymous` **не** используют `@Middleware` — отдельный
metadata-слой и composer. Не смешивайте ручной `jwtBearer` на action с
глобальным — достаточно одного в `serverMiddleware`.

Подробности: `@/auth` SPEC §2, §7, §8.

### Cache (`@/core/cache`)

`@OutputCache` / `@OutputRedisCache` → middleware через
`cache.httpIntegration.routeMiddlewareComposer` ([6]).

Рекомендуемый порядок composer'ов:

```ts
composeRouteMiddlewareComposers(
  jwt.httpIntegration.routeMiddlewareComposer,   // authorize first
  cache.httpIntegration.routeMiddlewareComposer, // then cache
)
```

Output cache должен стоять **после** auth, чтобы не отдавать чужой кэш
(см. `varyByUser` в cache SPEC §17).

---

## 12. Middleware vs ActionFilter vs `@Catch`

| Механизм | Когда выполняется | Доступ к args action | Типичное использование |
| --- | --- | --- | --- |
| **Middleware** | до terminal | нет (только `ctx.params`) | auth adjacency, rate limit, CORS, cache |
| **`@ActionFilter`** | в terminal, после bind | да (`before` без args, result в `after`) | обёртка результата, audit после bind |
| **`@Catch`** | при throw из action | error + ctx | доменные 404/409 |

```ts
@ActionFilter({
  before: (ctx) => { /* ctx уже с bound state, но args ещё не в filter API */ },
  after: (ctx, result) => ({ ...result, meta: { version: "1" } }),
})
```

Для «не пускать на endpoint» — **middleware**, не filter.

---

## 13. Хорошие и плохие практики

### Хорошие практики

| Практика | Почему |
| --- | --- |
| JWT / roles через `@Authorize`, не custom middleware | единая модель auth, compile-time composer |
| Глобальные cross-cutting (metrics, request id) в `httpModule({ middleware })` | один раз, все маршруты |
| Per-route limits через `@Middleware` на controller/action | явная область |
| `throw new UnauthorizedError()` / `ForbiddenError` | корректные статусы через errorHandler |
| `ctx.services.resolve()` для DI | scoped сервисы, тестируемость |
| `ctx.state` для данных между middleware | без глобальных переменных |
| Фабрики `rateLimit({ ... })`, `cors({ ... })` | переиспользуемые конфиги |
| Ownership / API key через method-level `@Middleware` | узкая область |

### Плохие практики

| Анти-паттерн | Проблема | Вместо |
| --- | --- | --- |
| Дублировать JWT-парсинг в своём middleware | расхождение с `ICurrentUser` | `jwtBearer()` + `@Authorize` |
| Тяжёлая бизнес-логика в middleware | сложно тестировать | service + policy или action |
| `@Middleware` на классе для проверки, нужной одному action | лишние DB round-trip | method-level |
| `await ctx.json()` в middleware «на всякий случай» | лишний parse больших body | `@Consumes` + binding |
| Mutable global state без синхронизации | гонки в cluster | Redis / external store |
| Ловить ошибки в middleware без rethrow | проглатывание багов | throw или `HttpError` |
| Вешать `errorHandler` через `@Middleware` | второй boundary, путаница | только built-in [3] |
| Output cache до auth | утечка данных между пользователями | порядок composer'ов + `varyByUser` |
| Логировать secrets / body с паролями | утечка PII | redaction, sampling |

### Guard-like классы (если нужен NestJS-стиль)

Osnova **не** имеет `@UseGuards(GuardClass)`. Паттерн-замена:

```ts
interface CanActivate {
  canActivate(ctx: HttpContext): boolean | Promise<boolean>;
}

function useGuard(GuardClass: Class<CanActivate>): HttpMiddleware {
  return async (ctx, next) => {
    const guard = ctx.services.resolve(GuardClass);
    if (!(await guard.canActivate(ctx))) {
      throw new ForbiddenError();
    }
    await next();
  };
}

@Patch(":id(int)")
@Middleware(useGuard(PostOwnerGuard))
update(id: number) { /* … */ }
```

Guard-класс регистрируется в DI как обычный `scoped`/`singleton` provider.

---

## 14. Ограничения и анти-паттерны

| Ограничение | Детали |
| --- | --- |
| Нет `@Inject` в middleware | только `ctx.services.resolve(token)` |
| Middleware не async-фабрика DI | функция захватывается при сборке route |
| `rateLimit` — in-memory | не shared между процессами |
| Preflight без глобального `cors` | per-route `cors()` не регистрирует OPTIONS handler |
| Несколько `@Controller` на классе | не поддерживается — один controller class |
| Parameter decorators | источники аргументов выводит codegen по сигнатуре |
| Middleware на abstract/private methods | route decorators только public instance methods |

---

## 15. FAQ

**Чем `@Middleware` отличается от `httpModule({ middleware })`?**

Область: глобально vs controller/action. Оба используют один тип `HttpMiddleware`.

**Можно ли вернуть результат из middleware без action?**

Да: установите `ctx.response` и не вызывайте `next()`.

**Выполняется ли middleware для 404?**

Нет. 404/405 отвечаются до `runPipeline`.

**Сколько раз создаётся цепочка?**

Один раз при `HttpServer.start()` на каждый зарегистрированный маршрут.

**Работает ли с `bun build --compile`?**

Да. Metadata через TC39 decorators, без `reflect-metadata`.

**Нужен ли `@Middleware` для auth?**

Нет. Используйте `@Authorize` + `jwtModule().httpIntegration`.

**`@Middleware` vs `RouteOptions.middleware` — что выбрать?**

Эквивалентны для action. `@Middleware` читается при нескольких декораторах;
inline удобен, когда опции маршрута уже в одном объекте `{ code: 201, middleware: [...] }`.

---

## 16. Карта папки

| Файл | Назначение |
| --- | --- |
| `Decorators/attributes.ts` | `@Middleware`, `@ActionFilter`, … |
| `Decorators/routes.ts` | `RouteOptions.middleware` |
| `Decorators/metadata.ts` | `ControllerMeta.middleware`, `ActionMeta.middleware` |
| `Middleware/types.ts` | `HttpMiddleware`, `ActionFilterHooks` |
| `Middleware/pipeline.ts` | `runPipeline` |
| `Middleware/errorHandler.ts` | глобальная граница ошибок |
| `Middleware/cors.ts` | CORS + preflight helpers |
| `Middleware/rateLimit.ts` | in-memory rate limiter |
| `@/logging/http/accessLogMiddleware` | access log (via logging module) |
| `Routing/RouterBuilder.ts` | сборка chain на старте |
| `HttpServer.ts` | `serverChain` + dispatch |
| `options.ts` | `HttpModuleOptions.middleware`, `RouteMiddlewareComposer` |
| `composeRouteMiddlewareComposers.ts` | объединение composer'ов модулей |
| `test/http.e2e.test.ts` | порядок middleware, inline, global |

Связанные спецификации: `@/auth` SPEC (§2, §7, §8), `@/core/cache` SPEC (§15).
