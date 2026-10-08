# HTTP middleware and `@Middleware`: specification

A per-request middleware pipeline in the style of ASP.NET Core / Koa: `(ctx, next)`
functions compiled **once per route** when the server starts. The `@Middleware`
decorator is the declarative way to attach middleware to a controller or an action.

Quick navigation:
- [1. What it is and why](#1-what-it-is-and-why)
- [2. Pipeline architecture](#2-pipeline-architecture)
- [3. Quick start](#3-quick-start)
- [4. `@Middleware` reference](#4-middleware-reference)
- [5. The `HttpMiddleware` contract](#5-the-httpmiddleware-contract)
- [6. Ways to connect middleware](#6-ways-to-connect-middleware)
- [7. Built-in middleware](#7-built-in-middleware)
- [8. `HttpContext` in middleware](#8-httpcontext-in-middleware)
- [9. Scenarios and examples](#9-scenarios-and-examples)
- [10. Execution order and details](#10-execution-order-and-details)
- [11. Authorization and output cache](#11-authorization-and-output-cache)
- [12. Middleware vs ActionFilter vs `@Catch`](#12-middleware-vs-actionfilter-vs-catch)
- [13. Good and bad practices](#13-good-and-bad-practices)
- [14. Limits](#14-limits)
- [15. FAQ](#15-faq)
- [16. Folder map](#16-folder-map)

---

## 1. What it is and why

**Middleware** is a function that runs **before** (and/or **after**) a controller action
within one HTTP request. Typical tasks:

| Task | Example |
| --- | --- |
| Authorization | `@Authorize(check)` compiles into a built-in middleware (see §11) |
| Response cache | `@OutputCache` compiles into a route middleware of the cache module |
| CORS | `httpModule({ cors: { origin: "..." } })` or `cors({ ... })` |
| Rate limiting | `rateLimit({ windowMs, max })` |
| Correlation / tracing | `createCorrelationIdMiddleware()` with the `x-request-id` header |
| API key check | a middleware before the action, without body binding |

**`@Middleware`** is a TC39 decorator that writes one or more middleware functions into
the metadata of a controller or a method. At startup `RouterBuilder` builds a **ready
array** from the metadata; the hot path never reads metadata.

Why a decorator and not only `httpModule({ middleware })`:

| Criterion | Global middleware | `@Middleware` |
| --- | --- | --- |
| Scope | all routes | one controller / one action |
| Declarativeness | module configuration | next to `@Get` / `@Post` |
| Reuse | one function for the whole application | different chains per controller |
| Build time | an array in `httpModule` | metadata → pipeline at startup |

Import:

```ts
import {
  Middleware,
  type HttpMiddleware,
  rateLimit,
  cors,
  HttpContext,
  UnauthorizedError,
} from "bazis/core/http";
```

---

## 2. Pipeline architecture

### The full chain of one route

```
HTTP Request
    │
    ▼
[1] accessLog?                ← httpModule({ accessLog })
[2] cors?                     ← httpModule({ cors })
[3] securityHeaders           ← on by default; httpModule({ securityHeaders: false }) turns it off
[4] errorHandler              ← always (the global error boundary)
[5] server middleware         ← httpModule({ middleware }) + DI SERVER_MIDDLEWARE, by order
[6] authorization             ← @Authorize / @AllowAnonymous (built-in, compiled per route)
[7] @Middleware (class)       ← decorator on the controller
[8] @Middleware (method)      ← decorator or RouteOptions.middleware
[9] action boundary           ← binding + ActionFilter.before
[10] route composers          ← httpModule({ routeMiddlewareComposer }) + DI ROUTE_MIDDLEWARE_COMPOSER (e.g. output cache)
[11] terminal                 ← action + ActionFilter.after; @Catch handles errors of [9]–[11]
    │
    ▼
HTTP Response
```

Assembly in `RouterBuilder`:

```ts
const chain = [
  ...serverChain,       // [1]–[5]
  ...authorization,     // [6]
  ...meta.middleware,   // [7]
  ...action.middleware, // [8]
  pipeline.boundary,    // [9]
  ...composed,          // [10]
  pipeline.terminal,    // [11]
];
```

Authorization comes before controller middleware, so an unauthorized request cannot
trigger controller-level work. The output cache runs after the action boundary, so a
cache hit still passes authorization, binding and `ActionFilter.before`, but skips the
controller and the action.

### What does **not** go through the pipeline

| Situation | Behavior |
| --- | --- |
| CORS preflight (`OPTIONS` + `Access-Control-Request-Method`) | answered before routing |
| 404 Not Found | JSON without the pipeline |
| 405 Method Not Allowed | JSON without the pipeline |
| Malformed path (`..`, `%zz`) | 400 without the pipeline |

### Lifetime and DI

Each request creates a **new DI scope** (`ctx.services`). Middleware and the action share
one scope for the request; the scope is disposed after the response.

---

## 3. Quick start

### Middleware on a controller

```ts
import { Controller, Get, Middleware, type HttpMiddleware } from "bazis/core/http";

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

### Middleware on one action

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

### Globally through `httpModule`

```ts
import { createCorrelationIdMiddleware, httpModule, rateLimit } from "bazis/core/http";

httpModule({
  imports: [FeatureModule],
  accessLog: true,
  middleware: [
    createCorrelationIdMiddleware(),
    rateLimit({ windowMs: 60_000, max: 600 }),
  ],
});
```

---

## 4. `@Middleware` reference

### Signature

```ts
function Middleware(...middleware: HttpMiddleware[]): ClassOrMethodDecorator;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `...middleware` | `HttpMiddleware[]` | yes (≥1) | One or more functions in execution order |

**`@Middleware` has no options object**, only a variadic list of functions.
Settings go through the factory closure (`rateLimit({ max: 100 })`).

### Where it can be used

| Place | Scope | Metadata |
| --- | --- | --- |
| A controller class | all actions of the controller | `ControllerMeta.middleware` |
| A method with `@Get`/`@Post`/… | only this action | `ActionMeta.middleware` |

### Accumulation

Several decorators **add** middleware to the array (they do not overwrite it):

```ts
@Controller("api")
@Middleware(mwA)
@Middleware(mwB)
class ApiController {}
// order on the route: mwA → mwB → …
```

### Inheritance (copy-on-write)

Controller metadata is inherited from the base class through TC39 `Symbol.metadata`.
The first write in a subclass **clones** it, so the base class is not mutated.

```ts
@Controller("base")
@Middleware(sharedMiddleware)
class BaseController {}

@Controller("derived")
class DerivedController extends BaseController {}
// DerivedController inherits sharedMiddleware
```

Routes are inherited too, which is how a new API version is built on the old one:

```ts
@Controller("notes") @ApiVersion("2")
class NotesV2Controller extends NotesV1Controller {
  @Get(":noteId") override getById(noteId: string) { ... } // replaces GET :id of v1
  override text(id: string) { ... }                         // keeps the v1 route
}
```

- A method the subclass does not override keeps its routes, served by the base implementation.
- An override without route decorators keeps the base method's routes; its own parameters are bound.
- Route decorators on an override replace the base method's routes (since 0.98.5; before, they
  were added to them, and startup failed with a duplicate route). Other settings of the base
  method — status code, middleware, version — stay inherited.

Codegen follows the `extends` chain, so inherited actions get argument bindings for the subclass
(since 0.98.5; before, a subclass without own route decorators got none, and an override received
`HttpContext` in place of its parameters).

### The equivalent through inline route options

`RouteOptions.middleware` on `@Get`/`@Post` writes into the same `ActionMeta.middleware`:

```ts
@Get("export", { middleware: [exportOnlyMiddleware] })
export() { ... }

// equivalent:
@Get("export")
@Middleware(exportOnlyMiddleware)
export() { ... }
```

With several route decorators on one method the `middleware` field **accumulates**
(like push), while scalar fields (`code`, `produces`) are overwritten.

---

## 5. The `HttpMiddleware` contract

```ts
type HttpMiddleware = (
  ctx: HttpContext,
  next: () => Promise<void>,
) => void | Promise<void>;
```

### Rules

| Rule | Description |
| --- | --- |
| Calling `next()` | passes control to the next link of the chain |
| No `next()` | **short-circuit**: the pipeline stops; set `ctx.response` |
| A second `next()` | **an error**: `next() called multiple times` |
| An exception | caught by `errorHandler` (middleware runs inside it) |
| Sync / async | both are allowed |

### Short-circuit (a response without the action)

```ts
const maintenanceMode: HttpMiddleware = async (ctx, next) => {
  if (process.env.MAINTENANCE === "1") {
    ctx.response = new Response(JSON.stringify({ error: "Maintenance" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    return; // next() is not called
  }
  await next();
};
```

### "Around" middleware (before and after the action)

```ts
const timing: HttpMiddleware = async (ctx, next) => {
  const started = performance.now();
  await next();
  const ms = (performance.now() - started).toFixed(1);
  ctx.response?.headers.set("x-duration-ms", ms);
};
```

### Middleware with DI

```ts
import { IAuditLog } from "./tokens";

const audit: HttpMiddleware = async (ctx, next) => {
  await next();
  const log = ctx.services.resolve(IAuditLog);
  await log.write({ method: ctx.method, path: ctx.path, status: ctx.response?.status });
};
```

> Middleware is a **function**, not a DI class. Dependencies are resolved from
> `ctx.services` inside the function. For reusable guard-like classes see
> [13. Good and bad practices](#13-good-and-bad-practices).

---

## 6. Ways to connect middleware

| # | Way | When | Place in the pipeline |
| --- | --- | --- | --- |
| 1 | `httpModule({ accessLog, cors, securityHeaders })` | built-in cross-cutting concerns | [1]–[3] |
| 2 | `httpModule({ middleware })` | globally for the whole API | [5] |
| 3 | DI `SERVER_MIDDLEWARE` | a module wires its own global middleware | [5] |
| 4 | `@Authorize` / `@AllowAnonymous` | authorization per controller/action | [6] |
| 5 | `@Middleware` on a class | all actions of the controller | [7] |
| 6 | `@Middleware` on a method, `RouteOptions.middleware` | one action | [8] |
| 7 | `routeMiddlewareComposer`, DI `ROUTE_MIDDLEWARE_COMPOSER` | build-time per route (output cache) | [10] |

### `HttpModuleOptions.middleware`

```ts
interface HttpModuleOptions {
  /** Global middleware after errorHandler, before route middleware. */
  readonly middleware?: readonly HttpMiddleware[];
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `middleware` | `readonly HttpMiddleware[]` | `[]` | Global application middleware (order 0) |

Typical content: correlation id, metrics, custom headers.

### DI `SERVER_MIDDLEWARE`

A module can contribute global middleware without threading it through
`httpModule`. Registrations are collected with `resolveAll` and sorted by `order`
(lower runs further out; explicit `httpModule({ middleware })` has order 0):

```ts
import { singletonValue } from "bazis/core/di";
import { SERVER_MIDDLEWARE } from "bazis/core/http";

@Module({
  providers: [singletonValue(SERVER_MIDDLEWARE, { order: -10, middleware: httpMetrics })],
})
class MetricsModule {}
```

### `RouteMiddlewareComposer`

```ts
type RouteMiddlewareComposer = (
  controllerClass: Class<object>,
  methodName: string | symbol,
  httpMeta: ControllerMeta,
  action: ActionMeta,
) => readonly HttpMiddleware[];
```

| Field | Type | Description |
| --- | --- | --- |
| return | `readonly HttpMiddleware[]` | Middleware for a **specific** action |

It is called **once** per route when `HttpServer` starts. Modules usually self-wire
through the `ROUTE_MIDDLEWARE_COMPOSER` DI token (the cache module does this for
`@OutputCache`). Several explicit composers can be combined:

```ts
import { composeRouteMiddlewareComposers } from "bazis/core/http";

routeMiddlewareComposer: composeRouteMiddlewareComposers(auditComposer, metricsComposer),
```

### `RouteOptions.middleware`

```ts
interface RouteOptions {
  readonly middleware?: readonly HttpMiddleware[];
  // also: code, produces, consumes, version, maxBodyBytes
}
```

| Field | Type | Description |
| --- | --- | --- |
| `middleware` | `readonly HttpMiddleware[]` | Middleware only for actions with this route decorator |

---

## 7. Built-in middleware

Exported from `bazis/core/http`. They are connected through `@Middleware(...)`,
`httpModule({ middleware })` or the built-in module options.

### `errorHandler(options?)`

**Always** in the server chain (position [4]). Configure it through
`httpModule({ errorHandler })`; do not attach it to a route by hand.

| `ErrorHandlerOptions` field | Type | Default | Description |
| --- | --- | --- | --- |
| `exposeDetails` | `boolean` | `httpModule({ exposeErrorDetails })` / environment | redacted message/stack in 500 responses; never enable in production |
| `onUnexpectedError` | `(ctx, error) => void` | DI `HTTP_ERROR_HOOK` hooks | notification for non-`HttpError` failures (e.g. an error tracker); the error is still logged |
| `logError` | `(error) => void` | — | replaces the built-in logging of unexpected errors |
| `logger` | `Logger` | the application `LOGGER` | one `error` line: `"<METHOD> <path> failed"` with `method`, `path`, `requestId` and the redacted `error`; `console.error` when there is no logger |

`HttpError` → JSON with its status; anything else → 500.

### `accessLog(options?)`

Enabled with `httpModule({ accessLog: true })` or `httpModule({ accessLog: { ... } })`
at position [1]. With a `LOGGER` in DI it writes structured entries, otherwise one
line per request: `[http] GET /api/users 200 12.3ms <request-id>`.

| `AccessLogOptions` field | Type | Default | Description |
| --- | --- | --- | --- |
| `log` | `(entry: AccessLogEntry) => void` | — | Sink for entries (highest precedence) |
| `logger` | `Logger` | the `LOGGER` from DI | Structured sink: `logger.info` per request |
| `skip` | `(ctx) => boolean` | — | Return `true` to skip a request (e.g. noisy probes) |

### `createCorrelationIdMiddleware(options?)`

Reads `x-request-id` or generates a UUID, stores it in `ctx.state`, echoes it on the
response and binds it to async local storage for application logs. The keys
`REQUEST_ID_HEADER` and `REQUEST_ID_STATE_KEY` are exported from `bazis/core/kernel`.

### `cors(options?)`

Globally: `httpModule({ cors: { origin: "..." } })` handles **both** preflight **and**
response headers.

Per route: `@Middleware(cors({ origin: "https://admin.example.com" }))` adds only the
response headers (preflight is still handled globally if `cors` is set in `httpModule`).

| `CorsOptions` field | Type | Default | Description |
| --- | --- | --- | --- |
| `origin` | `string \| string[] \| (origin) => boolean \| "*"` | `"*"` | allowed origins |
| `methods` | `readonly string[]` | common verbs | for preflight |
| `allowedHeaders` | `readonly string[]` | echo the request | for preflight |
| `exposedHeaders` | `readonly string[]` | — | `Access-Control-Expose-Headers` |
| `credentials` | `boolean` | `false` | cookies; needs an explicit origin allow list or predicate |
| `maxAgeSeconds` | `number` | — | preflight cache |

`credentials: true` cannot be combined with an omitted origin, `"*"` or `["*"]`: the
server fails at startup so it never opens credentialed allow-any-origin.

### `rateLimit(options)`

| `RateLimitOptions` field | Type | Default | Description |
| --- | --- | --- | --- |
| `windowMs` | `number` | — | window size (ms) |
| `max` | `number` | — | max requests per key per window |
| `keyOf` | `(ctx) => string` | the direct peer IP, else one shared bucket | the bucket key |
| `trustProxy` | `boolean` | `false` | trust the first forwarded hop |
| `proxyHeader` | `string` | `x-forwarded-for` | the forwarded address header, only with `trustProxy` |
| `maxBuckets` | `number` | `10000` | hard cap of in-process buckets; new keys get 429 when full |

Exceeding the limit → `TooManyRequestsError` (429 + `Retry-After`).

> In-memory, per process. For a cluster write your own middleware on shared storage,
> or key by user id after authorization.

---

## 8. `HttpContext` in middleware

| API | Description |
| --- | --- |
| `ctx.request` | the native Bun `Request` |
| `ctx.url` | the parsed URL (query: `ctx.url.searchParams`) |
| `ctx.params` | route params after conversion (`:id(int)` → `number`) |
| `ctx.method`, `ctx.path` | shortcuts |
| `ctx.header(name)` | a header (case-insensitive) |
| `ctx.query(name)` | a query parameter |
| `ctx.services` | the request-scoped DI (`resolve`, `tryResolve`) |
| `ctx.state` | `Map<string, unknown>`: data shared between middleware |
| `ctx.response` | the final `Response` (read/write) |
| `ctx.res` | the `ResponseBuilder` for status and headers of a plain result |
| `ctx.json()` | the JSON body (cached per request) |
| `ctx.text()`, `ctx.formData()` | alternative bodies |
| `ctx.apiVersion` | the API version when versioning is on |
| `ctx.clientIp` | the direct peer IP, when available |

### Passing data between middleware

```ts
// middleware A
ctx.state.set("tenantId", tenantId);

// middleware B or the action
const tenantId = ctx.state.get("tenantId");
```

An authorization check may store the request subject under `PRINCIPAL_STATE_KEY`
(a `RequestPrincipal` with `subject` and an optional `claim(type)`); the output cache
uses it for `varyByUser`/`varyByClaim`.

---

## 9. Scenarios and examples

### 9.1. Request ID on all routes (globally)

```ts
import { createCorrelationIdMiddleware, httpModule } from "bazis/core/http";

httpModule({
  accessLog: true,
  middleware: [createCorrelationIdMiddleware()],
});
```

Application logs in the same request get the `requestId` through
`AsyncLocalStorage` (`runWithRequestContext` in `bazis/core/kernel`).

### 9.2. Rate limit only on public endpoints

```ts
import { AllowAnonymous, Authorize, Controller, Get, Middleware, rateLimit } from "bazis/core/http";

const publicLimiter = rateLimit({ windowMs: 60_000, max: 30 });

@Controller("search")
@AllowAnonymous()
@Middleware(publicLimiter)
class SearchController {
  @Get()
  search(q: string) { /* … */ }
}

@Controller("admin")
@Authorize(isAdmin)
class AdminController {
  // publicLimiter does not apply
}
```

### 9.3. API key on a webhook (one action)

```ts
import { UnauthorizedError } from "bazis/core/http";

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

### 9.4. Content-Type check before binding

```ts
import { UnsupportedMediaTypeError } from "bazis/core/http";

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

> `@Consumes` checks Content-Type **at binding** ([9]). A middleware rejects earlier,
> before the body is parsed, which helps with large uploads.

### 9.5. CORS only for the admin controller

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

Browser preflight still needs the global `httpModule({ cors })` or separate OPTIONS handling.

### 9.6. Tenant from the subdomain

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

### 9.7. Logging the body (careful: PII)

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

### 9.8. Several middleware in one decorator

```ts
@Post("submit")
@Middleware(verifyCsrf, rateLimit({ windowMs: 60_000, max: 5 }))
submit(dto: SubmitDto) { /* … */ }
```

### 9.9. Inline options + a decorator on one method

```ts
@Get("report", { middleware: [cacheBustHeaders] })
@Middleware(requireReportAccess)
report() { /* … */ }
```

Both go into `ActionMeta.middleware` [8]. If the order matters, combine them in one
decorator: `@Middleware(cacheBustHeaders, requireReportAccess)`.

### 9.10. Middleware + `@Authorize` + `@OutputCache`

```ts
import { Authorize, Controller, Get, Middleware, rateLimit } from "bazis/core/http";
import { OutputCache } from "bazis/core/cache";

@Controller("catalog")
@Authorize(isSignedIn)
@Middleware(rateLimit({ windowMs: 60_000, max: 120 }))
class CatalogController {
  @Get()
  @OutputCache({ seconds: 60, varyByUser: true })
  list() {
    return this.service.list();
  }
}
```

The pipeline for `list`:

```
authorize → rateLimit → binding/ActionFilter.before → outputCache → action
```

(authorization is built in [6], rate limit is a class `@Middleware` [7], the output
cache is a route composer [10])

### 9.11. Ownership check (guard-like, without a separate `@Guard`)

```ts
import { ForbiddenError, PRINCIPAL_STATE_KEY, type RequestPrincipal } from "bazis/core/http";

function postOwnerGuard(): HttpMiddleware {
  return async (ctx, next) => {
    const store = ctx.services.resolve(IPostStore);
    const id = ctx.params.id as number;
    const principal = ctx.state.get(PRINCIPAL_STATE_KEY) as RequestPrincipal | undefined;
    const post = await store.byId(id);
    if (!post || post.authorId !== principal?.subject) {
      throw new ForbiddenError("Not your post");
    }
    await next();
  };
}

@Controller("posts")
@Authorize(isSignedIn)
class PostsController {
  @Patch(":id(int)")
  @Middleware(postOwnerGuard())
  update(id: number, dto: UpdatePostDto) { /* … */ }
}
```

For "who may call this at all" prefer `@Authorize` checks; keep middleware for
per-resource rules like ownership.

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

## 10. Execution order and details

### "Inward" and "outward"

Middleware with `await next()` runs the code **before** `next` on the way in and
**after** `next` on the way out (like an onion):

```
global BEFORE → controller BEFORE → action BEFORE
    → action
action AFTER ← controller AFTER ← global AFTER
```

The e2e test records the header order when appending **after** `next()`:

```
GET /api/users/1  →  x-trace: controller, global
```

`controller` is closer to the action (it appends first), `global` is outside.

### Authorization vs class/method middleware vs composers

On one route:

```
[6] authorization            →  first among route links
[7] controller @Middleware
[8] method @Middleware
[9] binding + ActionFilter.before
[10] route composers         →  output cache
```

**Authorization runs before controller and method middleware**, so every `@Middleware`
already sees the principal an `@Authorize` check stored in `ctx.state`. A route with
`@AllowAnonymous` has no authorization link.

### Short-circuit and CORS

The `cors()` middleware adds headers **after** `next()`, when `ctx.response` exists.
On a short-circuit without `next()` the per-route CORS headers are not added: set the
headers by hand, or rely on the global `httpModule({ cors })`, which sits outside.

### Errors in middleware

| Error source | Who handles it |
| --- | --- |
| `HttpError` thrown in middleware | `errorHandler` → JSON + status |
| `Error` thrown in middleware | `errorHandler` → 500 |
| thrown in binding, `ActionFilter` or the action | `@Catch` on the controller, then `errorHandler` |

`@Catch` does **not** catch errors from middleware [5]–[8]; only from [9]–[11].

### Body parsing

`ctx.json()` is cached. The first call (middleware or binding) parses the body; repeated
calls get the same promise. Broken JSON → `BadRequestError` (400).

### State in a closure

```ts
const buckets = new Map(); // inside rateLimit: fine for a factory called once

@Middleware(createOnce()) // createOnce() runs when the module loads: fine
```

Do not create a **new** middleware function per request, only at load/startup.

---

## 11. Authorization and output cache

### Authorization (`@Authorize`)

`@Authorize(check, ...checks)` on a controller or a method compiles into the built-in
authorization link [6]. A check is `(ctx) => boolean | Promise<boolean>`: `true` lets the
request through, `false` gives `403`, and a thrown `HttpError` defines the response
itself (for example `UnauthorizedError` → `401`). Checks of the controller and of the
method combine: the controller's run first, then the method's; a check repeated on both
runs once. A method-level `@AllowAnonymous` removes every check, including the
controller's. On an `@AllowAnonymous` controller only methods with their own
`@Authorize` are protected. Inheritance replaces instead: a subclass's own class-level
declaration replaces the base class's (since 0.97.0; before it a method-level
`@Authorize` replaced the controller's checks).

```ts
const isSignedIn: AuthorizeCheck = (ctx) => {
  const token = ctx.header("authorization");
  if (!token) throw new UnauthorizedError();
  const principal = ctx.services.resolve(ITokenReader).read(token); // your service
  ctx.state.set(PRINCIPAL_STATE_KEY, principal);
  return true;
};
```

The kernel does not know what a check verifies (JWT, a session, an API key): that stays
inside the function. `@Authorize` does not use `@Middleware`; it has its own metadata layer.

### Output cache (`bazis/core/cache`)

`@OutputCache` / `@OutputRedisCache` turn into a route middleware through the cache
module's `ROUTE_MIDDLEWARE_COMPOSER` registration ([10]). Connecting the cache module
(`memory()` or `buildCacheModule(...)`) is enough; no manual composer wiring is needed.

The output cache runs **after** authorization and the action boundary, so a cached
response is never served to a caller who fails `@Authorize`. For per-user data use
`varyByUser`/`varyByClaim` (see the [cache SPEC](../cache/SPEC.md)).

---

## 12. Middleware vs ActionFilter vs `@Catch`

| Mechanism | When it runs | Access to action args | Typical use |
| --- | --- | --- | --- |
| **Middleware** | before the action boundary | no (only `ctx.params`) | rate limit, CORS, tenant, ownership |
| **`@ActionFilter`** | `before` after binding, `after` around the result | `before` without args, the result in `after` | wrapping the result, audit after binding |
| **`@Catch`** | on a throw from binding/filters/the action | error + ctx | domain 404/409 |

```ts
@ActionFilter({
  before: (ctx) => { /* runs after binding; args are not in the filter API */ },
  after: (ctx, result) => ({ ...result, meta: { version: "1" } }),
})
```

To "not let the request reach the endpoint", use **middleware** or `@Authorize`, not a filter.

---

## 13. Good and bad practices

### Good practices

| Practice | Why |
| --- | --- |
| Access rules through `@Authorize` checks, not custom middleware | one authorization model, compiled per route |
| Global cross-cutting concerns (metrics, request id) in `httpModule({ middleware })` | once, all routes |
| Per-route limits through `@Middleware` on a controller/action | an explicit scope |
| `throw new UnauthorizedError()` / `ForbiddenError` | correct statuses through errorHandler |
| `ctx.services.resolve()` for DI | scoped services, testability |
| `ctx.state` for data between middleware | no global variables |
| The `rateLimit({ ... })`, `cors({ ... })` factories | reusable configurations |
| Ownership / API key through method-level `@Middleware` | a narrow scope |

### Bad practices

| Anti-pattern | Problem | Instead |
| --- | --- | --- |
| Re-checking access in every middleware | duplicated, divergent rules | one `@Authorize` check |
| Heavy business logic in middleware | hard to test | a service or the action |
| A class `@Middleware` for a check one action needs | extra database round trips | method level |
| `await ctx.json()` in middleware "just in case" | an extra parse of large bodies | `@Consumes` + binding |
| Mutable global state without synchronization | races in a cluster | shared external storage |
| Catching errors in middleware without rethrowing | swallowed bugs | throw or `HttpError` |
| Attaching `errorHandler` through `@Middleware` | a second boundary, confusion | only the built-in [4] |
| Caching per-user data without `varyByUser` | data leaks between users | `varyByUser` / `varyByClaim` |
| Logging secrets / bodies with passwords | a PII leak | redaction, sampling |

### Guard-like classes (if you want the NestJS style)

bazis has **no** `@UseGuards(GuardClass)`. The replacement pattern:

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

The guard class is registered in DI as a regular `scoped`/`singleton` provider.

---

## 14. Limits

| Limit | Details |
| --- | --- |
| No `@Inject` in middleware | only `ctx.services.resolve(token)` |
| Middleware is not an async DI factory | the function is captured when the route is built |
| `rateLimit` is in-memory | not shared between processes |
| Preflight without the global `cors` | a per-route `cors()` registers no OPTIONS handler |
| Several `@Controller` on a class | not supported: one controller class |
| Parameter decorators | codegen infers argument sources from the signature |
| Middleware on abstract/private methods | route decorators apply only to public instance methods |

---

## 15. FAQ

**How does `@Middleware` differ from `httpModule({ middleware })`?**

The scope: global vs controller/action. Both use the same `HttpMiddleware` type.

**Can middleware return a result without the action?**

Yes: set `ctx.response` and do not call `next()`.

**Does middleware run for a 404?**

No. 404/405 are answered before the pipeline runs.

**How many times is the chain created?**

Once per registered route when `HttpServer` starts.

**Does it work with `bun build --compile`?**

Yes. Metadata goes through TC39 decorators, without `reflect-metadata`.

**Do I need `@Middleware` for authorization?**

No. Use `@Authorize(check)`; it is compiled into the route automatically.

**`@Middleware` vs `RouteOptions.middleware`: which one?**

They are equivalent for an action. `@Middleware` reads well with several decorators;
inline is handy when the route options are already one object `{ code: 201, middleware: [...] }`.

---

## 16. Folder map

| File | Purpose |
| --- | --- |
| `Decorators/attributes.ts` | `@Middleware`, `@ActionFilter`, … |
| `Decorators/routes.ts` | `RouteOptions.middleware` |
| `Decorators/metadata.ts` | `ControllerMeta.middleware`, `ActionMeta.middleware` |
| `Authorization/` | `@Authorize`, `@AllowAnonymous` and the built-in authorization composer |
| `Middleware/types.ts` | `HttpMiddleware`, `ActionFilterHooks` |
| `Middleware/pipeline.ts` | `runPipeline` |
| `Middleware/errorHandler.ts` | the global error boundary |
| `Middleware/accessLog.ts` | the access log |
| `Middleware/securityHeaders.ts` | default security headers |
| `Middleware/cors.ts` | CORS + preflight helpers |
| `Middleware/rateLimit.ts` | the in-memory rate limiter |
| `correlation/` | `createCorrelationIdMiddleware` |
| `middlewareTokens.ts` | `SERVER_MIDDLEWARE`, `ROUTE_MIDDLEWARE_COMPOSER`, `HTTP_ERROR_HOOK` |
| `Routing/RouterBuilder.ts` | builds the chain at startup |
| `HttpServer.ts` | the server chain + dispatch |
| `options.ts` | `HttpModuleOptions`, `RouteMiddlewareComposer` |
| `composeRouteMiddlewareComposers.ts` | combining explicit composers |
| `test/http.e2e.test.ts` | middleware order, inline, global |

Related specifications: [cache SPEC](../cache/SPEC.md).
