# DI Folder Map

A map of the `src/bazis/core/di` structure. The core's responsibility boundaries and
contracts are described in [MODULE.md](MODULE.md).

## Public API

- `index.ts`: the single public DI entry point.
- `MODULE.md`: the contracts, boundaries and checks of the DI core.

## Container core

- `ServiceProvider.ts`: resolve coordination, dependency plans and object creation.
- `ServiceCollection.ts`: service registration.
- `ServiceScope.ts`: scoped resolve and scoped dispose.
- `container.ts`: a compatible alias wrapper over `ServiceProvider`.
- `token.ts`: DI tokens (`createToken`, open generic family).

## Internals (do not use directly)

- `internal/`:
  - `ServiceRegistry.ts`: registration identity, keyed lookup and generic materialization.
  - `ResolutionTracker.ts`: active object creations, the wait graph and cycle detection.
  - `ScopeLifecycle.ts`: ownership of scopes and resources, lifetime rules and dispose completion.
  - `classDeps.ts`: the runtime map of class deps.
  - `ResolutionScopeState.ts`: root/scope state.
  - `ServiceRegistration.ts`: the internal registration record.
  - `ResolutionPlan.ts`: the normalized dependency list of a provider (hot-path cache).
  - `NamedTokenIndex.ts`: the "type name → token" index for name-based auto deps.
  - `GraphValidator.ts`: build-time graph validation (cycles, missing/captive deps, class arity).
  - `OpenGenericRegistration.ts`: the internal model of an open generic registration.
  - `disposal.ts`: the dispose/disposeAsync helper.

## Module layer

- `module/DI.ts`: low-level provider constructors.
- `module/shortcuts.ts`: the short API (`singleton/scoped/transient`).
- `module/createContainer.ts`: builds a container from modules.
- `module/encapsulation.ts`: build-time check of module isolation (`exports`).
- `module/ModuleRegistrar.ts`: the helper registrar for `configure(di)`.
- `module/types/`: module contracts (`BazisModule`, `DiRegistrar`).
- `module/autoDeps.ts`: picks up deps from the generated map.

## Providers and types

- `provider/`:
  - `index.ts`: provider exports.
  - `providerGuards.ts`: type guards.
  - `types/`: all provider contracts (`Provider`, `ClassProvider`, `FactoryProvider`, ...).

## Errors

- `errors/`: all DI errors (one class = one file).

## Extensions

- `extensions/`: options, hosted services, application startup and object creation with manual arguments.
- `extensions/options.ts`: options + validated options (`addValidatedOptions`, fail-fast at startup).
- `extensions/options-reloadable.ts`: reloadable options (`OptionsMonitor`/`OptionsSnapshot`, `addReloadableOptions`), the counterpart of .NET `IOptionsMonitor`/`IOptionsSnapshot`.
- `extensions/application.ts`: `Application`/`runApplication`: starts hosted services and shuts down gracefully.
- `extensions/activator.ts`: `createInstance`: creates an object from a mix of DI dependencies and manual arguments (the counterpart of .NET `ActivatorUtilities`).

## Codegen

- `src/generated/bazis/deps.ts` in the application: the generated class dependency map.
- `../scripts/di-generate.ts`: the map generator.

> ⚠️ Do not edit `src/generated/bazis/deps.ts` by hand.

## Structure rules

- One class, one file.
- Types live next to their domain in `types/`.
- External code imports DI through `bazis` for the common path or through
  `bazis/core/di` for targeted access.
- `internal/` is the container's private layer.

## Style Rule (DI usage)

- By default use only the short shortcuts:
  - `singleton(...)`
  - `scoped(...)`
  - `transient(...)`
- Use the low-level path (`DI.classProvider(...)`, `DI.factoryProvider(...)`) only for rare cases that really need manual setup.

## Contributing Checklist

Before committing DI changes, check:

1. **File structure**
   - runtime classes in domain folders (`module/`, `errors/`, `extensions/`, the root core);
   - internal service details only in `internal/`;
   - type-only contracts in the nearest `types/`.

2. **Public API**
   - if you add an external API, export it from `src/bazis/core/di/index.ts`;
   - do not export `internal/*` in the external contract.

3. **Codegen**
   - set up the pinned Bun as in the [toolchain notes](../../../../toolchain/README.md);
   - after changing service constructors run `./scripts/bazis-bun run di:generate`;
   - do not edit `src/generated/bazis/` by hand;
   - run tests and builds through `./scripts/bazis-bun run test` and
     `./scripts/bazis-bun run build:bin` (they run the generation).
