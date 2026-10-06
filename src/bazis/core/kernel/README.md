# Kernel Folder Map

The bazis Application/Kernel layer: one application lifecycle on top of DI.
Borrowed practices: .NET Generic Host (two-phase builder, lifetime, shutdown timeout),
Spring (startup phases, events, profiles), Symfony (explicit Kernel, module config schema),
NestJS (granular lifecycle hooks, global modules), all without reflection and AOT-compatible.

Contracts of the lifecycle and configuration fixes: [partial passport](MODULE.md).

## Entry point

- `Bazis.ts`: the facade: the `Bazis.run(AppModule)` one-liner and `Bazis.createBuilder(...)` for fine tuning.
- `KernelBuilder.ts`: the mutable configuration phase; `build()` returns an immutable `Kernel`.
- `Kernel.ts`: the kernel: `start()/stop()/run()` with one shared operation for repeated calls, signals, unhandled errors, exit codes, startup report. The startup deadline also covers started callbacks and events.

## Lifecycle

- `LifecycleCoordinator.ts`: boot/shutdown order: options fail-fast → `onInit` → hosted services by phase → `onBootstrap`; shutdown in reverse order with `shutdownTimeout`; rollback when startup fails.
- `ApplicationLifetime.ts`: injectable lifetime: `onStarted/onStopping/onStopped` + programmatic `stop(exitCode)`.
- `lifecycleHooks.ts`: the `LIFECYCLE_HOOK` token (enumerable) + `addLifecycleHook`.
- `Environment.ts`: the environment (`development|production|test`) from `BAZIS_ENV`/`NODE_ENV`, the `debug` flag.
- `SupervisedHostedService.ts`: retry with exponential backoff; passes the startup signal and stops retrying on cancellation.
- `logging/ConsoleLogger.ts`: the standard structured logger; fields are
  redacted through `bazis/library/redaction` by default. Raw fields are
  allowed only with an explicit `redaction: false` for trusted local
  diagnostics.

## Configuration (`config/`)

- `Configuration.ts`: an own snapshot of the flat config (`db.host` → string), typed getters, `loadConfiguration`.
- `defineConfig.ts`: an immutable declaration with environment overrides, a separate `resolve(environment?, configuration?)` and the `token` DI token. One declaration is used in several kernels.
- `ConfigRegistry.ts`: one validated view of a declaration per kernel; `get(definition)` returns the same object as DI by `definition.token`.
- `sources.ts`: sources: `memorySource`, `envSource` (`BAZIS_DB__HOST` → `db.host`), `argsSource` (`--db.host=x`), `jsonFileSource` (a file next to the binary).
- `addConfigOptions.ts`: `configOptions(token, { bind, validate })`: validated module options read from `Configuration`; the kernel validates them all at startup with one error.
- `Secret.ts`: a secret with redaction: `toString/toJSON/inspect` print `***`, the value is available only through `reveal()`.

The [per-kernel configuration architecture](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation)
is implemented: the declaration is shared and immutable, while the environment and
the computed values belong to each kernel. The temporary ban on reusing a declaration
is lifted. A declaration's direct `get/has` are meant for standalone code; `ensureValid`
no longer switches their environment. Contracts and checks are in the
[passport](MODULE.md#config-isolation-decision) and the [config description](config/README.md).

## Events (`events/`)

- `EventToken.ts`: typed events without reflection (`createEventToken<T>`).
- `EventBus.ts`: a bus on top of DI (`resolveAllKeyed`); handler errors are aggregated. An optional `signal` stops waiting and stops starting the remaining handlers, including the `isolate` mode. User code that is already running stays responsible for its effects.
- `onEvent.ts`: subscription from a module (`providers: [onEvent(EVT, handler)]`) or a collection.
- `kernelEvents.ts`: `APPLICATION_STARTED`, `APPLICATION_STOPPING`.

## Health (`health/`)

- `HealthCheckContracts.ts`: the `HEALTH_CHECK` token (enumerable), report types.
- `HealthService.ts`: the aggregator: a failed check is marked unhealthy without failing the report; `kernel.health()`.

## Errors (`errors/`)

- `KernelError` (base), `StartupAbortedError`, `StartupTimeoutError`, `ShutdownTimeoutError`, `ConfigKeyMissingError`. When cleanup after a failed start times out, `ShutdownTimeoutError.cause` keeps the original error.

## Principles

- Two-phase: nothing can be registered after `build()`.
- Kernel infrastructure (`Environment`, `Configuration`, `ApplicationLifetime`, `EventBus`, `HealthService`) is a global module: any module gets it without an import.
- No reflection and no dynamic import; the config lives outside the binary.
- The kernel works only at startup/shutdown; there are no runtime hot paths in it.
- External code imports the kernel through `bazis/core/kernel`.
