# Testing

Passport version: 1.1. Type: atomic. CLI profile: empty.
Status: implemented in 0.98.0; reads `@App` since 0.138.0.
Entry: [index.ts](index.ts), the public barrel `bazis/core/testing`; no DI module.
Created with: `bunx bazis g module Testing --empty --modules-root src/bazis/core --no-register`
(run as `./scripts/bazis-bun run bazis g module ...` in this repository). The
generated `Testing.module.ts` was removed: the module registers no providers,
its entries are functions.

Before changing it, read AGENTS.md and docs/architecture/MODULE_ARCHITECTURE.md.

## Responsibility and contents

Helpers for application tests. They load the project's generated code first
(without it constructor dependencies are missing and a container test passes
for the wrong reason) and pass test replacements of providers through
`createContainer` `overrides` / `KernelBuilder.useOverrides`. The module owns
no data and no runtime behaviour of its own.

| Entry | Input | Result |
| --- | --- | --- |
| `createTestContainer(root, options?)` | The `@App` class or a module; `TestContainerOptions` (`overrides`, `validateOnBuild` default true) | `Promise<DiContainer>`; for an `@App` class the graph also holds its infrastructure, cache and configs |
| `startTestApp(root, options?)` | The `@App` class or a module; `TestAppOptions`: `AppSettings` without `http.port/hostname`, `http: false` for no server, `overrides` | `Promise<TestApp>`: `url`, `fetch(path, init?)`, `use(Service, work)`, `container`, `stop()` |

For an `@App` class (0.138.0) the test starts what production starts: `infra`, `cache`,
`config` and `http` come from the declaration, and every option given replaces the
declared field. An `@App` without `http` starts without a server unless the test asks
for one. A single module with its options still works, to test a part of the
application: `startTestApp(TaskModule, { infra: TestInfra })`.
`app.use(Service, work)` calls a service in a scope of its own, as a request does:
`await app.use(ITaskService, (tasks) => tasks.create("Write the report"))`.
Rights for a test that is not about rights: `overrides: [allowAll()]` from
`bazis/core/access/testing`.

`startTestApp` builds the same graph as `runApp` (`composeApp` in
`core/app/runApp.ts`), on 127.0.0.1 and a free port, environment `test`
unless `kernel.environment` says otherwise, no startup report, no signal
handlers; it starts the kernel with `start()` instead of `run()`, so a
configuration or startup failure throws to the test instead of exiting the
process. `stop()` is the graceful kernel stop.

## Dependencies

`core/di` (container, `HOSTED_SERVICE`), `core/kernel` (`KernelBuilder`),
`core/http` (`HttpServer` to read the port), `core/app` (`composeApp`),
`core/generatedRuntime`. Nothing depends on this module.

## Errors

- An override that replaces no registration: `DiError` "Override of "X"
  replaces nothing: no module registers it." (from `createContainer`).
- Invalid configuration, DI graph errors, failing startup: thrown by
  `createTestContainer` / `startTestApp`.
- `app.fetch` on an app started with `http: false` throws.

## Checks

[test/testing.integration.test.ts](test/testing.integration.test.ts): a
temporary project, codegen, then its own `bun test` with a container test, an
in-process HTTP test (200/404 through a fake) and a run without overrides
(500 from the real store). Overrides themselves:
`core/di/test/di.overrides.test.ts`.
