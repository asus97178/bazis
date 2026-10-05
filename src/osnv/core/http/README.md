# src/osnv/core/http: HTTP module (in the spirit of ASP.NET Core)

Controllers are classes with standard TC39 decorators; routes are compiled into a
radix tree at startup; each request lives in its own DI scope.
No external dependencies, no reflection, compatible with `bun build --compile`
(checked by the shared `bun run build:bin`).

The full specification of middleware and `@Middleware`: [SPEC.md](./SPEC.md).

## Quick start

First create an application by the [guide](../../../../docs/QUICKSTART.md), then
the module `bunx osnv g module Echo --empty`. To try it without a database, replace
the content of the generated `Echo.module.ts` with this code and fill in its `MODULE.md`:

```ts
import { Module } from "osnv/core/di";
import { Controller, Get, Post, RequestModel } from "osnv/core/http";
import { Validator } from "osnv/library/validation";

@RequestModel()
export class EchoRequest {
  @Validator({ required: true, type: "string", minLength: 3, maxLength: 100 })
  text!: string;
}

@Controller("echo")
export class EchoController {
  @Get(":id(int)")
  getById(id: number) { return { id }; }

  @Post()
  send(body: EchoRequest) { return { text: body.text }; }
}

@Module({ controllers: [EchoController], exports: [] })
export class EchoModule {}
```

`bun run dev` runs codegen before the application. GET `/echo/42` returns
`{"id":42}`; POST `/echo` with `{"text":"hello"}` returns `{"text":"hello"}`.
An invalid body gets HTTP 400. If the host sets a prefix, add it to the path.
Parameter bindings are inferred from the signature before the run; TypeScript is
not analyzed on each request. For service dependencies a constructor and
`scoped(IService, Service)` are enough: the same codegen infers the usual `deps`.

## Binding conventions (instead of parameter decorators)

**Parameter** decorators (`getUser(@Param("id") id)`) do not exist in the TC39
standard, and `experimentalDecorators` would break the other framework modules.
Instead there are ASP.NET-style conventions that codegen infers from the signature:

| Method parameter | Binding |
|---|---|
| the name matches the route `:name` | the route value (converted by the constraint/type) |
| a DTO class from the application sources | the request body + `@Validator` validation (errors -> 400) |
| `HttpContext` / `Request` / `ResponseBuilder` | context / raw request / response builder |
| a primitive (`string`/`number`/`boolean` or inferred from the default) | a query parameter; `?` and a default -> optional |

If no convention can be inferred (for example a union of string literals, no
annotation or two body classes), `di:generate` fails with
`OSNV_HTTP_BINDING_UNRESOLVED`, the method name and the reason. The previous
generated files are not replaced. Use a supported type; for headers and raw
bodies take `ctx: HttpContext`, and inject services into the constructor.
Checking allowed values belongs to the Validator or the service.

A `ctx: HttpContext` parameter stays a regular supported input. For older manual
HTTP assembly without generated metadata there is a runtime fallback with one
HttpContext; it does not replace codegen for typed actions.

### Nested request DTOs

`di:generate` also reads the field types of a request model and registers the shape
for recursive hydration without `reflect-metadata`. So the usual DX works for
objects and arrays too:

```ts
export class AddressRequest {
  @Validator({ required: true })
  city!: string;
}

export class CreateUserRequest {
  @Validator({ required: true, nested: true })
  address!: AddressRequest;

  @Validator({ nested: true })
  previousAddresses!: AddressRequest[];
}
```

Both classes must be named top-level exports. The binder creates real instances
of nested DTOs, removes unknown and prototype-polluting fields at every level,
then runs validation with paths like `address.city` and
`previousAddresses[0].city`. An ambiguous type with `nested: true` (for example a
union of two classes) stops codegen; with missing or stale generated metadata the
standard validator rejects a plain object fail-closed.

A request body field declared exactly as `string`, `number` or `boolean`
(also `| null`, optional or an array of such values) is checked against the
JSON type without `@Validator`: `{"done":"yes"}` for `done?: boolean` gives 400
with the code `type`. Codegen takes the type from the sources; literal unions, enums,
`Date` and mixed unions are not checked; they need `@Validator`.
Required-ness is still set with `required: true`. The check applies only at the
HTTP boundary: gRPC and Agent use the same binder without it.

Open JSON fields (`Record<string, unknown>`, `{}`, `unknown[]`) keep regular user
keys, but the binder clones them recursively and removes `__proto__`,
`constructor`, `prototype` at any depth. Cycles, nesting deeper than 64 containers
and overly complex graphs are rejected with 400 before reaching the action.

## Folder map

| Folder/file | Purpose |
|---|---|
| `Decorators/` | `@Controller`, `@Get`/`@Post`/... (+ inline options `{ code, produces, consumes, version, middleware }`), `@HttpCode`, `@Produces`, `@Consumes`, `@Middleware`, `@ApiVersion`, `@Catch`, `@ActionFilter`; metadata stored through `Symbol.metadata` |
| `Routing/` | template parser (`:id(int)`, `:u(uuid)`, `*rest`), a radix tree with backtracking, pipeline assembly at startup |
| `Binding/` | binding descriptors, type conversion (400 on error), model binding with prototype pollution protection and `@Validator` validation |
| `Results/` | `Ok`, `Created`, `NotFound`, `Redirect`, `File` (through `Bun.file`) and result normalization with an automatic Content-Type |
| `Middleware/` | the pipeline, `cors` (+ preflight), `errorHandler`, `rateLimit`; the access log is `@/logging/http` |
| `Versioning/` | reads the API version from a URL segment, a query parameter or a header |
| `HttpContext/` | the request context (params, DI scope, body cache) and `ResponseBuilder` |
| `Errors/` | `HttpError` and subclasses (4xx/5xx), `ModelValidationError`, `HttpSetupError` |
| `HttpServer.ts` | hosted service: `Bun.serve`, a scope per request, 404/405/preflight without the pipeline |
| `httpModule.ts` | the `OsnvModule` factory: scoped controllers + the server |

## Guarantees

- **Performance**: all metadata is processed at startup; per request there is a
  radix lookup O(segments), a compiled pipeline and a DI scope; the body is parsed
  once (cached in the context).
- **Resilience**: a global error boundary is always installed
  (`HttpError` -> status, anything else -> 500 without details in production);
  `@Catch` on a controller for domain errors; broken JSON/conversions -> 400, not 500.
- **Security**: prototype pollution is filtered in model binding and in route
  parameter names; `..`/`%zz` in the path -> 400; CORS with preflight; auth hooks
  in as regular middleware (`@Middleware` or global); `rateLimit` is one line.
- **Configuration errors** (a duplicate route, an unknown constraint, a class
  without `@Controller`) are `HttpSetupError` at startup, not at runtime.
