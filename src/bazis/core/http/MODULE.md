# HTTP server

Passport version: 2. Date: 2026-09-14. Status: implemented, checks below.
Type: atomic infrastructure module. Path: `src/bazis/core/http`.
Connection point: `httpModule(options)`; public entry: `index.ts`.
Passport scope: negotiated redirects, the affected response lifecycle and the rate limiter fill policy; the other options are described in `options.ts`.

## Responsibility and components

The module accepts HTTP requests and manages routing, middleware and the request scope. Negotiated redirects are an additional response representation in the existing transport; there is no separate module or proxy. The server adds no ORM, UI or outgoing requests here.

After the pipeline `HttpServer` applies the negotiated representation and passes the final response to the scope observer. `HttpContext/inspectableRedirects.ts` converts headers/status without reading the body. The shared wire protocol constants belong to `library/http-client`; the dependency direction is core → library.

## Connection and DI

`httpModule` keeps the existing imports and the singleton `HOSTED_SERVICE` that creates `HttpServer` through a resolver factory. Controllers stay scoped. There are no new DI tokens, constructor dependencies, service exports or generated registrations. The `HttpModuleOptions` TypeScript export is already available from `index.ts`.

## Inputs and results

| Field | Source / type | Required / null | Default | Check / meaning |
|---|---|---|---|---|
| `inspectableRedirects` | options, boolean | optional; null is forbidden | false | A non-boolean value → `HttpSetupError`; true allows the protocol only on the client's request |
| `X-bazis-Redirect` | request header, string | optional | absent | Only the exact `manual-v1` enables the negotiated representation; any other value keeps regular HTTP |

Example: `httpModule({ inspectableRedirects: true })`. The client separately enables `new HttpClient({ inspectableRedirects: true, maxRedirects: 2 })`.

On an enabled server responses vary by `Vary: X-bazis-Redirect`. On a negotiated request the response gets `X-bazis-Redirect: manual-v1`, `Cache-Control: no-store` and CORS exposure of the protocol headers. A 301/302/303/307/308 redirect with Location is sent as HTTP 200 with `X-bazis-Redirect-Status` holding the original status and the original Location. The body is neither read nor copied; HEAD keeps this metadata without a body. A regular response keeps its status and body. Without negotiation the server keeps regular HTTP redirects.

Negotiation applies after the regular auth/middleware/CORS, including the framework 404/405/health/docs. It adds no `Access-Control-Allow-Origin`, does not allow credentials and does not bypass CORS. Enabling it lets clients that can access the response read Location; the application enables it only on the HTTP server that needs it. A strict CORS `allowedHeaders` must allow `X-bazis-Redirect`; by default the current preflight reflects the requested names.

Native file responses keep the original Response when the headers are writable. Only a status change or immutable headers need a new Response with the same body. The scope observes the final response; EOF/error/cancellation and shutdown keep the existing semantics.

## Checks

The HTTP-E05 fix and the recheck of the sources/HTTP binary without the client
application: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-enterprise-fixes/REPORT.md).
The following links and counters refer to earlier snapshots.

An additional [qualification of the application, browsers, the Node client and load](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-qualification/REPORT.md)
checks the same server implementation with the application's shared configuration
actually enabled. Safari WebDriver and the results of the current Vue build are listed
separately. Below are the results of the earlier snapshot of the negotiated protocol.

Checked: opt-in on both sides, regular redirects without negotiation, HEAD, CORS and cache metadata, an immutable Response, raw file Range, a delayed stream and a configuration error. The full HTTP suite: 274 PASS / 0 FAIL; the negotiated mode in Chromium: 28 scenarios / 73 assertions; the regular mode: another 22 scenarios / 68 assertions. TypeScript: PASS. [Report and commands](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-redirects/REPORT.md).

A native file-open error happens after the pipeline and may lack the protocol confirmation; the client keeps such an HTTP 500 as an HTTP error. CORS for this native error keeps the server's existing limits. Load, Node, other browsers and production are not part of these checks.

## Rate limiter fill

The public `rateLimit(options)` middleware keeps fixed windows and state in the
memory of one process. When the table is full, new keys get 429 with `Retry-After`
until the nearest window expires. Active buckets are not evicted: exhausted quotas
are kept, and existing keys with quota left keep working. An expired key may renew
its bucket; finished windows free space for new keys.

| Input | Type / required | Default | Check and action |
|---|---|---|---|
| `windowMs` | number, required | none | A positive finite number; the window length |
| `max` | number, required | none | A positive safe integer; requests per key per window |
| `maxBuckets` | number, optional | 10000 | A positive safe integer; new keys are rejected when it is full |
| `keyOf` | function, optional | the direct IP or a shared `*` | The application chooses the client/user identifier |
| `trustProxy` | boolean, optional | false | When on, the first forwarded IP is accepted |
| `proxyHeader` | string, optional | `x-forwarded-for` | The forwarded IP source, only with `trustProxy` |

A regular request and a rejection at a full table do O(1) Map operations.
A search of finished windows, O(maxBuckets), is allowed when free space is needed
and the nearest expiry time has passed; repeated new keys before that time do not
trigger a full scan. Memory is bounded by `maxBuckets`. This is a deliberate
availability policy: under saturation the application chooses the table size and
key partitioning; a distributed quota needs separate shared storage and is not
promised here.

## Reusing DTO binding in Agent

The internal `Binding/modelBinder.ts` accepts an optional policy as the fourth
`bindModel` argument: `unknownFields: "strip" | "reject"` (default `strip`) and
`declaredFields(model)` (no default). The latter can set the exact list of allowed
class fields from the generated schema. Agent uses `reject` at every level, keeping
the generated hydration of nested DTOs and arrays, the depth/complexity limits and
key protection. Regular HTTP calls keep removing extra fields and the existing
validator. These options are not added to the HTTP barrel exports.
Checks: [Agent/Tool fixes](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).

## Primitive type checks (0.96.1)

Codegen adds `{ primitive: "string" | "number" | "boolean" }` to the shape for
fields declared exactly with these types (with `null`/`?`/an array). The binder
checks `typeof` only with `primitiveTypes: true`; `ParameterBinder` passes this
option for a JSON body. gRPC (int64 as string/bigint) and Agent do not enable it.
A DTO that is not a named top-level export stays unchecked and gets no new codegen
error. Checks: `test/modelBinder.primitives.test.ts`, `core/scripts/test/request-model-codegen.test.ts`.

## Reusing DTO binding in gRPC

Addendum 2026-09-26: gRPC uses the same binder with the internal option
`allowBinary: true`. It copies protobuf Buffer/Uint8Array without turning them into
JSON; the default is false, so HTTP and Agent still reject binary objects. BigInt
passes as a scalar. Generated nested shapes, removal of unknown fields and the
prototype/depth/cycle protection are kept. The public HTTP API and statuses did not
change. The owner of the gRPC boundary converts binder errors;
[contract and checks](../grpc/MODULE.md).

## Strict parameter binding (DX, 2026-10-02)

An extra passport scope: the HTTP binding inference error in the existing
[codegen](../scripts/di-generate.ts). An unsupported parameter type, a missing type
or several body parameters stop generation with BAZIS_HTTP_BINDING_UNRESOLVED. The
message holds the controller, method, file and reason. Until the fix the previous
generated files stay in place; codegen returns a non-zero code, so the regular
dev/build does not continue.

Supported primitives, DTOs, ListRequest, Request/ResponseBuilder/HttpContext keep
their contracts. Since 0.98.1 a query parameter may also be an array of a
primitive (`tag: string[]`, `Array<number>`, `readonly boolean[]`): every
`?tag=` value, each converted like a scalar (a bad one is 400); without the
parameter the default, `undefined` for `tag?: T[]`, or `[]`. OpenAPI describes
it as an optional `array` parameter. For manual route assembly without codegen the old runtime
HttpContext fallback is kept; the static check guarantees do not cover that way of
running. There is no new analysis per request.

Checks: [codegen-dx.integration.test.ts](../scripts/test/codegen-dx.integration.test.ts),
[test/http.conventions.test.ts](test/http.conventions.test.ts),
[test/listBinding.test.ts](test/listBinding.test.ts).

## Allowed sorting in OpenAPI (2026-10-02)

The existing atomic HTTP module publishes an optional `x-bazis-sort-fields: readonly string[]`
extension on the `sort` query parameter. The source is the same `listOptions.sort`
or `optionsFromSchema(model)` that the binder uses. Names hold no `+`/`-`; an empty
array forbids sorting. The `sort: string` request format, HTTP routes and parser
rules do not change. Response columns do not grant sorting. Without the extension
the UI offers no unknown fields; on upgrade the server and the UI ship together.

The OpenAPI projection for the UI keeps the extension. If several API versions are
merged into one operation, the intersection of allowed fields is published: any of
these versions accepts every offered field. There are no new DI registrations.
Regressions: [openApi.sort-contract.test.ts](test/openApi.sort-contract.test.ts).

## Statuses, errors and JSDoc in OpenAPI (2026-10-09, 0.98.6)

Codegen (`library/openapi/codegen.ts`, `operationFromMethod`) records per action, in the
existing generated OpenAPI metadata: the success `status` when every success `return`
uses the same result helper (`Created` → 201, `Accepted` → 202, `NoContent` → 204,
`StatusCode(2xx)`), the `errors` returned (`NotFound(...)`, `StatusCode(4xx)`) or thrown
(`throw new NotFoundError()` and subclasses, by class chain) in the method body, and the
method JSDoc (`summary` — first line, `description` — the rest). A declared return type
is the response schema; result-helper types carry none and fall back to the returns.
Class, interface and property JSDoc become schema `description`s.

`openApiDocument.ts` builds the status as `@HttpCode` → generated status → method
default, adds `400` for body/list/query/typed route bindings, `401`/`403` under
`@Authorize`, and references the shared `HttpErrorResponse` schema — the body the
error handler writes. Errors thrown by called services are not visible to the analysis.
Old generated metadata without these fields keeps the previous document.
Regressions: [openapi-accuracy.integration.test.ts](../scripts/test/openapi-accuracy.integration.test.ts).

## Preflights of route-level CORS and early correlation id (2026-10-09, 0.98.7)

`cors()` tags the middleware it returns with its options (`corsOptionsOf`). RouterBuilder
stores the options of the action's, else the controller's, `cors()` on the `RouteAction`.
A preflight is answered before routing with the `cors` option or a global `cors()` among
the server middleware; without them, with the options of the route that matches the path
and `Access-Control-Request-Method`. Otherwise the request is routed as before (405 or an
explicit `@Options` handler).

`createCorrelationIdMiddleware()` tags its middleware too. Tagged instances among the
server middleware are also appended to the short-circuit chain, so 404/405/413, preflight,
docs and health responses carry the request id. The middleware only reads the request
and decorates the response, so running it before routing is safe.
Regressions: [test/http.cors-correlation.test.ts](test/http.cors-correlation.test.ts).

## Rate limiting before DTO checks (2026-10-02)

Server/controller/action middleware runs before DTO binding. The limiter is
connected through `options.middleware` or `@Middleware(rateLimit(...))`;
`routeMiddlewareComposer` and `ActionFilter.before` run after binding.
Exceeding `maxLength`/`length` keeps HTTP 400 with `Validation failed` and the
public `details`, but does not run `pattern` beyond the upper bound in the same
decorator. Check: [validation-admission.test.ts](test/validation-admission.test.ts).

## Removal of manual HTTP binding and target isolation (2026-10-03)

`@Bind`, the manual descriptor factories and their HTTP exports are removed.
ActionMeta no longer holds bindings; RouterBuilder, OpenAPI and the UI get the
bindings only from the generated target by the concrete controller class.
Methods without parameters get an empty descriptor; looking up foreign bindings by
class name is removed, and the package compatibility map is generated empty.
Automatic handling of route, query, DTO body, ListRequest, Request,
ResponseBuilder and HttpContext is kept. Headers and raw bodies are available
through HttpContext, DI through the constructor. RequestModel and the HttpContext
fallback for routes without a registration are kept. Migration: [RELEASE](../../../../docs/RELEASE.md).
