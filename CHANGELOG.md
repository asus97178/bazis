# Changelog

All notable changes to the `bazis` package. Versions follow
[Semantic Versioning](https://semver.org); before 1.0 a minor version may
contain breaking changes, a patch version does not.

## 0.98.19 — 2026-10-10

### Added

- `executeUpdate({ publishedAt: null })` sets a nullable column to `NULL`.
  A required (`NOT NULL`) column still rejects `null`, now with a message.

### Fixed

- `insertIfAbsent` with an unset generated key (`@Key() id = 0`) inserted
  `id = 0` explicitly: the first row got key `0`, and the next insert failed
  with `duplicate key value violates unique constraint "pk_articles"`. A
  `@UUID({ version: "v7" })` key left as `""` failed with `invalid input syntax
  for type uuid`. An unset identity or v4 key is now assigned by the database,
  and a v7 key gets a new UUID v7, as with `saveChanges()`. An explicitly set
  key is inserted as given; the passed entity stays unchanged.
- `executeUpdate`, `executeDelete` and `insertIfAbsent` explain why the input is
  rejected instead of `Immediate ORM mutation input is unsafe or unsupported.`:
  `call .asNoTracking() before executeUpdate()`, `add .where(...) before
  executeDelete()`, `does not accept take() or skip()` / `orderBy()` /
  `forUpdate()`, `"nope" is not a mapped property of Article`, `"id" is the
  primary key…`, `"views" expects integer, got string`, `"views" must be a
  value, got a function; expressions such as views + 1 are not supported`,
  `"views" is missing; pass an entity with every mapped property`. Hostile
  inputs (proxies, accessors, cycles) keep the generic message.
- `OrmTrackedMutationConflictError` names the tracked entity and the way out:
  load it with `.asNoTracking()` or run the mutation in a separate `DbContext`.

## 0.98.18 — 2026-10-10

### Changed

- `forUpdate()` and `findForUpdate()` outside a transaction fail before the
  query with a hint to use `db.transactionScope(...)`. Outside a transaction
  PostgreSQL releases the row lock right after the `SELECT`, so such a read
  never protected the following `saveChanges()`. `forUpdate({ skipLocked: true })`
  already required a transaction.

### Fixed

- A transaction scope whose callback caught a failed operation and returned
  normally was rolled back with `ORM transaction scope is not active for this
  operation.` It now says `rolled back because an operation inside it failed:
  PostgresError: division by zero`, keeps the original error in `cause`, and
  suggests a nested `transactionScope()` for an expected failure.
- Errors for a context that cannot run in the current scope name the context
  and the reason: `AuditDb is not part of the surrounding transaction scope.
  Run it through tx.use(context, work)…`, `AuditDb uses a different database
  provider…`, a finished scope (`await every ORM call inside the scope
  callback`), or a still running nested scope. A same-provider context that
  starts its own scope inside another one got `belongs to a different provider
  identity`; it now gets the `tx.use` hint (`OrmTransactionScopeError`).
- A scope timeout said `ORM operation was aborted.`; it now says `ORM
  transaction scope timed out after 200 ms.` A nested deadline keeps its
  parent's reason, and a plain operation timeout says `ORM operation timed out
  after N ms.`
- `onSql` traces `BEGIN`, `COMMIT` and `ROLLBACK` of PostgreSQL transactions,
  not only `SAVEPOINT` commands.

## 0.98.17 — 2026-10-10

### Fixed

- `saveChanges` sets foreign keys from navigations. `article.author = bob` (a
  `@ManyToOne`) or `bob.articles.push(article)` (a `@OneToMany`) with a new
  `bob` now saves `article.authorId` with `bob`'s generated key: the author is
  inserted first, and the key is copied right before the article's insert.
  Before, `authorId` stayed `0` and the insert failed with `violates foreign key
  constraint "fk_articles_authorId"`. Changing the navigation of a loaded entity
  updates its foreign key. Only entities tracked by the same context are
  followed; the navigation wins over a different value in the foreign key
  property.

## 0.98.16 — 2026-10-10

### Added

- Case-insensitive text matches: `p.title.contains("sql", { ignoreCase: true })`,
  and the same option on `startsWith`, `endsWith` and `eq`. PostgreSQL gets an
  escaped `ILIKE`; `%` and `_` in the value stay literal.

### Fixed

- A condition that is not an ORM condition fails with a hint:
  `where() expects a condition such as (p) => p.views.gt(70), got boolean. Use
  .gt()/.eq()/.and()/.or() instead of >, ===, &&, ||.` Before, the query failed
  with `undefined is not an object (evaluating 'condition.kind')`. Applies to
  `where`, `count`, `any`, `first`, `firstOrDefault` and `@QueryFilter`.
- A computation inside `select()` fails with a hint:
  `select() maps properties as they are, e.g. (p) => ({ name: p.title });
  compute values after toList().` Before, `({ label: `${p.title}!` })` failed
  with `Property "title!" is not mapped on entity "Post". Did you forget @Column()?`.
- The `BAZIS_ORM_PREDICATE_LOGIC` codegen error (`&&`/`||` over conditions)
  shows a relative path and an example of `.and()`.

## 0.98.15 — 2026-10-10

### Fixed

- The DI encapsulation error names the module to fix when an import sees a
  service through its own imports but does not export it. With
  `ormBazis: { context: CatalogDbContext }` in `CatalogModule` and
  `OrdersModule` importing `CatalogModule`, a missing export now reads
  `"OrdersService" depends on "CatalogDbContext", which its import
  "CatalogModule" receives from its own imports but does not export. Add it to
  the exports of "CatalogModule".` Before, it named the inner module `ormBazis`
  creates (`module#10`), said that module exports the context and advised
  importing it.
- A singleton depending on a scoped service says what to do:
  `Singleton "PriceCache" depends on scoped "CatalogDbContext". A scoped service
  lives for one request or scope: make "PriceCache" scoped too, or inject
  ServiceProvider and resolve "CatalogDbContext" in a scope you create
  (provider.createScope()).`

## 0.98.14 — 2026-10-10

### Fixed

- A column without an explicit `type` whose initial value says otherwise stops
  the model build instead of silently changing the data:
  `@Column() pages = 0` was a `text` column, so `pages` came back from the
  database as the string `"412"`; `@Key() code = ""` was a bigint identity, so
  an assigned `"RU"` was dropped and `find("RU")` returned nothing. Now:
  `Entity "Book": property "pages" has no column type and maps to text, but its
  initial value is a number. Set the type: @Column({ type: "integer" }) or
  @Column({ type: "real" }).` and `Entity "Country": key "code" has no column
  type and maps to an integer identity, but its initial value is a string. For a
  text key add @Column({ type: "text" }) next to @Key(); for a UUID key use
  @UUID().` Booleans, dates, objects and arrays get the matching hint.
  **Breaking** for models that relied on the silent mapping: add the type —
  `type: "text"` keeps the existing column.

## 0.98.13 — 2026-10-10

### Fixed

- `ensureCreated` no longer refuses a table whose primary key differs from the
  model only by name — for example `tasks_pkey`, which PostgreSQL gave the key
  of a table created by an older version, while the model expects `pk_tasks`.
  The application starts and prints
  `[orm:schema] table "public"."tasks": primary key is named "tasks_pkey", the
  model expects "pk_tasks". It works as is; to align the name run: ALTER TABLE
  "public"."tasks" RENAME CONSTRAINT "tasks_pkey" TO "pk_tasks";`. Nothing is
  renamed. Before, startup failed with `PostgreSQL schema change requires an
  explicit migration … primary key name differs`, while `migrateOnStart`
  accepted the same table. The key's columns are still verified exactly.
  `DatabaseFacade.ensureCreated()` now resolves to `{ warnings }`.

## 0.98.12 — 2026-10-09

### Fixed

- A failed database connection at startup says why and where:
  `Infra connector "database": cannot connect to PostgreSQL at 127.0.0.1:5432
  (database "guide", user "postgres"): password authentication failed for user
  "postgres" (28P01)`. Before, a wrong password, a missing database, a stopped
  server, an unknown host and an unsupported TLS mode all failed with the same
  `postgres is not reachable.` The password is never shown. Database providers
  get an optional `probe(signal)` that rejects with the driver's error.
- A configuration value of the wrong shape names what came, what is allowed and
  the variable: `db.tls — "strict" is not allowed, use one of: disable, allow,
  prefer, require, verify-ca, verify-full (BAZIS_DB__TLS)`,
  `db.port — expected a finite number, got "abc" (BAZIS_DB__PORT)`,
  `feature.on — expected a boolean (true, false, 1, 0), got "yes" (…)`.
  Before, the messages were `value is not one of the declared enum values`,
  `expected a finite number` and `expected a boolean`.

## 0.98.11 — 2026-10-09

### Fixed

- A service takes the outbound HTTP client by type:
  `constructor(private readonly http: HttpClient)` gets the client of
  `httpClientModule`. Before, the module registered it only under the
  `HTTP_CLIENT` token, and the application failed with
  `Missing dependency "HttpClient"`.
- `HttpClientFactory` is an abstract class, so `clients: HttpClientFactory`
  in a constructor gets the named-clients factory. Before, it was an interface
  and codegen stopped with `BAZIS_DI_DEPENDENCY_UNKNOWN`. The call shape and
  `HttpClientFactoryBuilder` do not change; `HTTP_CLIENT` and
  `HTTP_CLIENT_FACTORY` keep working.
- An unhandled `HttpClientError` answers `504 Gateway Timeout` (the outbound
  request timed out) or `502 Bad Gateway` (any other outbound failure) instead
  of `500 Internal Server Error`. The upstream response is not passed to the
  client; the log line keeps the full error. A client error without a code (a
  misconfigured request) stays `500`.
- A relative `baseUrl` (`new HttpClient({ baseUrl: "/api" })`) works in a
  browser app: it is resolved against the page address, as axios's `baseURL`
  is, and the same-origin checks for secret headers and correlation use the
  resolved address. Before, every request failed with
  `Failed to construct 'URL': Invalid base URL`. Outside a page a relative
  `baseUrl` is a clear error: `baseUrl "/api" is relative: outside a browser
  page it must be absolute, for example "http://localhost:3000/api"`.

## 0.98.10 — 2026-10-09

### Fixed

- Optional constructor dependencies work: `constructor(private readonly cache?: ICache)`
  gets the service when it is registered and `undefined` otherwise; a parameter
  with a default (`clock: Clock = new SystemClock()`) gets the registered
  service or keeps its default. Before, codegen skipped such parameters while
  validation counted them, and the application failed to start with
  `requires at least 1 constructor deps … run bazis codegen`. An optional
  trailing parameter of a type DI does not know (`options: Options = {}`) is
  still not injected. New `optionalDependency(token)` for explicit deps lists.
- `@OutputCache` without a cache module is reported at startup:
  ``[cache] @OutputCache on TasksController.getAll has no effect: no cache module
  is installed, so every request runs the action. Add `cache: memory()` to the
  runApp options.`` Before, the decorator silently did nothing.

### Added

- `memory({ policies, outputCache })`: named cache policies and output-cache
  settings through the public API. Before, they were available only through the
  internal `buildCacheModule`.
- A response served from the output cache (`@OutputCache`, `@OutputRedisCache`)
  carries `Age` — seconds since it was stored.

## 0.98.9 — 2026-10-09

### Security

- `rateLimit({ trustProxy: true })` keys a client by the address the proxy
  appended to `X-Forwarded-For` — the last entry — instead of the first one.
  The first entries are written by the client, so before a client bypassed the
  limit by sending a different `X-Forwarded-For: 1.1.1.N, …` with every
  request. Behind several proxies pass their number: `trustProxy: 2` takes the
  address two hops from the end. With two appending proxies and
  `trustProxy: true`, every client now shares one key (the nearer proxy's
  address) until `trustProxy: 2` is set; a proxy that overwrites the header
  keeps working unchanged.

### Added

- `rateLimit` responses carry `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset` (seconds until the window resets), the `429` included next
  to `Retry-After`. `headers: false` turns them off. `TooManyRequestsError`
  takes the extra headers as its second argument.

## 0.98.8 — 2026-10-09

### Fixed

- Error responses carry the correlation id: with
  `createCorrelationIdMiddleware()` among the global `middleware`, a `401`/`403`
  from `@Authorize`, a thrown `NotFoundError` or other `HttpError`, and a `500`
  have `x-request-id`. Before (also in 0.98.7), the error handler built these
  responses outside the correlation middleware, so only successful and
  pre-routing responses had the header. The correlation middleware now wraps
  the error handler; its position among the other global middleware no
  longer matters.

## 0.98.7 — 2026-10-09

### Fixed

- `cors()` on a controller or a method answers CORS preflights of its routes:
  `@Middleware(cors({ origin: "*" }))` makes `OPTIONS` with
  `Access-Control-Request-Method` answer `204` with the CORS headers. Before,
  the preflight got `405 Method Not Allowed`, so a browser could not send a
  JSON `POST` or an `Authorization` header to such a route. A method's `cors()`
  wins over the controller's; a `cors()` among the global `middleware` answers
  every preflight like the `cors` option. Routes without `cors()` keep their
  previous answer.
- A `createCorrelationIdMiddleware()` among the global `middleware` also
  covers the responses the server produces before routing — `404`, `405`,
  `413`, preflights, docs and health: they carry `x-request-id`, and their
  access log lines carry `requestId`. Before, only routed requests had it.
- Access log `durationMs` is rounded to 0.01 ms (`1.31`, not
  `1.3119999999999834`), in the log line fields and in custom `log` sinks.

## 0.98.6 — 2026-10-09

### Fixed

- The generated OpenAPI document describes what the server answers:
  - The success status comes from the result helper the method returns:
    `return Created(...)` is documented as `201`, `Accepted(...)` as `202`,
    `NoContent()` as `204` (when every success return uses the same helper;
    `@HttpCode` still wins). Before, such operations were documented as `200`.
  - A declared return type is the response schema: `getById(id): TaskResponse`
    references `TaskResponse` even when the method returns an object literal.
    Before, the literal produced an anonymous schema.
- The built-in docs page labels operations with their summary instead of the
  generated `operationId`.

### Added

- Error responses in OpenAPI with a shared `HttpErrorResponse` schema
  (`{ "error": "...", "details": ... }`): `400` for operations with a body,
  query parameters, a list query or typed route parameters; `401` and `403`
  under `@Authorize`; and the errors the method body returns (`NotFound(...)`,
  `StatusCode(409, ...)`) or throws (`throw new NotFoundError()`, including
  subclasses). Errors thrown inside called services are not visible.
- JSDoc in OpenAPI: the first line of a controller method's comment is the
  operation `summary`, the rest is its `description`; comments on classes,
  interfaces and their properties become schema `description`s.

## 0.98.5 — 2026-10-09

### Fixed

- Controller inheritance, the natural way to build `NotesV2Controller` on
  `NotesV1Controller`:
  - Route decorators on an overriding method replace the base method's
    routes. Before, they were added to them, and the application failed at
    startup with `Duplicate route: GET /v2/notes/:id is mapped to both
    NotesV2Controller.getById … and NotesV2Controller.getById`. Other settings
    of the base method (status code, middleware, version) stay inherited.
  - Codegen follows the `extends` chain and generates argument bindings for
    inherited routes, with the parameters of the nearest override. Before, an
    override without route decorators kept the base route but received
    `HttpContext` instead of its parameters (`500` on serialization), and
    inherited methods of a subclass had no bindings at all.

## 0.98.4 — 2026-10-09

### Fixed

- API versioning options that had no effect are rejected at startup instead
  of being silently ignored. `versioning: { source: "url", defaultVersion: "1" }`
  stops the server with `versioning.defaultVersion has no effect with source
  "url": the version is part of the path (/v1/...)`; before, the option was
  ignored and `/tasks/7` answered `404`. The same applies to `parameterName`
  with a source other than `"query"`, `headerName` with a source other than
  `"header"`, and an unknown `source`. An application with such options must
  remove them.

## 0.98.3 — 2026-10-09

### Fixed

- A route's `consumes` applies to every request with a body, however the
  action reads it (a body model, `ctx.formData()`, `ctx.text()` or not at
  all): `@Post("avatar", { consumes: "multipart/form-data" })` answers a JSON
  request with `415 Unsupported Media Type: expected multipart/form-data`.
  Before, `consumes` was checked only for body-model parameters, and such a
  route answered `400 Malformed form data in request body`. `GET`, `HEAD`
  and `OPTIONS` are not checked.

## 0.98.2 — 2026-10-09

### Added

- `@ListOptions({ defaultSort: "-createdAt" })`: the sorting of a list when the
  request has no `sort`, in the same syntax as the parameter. Every field must
  be `@Sortable()`; otherwise the class declaration throws. The primary key
  still breaks ties. Modules from `bazis g module` sort newest first.

### Fixed

- Sparse fieldsets: `?fields[tasks]=name` keeps only `id` and `name` in every
  list item. Before, `fields` was parsed and only repeated in the paging links.
  The resource type comes from the new `type` option of `buildListDocument`,
  by default the last segment of `basePath` (`/api/tasks` → `tasks`).

## 0.98.1 — 2026-10-09

### Added

- Query arrays: a controller parameter `tag: string[]` (also `number[]`,
  `boolean[]`, `Array<T>`, `readonly T[]`) takes every `?tag=` value, each
  converted by the element type: `?tag=a&tag=b&status=1` gives
  `["a", "b"]` and `[1]`. A bad element is 400 (`Parameter "status" must be
  of type number, got: "abc"`); without the parameter the default,
  `undefined` for `tag?: T[]`, or `[]`. OpenAPI describes it as an optional
  `array` parameter. Before, codegen stopped with "no type annotation usable
  for conventions".

### Fixed

- The duplicate-route error names both paths: `Duplicate route: GET
  /tasks/:taskId is mapped to both TasksController.byId (/tasks/:id) and
  TasksController.again. Routes that differ only in parameter names are the
  same route; change one of the paths.` Before, it read `GET (version "-")`
  without a path.

## 0.98.0 — 2026-10-08

### Added

- `bazis/core/testing`:
  - `createTestContainer(root, { overrides })`: a container for module tests.
    It loads the project's generated code first; without it constructor
    dependencies are missing and such a test passes for the wrong reason.
  - `startTestApp(root, { overrides, ...runAppOptions })`: the application in
    the test process the way `runApp` builds it, on 127.0.0.1 and a free port,
    environment `test`; `app.fetch("/tasks/1")`, `app.container`,
    `app.stop()`. Startup errors throw to the test.
- `createContainer(root, { overrides })` and `KernelBuilder.useOverrides(...)`:
  test replacements of providers. They are registered after the whole module
  graph and visible to every module, so a fake replaces a provider even when
  its own module consumes it; an override that replaces nothing is an error.
  Before, a replacement in the importing module failed with "registered in two
  modules", and a `@Global` workaround depended on the order of imports.

### Fixed

- The generated code is looked up in the project's working directory first.
  With a framework linked from another checkout (`bazis new --link-framework`)
  the framework found that checkout's own `src/generated` next to its sources.

## 0.97.11 — 2026-10-08

### Fixed

- Application log lines written inside an HTTP request carry its `requestId`
  (and `traceparent`, when the request brought one): the default
  `ConsoleLogger` reads them from the request context that
  `createCorrelationIdMiddleware` binds. Before, only the access log and the
  HTTP error lines had the id, so a service's `logger.info(...)` could not be
  matched to its request. Explicit `requestId` fields win; lines outside a
  request are unchanged; `new ConsoleLogger({ requestContext: false })` turns
  it off. Custom loggers can read `getRequestId()` themselves.

## 0.97.10 — 2026-10-08

### Fixed

- Background service failures go to the application logger, like HTTP errors
  since 0.97.1: `error: background Crasher crashed {"service":"Crasher",
  "restarts":0,"error":{...}}`, `... tick failed`. The kernel passes the logger
  through the new optional `HostedService.useDiagnostics(diagnostics)` before
  start. Without a logger the text still goes to the console.
- A service whose restarts ran out says so: `background Crasher stopped after
  2 restarts and will not run again` (or `stopped after a crash and will not
  run again (no restart policy)`). Before, it just went quiet.
- The slow-stop warning is honest: `did not stop within 300ms: shutdown
  continues, but its unfinished work keeps the process alive until it ends`
  instead of `...; continuing shutdown`.

### Added

- `BackgroundService.reportFailure(message, error, fields?)` (protected) for
  subclasses that handle their own failures.

## 0.97.9 — 2026-10-08

### Fixed

- A wrong environment variable name in `defineConfig` (`env: { host: "SMTP_HOST" }`)
  now names the key and the actual problem: `Configuration key "mail.host":
  environment variable "SMTP_HOST" must start with BAZIS_: configuration reads
  only BAZIS_* variables (for example BAZIS_SMTP_HOST).` Separate reasons for
  an empty name, invalid characters and a name used twice. Before, all four
  read `Invalid or duplicate configuration environment name: SMTP_HOST.`

## 0.97.8 — 2026-10-08

### Added

- `bazis g module <Name> --pack <Pack>` adds a part to an existing composite
  module: it goes into `<pack>_modules/<name>_module` like the parts made by
  `g pack`, is connected in the pack root, and its passport names the pack.
  The command reminds to add the part to the pack passport's parts table.
  Before, a part had to be added with `--modules-root` and `--app-module`, and
  it landed in `<name>/` without any link to the pack.
- Generated `MODULE.md` passports record the creation command (`Created with:
  \`bunx bazis g module Task --minimal\``), as the architecture rules require;
  pack parts record the pack command. Before, the author had to add it by hand.

## 0.97.7 — 2026-10-08

### Fixed

- The 0.97.6 error for a token registered in two modules printed
  `... one implementation per token: *** last registered ...` in the console:
  the secret redaction applied to configuration errors read `token: the` as a
  secret value. The text now reads `... one implementation per token, the last
  registered one, from "AppModule" ...`, and the tests check the redacted text
  the console shows.

## 0.97.6 — 2026-10-07

### Fixed

- A clear error when a token is registered in two modules and the imported
  one uses it. The application has one implementation per token (the last
  registration wins), so the importer's registration replaces the imported
  module's, which that module cannot see. The error used to read `"Report"
  selects "IClock" from module "AppModule", which is not exported to this
  consumer (key: undefined)`; now it names both modules and the fix (wording
  corrected in 0.97.7): `... "IClock" is registered in "ClockModule" and
  "AppModule", and the application uses one implementation per token, the last
  registered one, from "AppModule", which "ClockModule" cannot see. Register "IClock" in one
  module, or give the implementations different keys (DI.keyedSingleton).`

### Changed

- Message text of that `ModuleEncapsulationError`; tests that match it in full
  need an update.

## 0.97.5 — 2026-10-07

### Added

- TypeScript 7 support. TypeScript 7 ships no compiler API (`import ts from
  "typescript"` gives only the version), so codegen and `bazis g module` load
  Microsoft's TypeScript 6 API from `@typescript/typescript6` when the
  project's `typescript` is 7 or newer: `bun add -d typescript@^7
  @typescript/typescript6`. The project keeps type-checking with TypeScript
  7. Without the package they stop with `BAZIS_TYPESCRIPT_API_MISSING` and
  the install command. Peer dependencies: `typescript` `^5.9.3 || ^6.0.0 ||
  ^7.0.0`, optional `@typescript/typescript6`.

### Fixed

- Two type errors that TypeScript 7 reports in
  `library/orm/Providers/OwnedStoreCatalog.reader.ts` (a frozen tuple inferred
  as an array); the whole framework type-checks with TypeScript 6 and 7.
- The runtime import boundary test parses sources with the TypeScript parser
  instead of regular expressions: an import-like phrase inside a string or a
  comment is no longer taken for an import.

## 0.97.4 — 2026-10-07

### Fixed

- A singleton registered with `singletonAsyncFactory` (or another async
  factory) can be injected through constructors: the kernel creates async
  singletons at startup, before hosted services and the HTTP server. Before,
  every request to a controller that took one failed with
  `AsyncResolutionRequiredError` while the startup succeeded. A failing async
  factory now stops the start (exit code 1). New
  `ServiceProvider.initializeAsyncSingletons()`.
- Codegen stops with `BAZIS_DI_DEPENDENCY_UNKNOWN` when a DI-constructed class
  has a constructor parameter of a plain type (`string`, `number`, an inline
  type). Before, the class silently got no dependencies and the start failed
  later with a misleading "run codegen" hint. Classes with an explicit deps
  list are not affected.

### Changed

- Async singleton factories run eagerly at startup instead of on first
  `resolveAsync`.

## 0.97.3 — 2026-10-07

### Fixed

- `bazis dev`, `bazis test` and `bazis build` run codegen for every target of
  `bazis.config.json`. Before, they generated only the default target, and a
  second entrypoint (for example a worker) silently kept stale generated code.
- Sources changed after the last codegen: a controller method that declares
  parameters but has no generated argument bindings now stops the server at
  startup — `PingController.upper has parameters but no generated argument
  bindings ... Run \`bazis codegen\`` — instead of receiving the HttpContext
  in place of its arguments and failing only on request. Methods without
  parameters and up-to-date generated code behave as before.
- The DI error `requires at least N constructor deps, but only M declared`
  says that constructor dependencies come from codegen and to run
  `bazis codegen` (or pass the deps explicitly).
- Generated files and error messages name the application command
  `bazis codegen` instead of the framework-internal `bun run di:generate`.

### Changed

- Message text: the DI error above gained a hint sentence. Tests that match
  the full message text need an update.

## 0.97.2 — 2026-10-07

### Fixed

- `ApplicationLifetime.onStarted` / `onStopping` / `onStopped` called after
  their moment run the callback right away, like .NET's ApplicationStarted.
  Before, a service first created by a request subscribed to `onStarted` and
  was silently never called. A failure of such a late callback is an
  unhandled error (logged, graceful stop with exit code 1).
- Configuration errors read `db.password — required non-empty secret is not
  set (BAZIS_DB__PASSWORD)` instead of `db.password: …`: with a sensitive key
  name (`password`, `token`, `apiKey`) the console redaction took the word
  after the colon for a secret and printed `db.password: *** non-empty secret
  is not set`. Secret values in the messages are still hidden.

## 0.97.1 — 2026-10-07

### Fixed

- Unexpected (non-`HttpError`) errors are logged through the application
  `LOGGER`, like the access log: one `error` line `"GET /tasks/7 failed"` with
  `method`, `path`, `requestId` and the redacted error. Before, they always
  went to a bare `console.error` without the request id. New
  `ErrorHandlerOptions.logger`; `logError` still replaces the logging.
- The documentation of `onUnexpectedError` and `HTTP_ERROR_HOOK` said they
  replace the built-in logging; they are notifications and the error is
  logged as well, as the code always did.
- The development 500 response (`exposeErrorDetails`) redacts secrets in the
  error message and stack, like the log.

## 0.97.0 — 2026-10-07

### Changed (breaking)

- `@Authorize` on a method adds its checks to the controller's instead of
  replacing them: the controller checks run first, then the method checks; a
  check repeated on both runs once. Before, `@Authorize(isAdmin)` on a method of
  an `@Authorize(signedIn)` controller silently dropped `signedIn` for that
  method. `@AllowAnonymous()` on a method still removes every check. To keep a
  method with checks different from its controller's, move it to another
  controller.

### Added

- A service contract can be an abstract class instead of an interface with a
  `createToken` constant: `export abstract class IClock { abstract now(): Date }`,
  `scoped(IClock, SystemClock)`, `exports: [IClock]`, and
  `constructor(private readonly clock: IClock)`. It exists at runtime, so it
  is the token itself. `Token<T>` accepts abstract classes (new type
  `AbstractClass<T>`). An interface with `createToken` keeps working; both
  forms can be mixed in one module.
- `bazis g module` generates the service contract as an abstract class (the
  recommended form); `examples/todo` uses it too.

## 0.96.6 — 2026-10-06

### Fixed

- Async `custom` rules in HTTP request models run: body binding uses async
  validation, instead of answering 400 with `asyncCustomInSyncCall`.
- A JSON type error no longer hides the other errors: the 400 response lists
  the type errors and the `@Validator` errors of the other fields together.
- `RU_VALIDATION_MESSAGES` also translates JSON type errors and the response
  title (`"error"`); new message keys `validationFailed` and `invalid` (the
  text for an unknown code was a hard-coded Russian string in every language).
- `notEmpty`, `minLength`, `maxLength` and `length` on an array count its items
  (codes `notEmpty`, `minItems`, `maxItems`, `itemCount`) instead of failing with
  "must be of type string, got: object".
- A module encapsulation error names the owner module and says whether the
  service is not exported or the owner is not imported.

## 0.96.5 — 2026-10-06

### Added

- A service can take its configuration by type:
  `constructor(private readonly config: ConfigView<GreetingConfig>)` with
  `scoped(GreetingService)`. Codegen binds the parameter to the token of the
  one `defineConfig<GreetingConfig>(...)` declaration, so the explicit
  `[greetingConfig.token]` deps list is no longer needed. The declaration must
  pass the type argument. A type without a declaration stops codegen with
  `BAZIS_DI_CONFIG_UNKNOWN`; a type shared by several declarations with
  `BAZIS_DI_CONFIG_AMBIGUOUS`.

## 0.96.4 — 2026-10-06

### Fixed

- Codegen bound route parameters only from `:name` in the method template.
  A parameter from the `@Controller` prefix (`@Controller("orgs/:org/things")`)
  or a wildcard segment (`files/*path`, or a bare `*` named `rest`) was bound
  as a required query parameter, so the request failed with 400. Both are
  now bound to the route value.

## 0.96.3 — 2026-10-06

### Fixed

- A binary built with `bazis build --bin` (or `bun build --compile`) ran in
  `development` mode when `BAZIS_ENV` was not set: Bun inlines the literal
  `process.env.NODE_ENV` as `"development"` at bundle time, and a runtime
  `NODE_ENV=production` was ignored. In that mode `debug` is on, so 500
  responses included error details, the OpenAPI page was served and
  production-only configuration checks were skipped. The environment is now
  read at runtime: without `BAZIS_ENV`/`NODE_ENV` a binary runs as
  `production`. Rebuild existing binaries; until then set
  `BAZIS_ENV=production` explicitly.
- TypeScript 6 is supported: the peer dependency is now
  `^5.9.3 || ^6.0.0`, new projects from `bazis new` get `"typescript": "^6"`,
  and the framework itself is built and tested with TypeScript 6.0.3.
  TypeScript 7 is not supported yet: it removed the JavaScript compiler API
  that the code generator uses. The README install steps for an existing
  project pin `typescript@^6`, because a bare `bun add -d typescript`
  installs TypeScript 7. With TypeScript 6 the project `tsconfig.json`
  must list `"types": ["bun"]` (TypeScript 6 no longer loads every
  `@types/*` package by default); projects from `bazis new` already do.

## 0.96.2 — 2026-10-06

### Changed

- `bazis new` makes the project depend on `bazis` from npm
  (`"bazis": "^<version>"`) instead of copying the package into
  `vendor/bazis`; `bun update bazis` now updates the framework. The previous
  behavior is available with `bazis new <Name> --vendor`.
- README: how to install from npm, a module map with links to the specs, and
  an explicit note that bazis runs on Bun only (Node.js refuses to load the
  package: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
- Releases are published through npm Trusted Publishing; no npm token is
  stored in the repository settings.

## 0.96.1 — 2026-10-06

First public release on npm. The framework was developed as Osnova and
then osnv; npm rejected `osnv` as too similar to existing package names, so
the first release uses the name `bazis`.

### Added

- `bazis` CLI: `new`, `g module` (`--empty`, `--minimal`, `--full`), `g pack`,
  `codegen`, `dev [--watch]`, `test`, `build`, `build --bin`.
- Dependency injection wired by codegen (`src/generated/bazis`), with a startup
  warning when sources changed after codegen.
- HTTP: controllers, request models with validation, JSON:API lists. Body
  fields declared as `string`, `number` or `boolean` are checked against the
  JSON type without `@Validator` (400, code `type`).
- PostgreSQL ORM: `DbContext`, migrations, owned stores. A unique index
  violation in `saveChanges()` rejects with `UniqueViolationError`
  (`constraint`, `table`, `cause`). Tables are created only through the module
  (`ensureCreated` or `migrateOnStart` in `ormBazis`).
- Configuration with per-environment defaults and `BAZIS_*` environment
  variables, JWT, WebSocket, gRPC, background services, agents and tools.
- `@UUID({ version: "v7" })`: the ORM assigns a time-ordered UUID v7 key
  before INSERT (native `uuid` column, no database default, any supported
  PostgreSQL version). Dynamic tables with `uuidVersion: "v7"` keys get the same
  behavior instead of a v4 database default. Owned stores accept v7 keys and
  plain `uuid` columns without a default, such as foreign keys to uuid keys.
- Built-in texts are English; Russian sets `RU_VALIDATION_MESSAGES`,
  `RU_CODEX_MESSAGES` and `RU_UI_LABELS` are included.
- `examples/todo` in the repository: three modules, PostgreSQL,
  cross-module injection, an end-to-end test and a binary build.

### Requirements

- Bun 1.4.0 or newer. The package ships TypeScript sources; there is no build
  step.
