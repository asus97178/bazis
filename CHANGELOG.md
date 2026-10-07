# Changelog

All notable changes to the `bazis` package. Versions follow
[Semantic Versioning](https://semver.org); before 1.0 a minor version may
contain breaking changes, a patch version does not.

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
