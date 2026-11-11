# Application composition

Passport version: 1.2. Date: 2026-11-11. Type: existing technical composition module.
Path: `src/bazis/core/app`. Entry point: [runApp.ts](runApp.ts).
Scope: the application declaration `@App` (0.138.0) and `AppSettings.grpc`; the other
HTTP/UI/infra options are described in the source contracts. The module existed before
CLI generation became mandatory.

## The application declaration (0.138.0)

The application is declared once, by a class marked `@App(options)`:

```ts
// src/app/App.ts
@App({ modules: [AppModule], infra: AppInfra, http: { health: true } })
export class Application {}

// src/index.ts
await registerBazisGeneratedRuntime();
await runApp(Application);
```

- `AppOptions` = `modules` + `AppSettings` (`infra`, `cache`, `config`, `http`, `grpc`,
  `websocket`, `language`, `messages`, `validator`, `ui`, `kernel`, `configure`). The
  class is also the root module: its `imports` are `modules`. `@App` without an array
  of `modules` throws `KernelError`.
- `runApp(app)` takes only a class marked `@App` and returns `Promise<number>` under the
  `Bazis.run` contract; `runApp(AppModule, options)` and `RunAppOptions` are removed.
  Composition errors are reported like kernel build errors, never as success.
- `startTestApp(App)`, `createTestContainer(App)` and `testWorkflow(App)` read the same
  declaration; their options only say what differs (see the
  [testing passport](../testing/MODULE.md)).
- The HTTP address is the `http` settings section (`httpConfig`): `http.host` and
  `http.port`, from `BAZIS_HTTP__HOST` and `BAZIS_HTTP__PORT`; port 3000 by default.
  Outside production the server listens on `127.0.0.1` unless `http.host` says
  otherwise; production listens on `0.0.0.0`. `port`/`hostname` in `@App({ http })`
  still pin the value in code. An application's own config section named `http`
  conflicts with the built-in one.
- A compiled binary gets its generated code only through
  `registerBazisGeneratedRuntime()` in the entry point; it does not load `src/generated`
  of the directory it was started in.

## gRPC

`AppSettings.grpc?: GrpcModuleOptions` enables the gRPC server.
Fields, defaults, errors and limits are in the [gRPC passport](../grpc/MODULE.md).
Since 2026-09-20 gRPC uses bazis's own contracts/codecs and the built-in HTTP/2
without external libraries. The types and SDK-specific passthrough options of the
third-party SDK were removed by the owner's decision.
undefined does not start gRPC; `{}` enables a 127.0.0.1:50051 listener and the
controllers of the feature root; null is not allowed.

With both http and grpc, the servers share one container and use separate request
scopes. grpc.imports extend the published gRPC tree; http.imports keep their
purpose. Ownership of providers, kernel configuration and imports/exports is unchanged.

With `http`, the composition also installs the cache module's `missingCacheModuleCheck()`
(since 0.98.10): an `@OutputCache` route without a cache module is reported at startup.

`@App({ validator })` sets the existing synchronous ModelValidator for
HTTP and gRPC; the default is modelValidatorAdapter. A gRPC-only app gets the same
adapter. An optional `grpc.validator` replaces it for gRPC only (null is
forbidden). Each server captures its validator when created: a later HTTP
useModelValidator call does not switch a running gRPC server. A DTO needs a binding
by parameter class through di:generate or an explicit second @GrpcMethod argument.
DTO errors map to INVALID_ARGUMENT with bounded field errors, not to HTTP 400;
details and streaming semantics are in the gRPC passport.

```ts
@App({
  modules: [AppModule],
  http: {},
  grpc: { address: "127.0.0.1:50051" },
})
export class Application {}
```

Components: `@App`, `AppOptions`/`AppSettings` and the composition (`composeApp`) before `Bazis.run`.
There are no new providers/ORM/UI/AI handlers of its own. DI exports and lifecycle
belong to the existing kernel and transports. The bazis TS facade also exports the
gRPC decorators and contracts.

Checks of HTTP + gRPC, private constructor DI and a standalone binary:
[grpc.codegen-binary.test.ts](../grpc/test/grpc.codegen-binary.test.ts).
Regular checks: [runApp.config.test.ts](test/runApp.config.test.ts) and the other tests in [test/](test).
Baseline before the change: full TypeScript check PASS. Results are recorded in the
gRPC passport; the change does not qualify the application's external infrastructure.
