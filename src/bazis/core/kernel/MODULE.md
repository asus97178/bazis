# Kernel: lifecycle and audit fixes

Passport version: 1.6. Date: 2026-10-04.
Status: the audit fixes are implemented; the checks are listed in section 6.
Per-kernel configuration isolation is implemented; checks and limits are in §7,
the inputs are recorded in the [config contracts](config/README.md).
Type: an existing atomic infrastructure responsibility: the host lifecycle.
Connection point: `KernelBuilder.build()` / `Bazis.run()`.
Passport scope: K01–K08 from the [audit](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-2026-09-13.md)
and the accepted decision to separate the configuration declaration from the kernel view.
This is a partial passport: the full contracts of config sources, health, correlation,
module subscribers and ORM admission are not redefined here.

### Repeated health requests

In one `HealthService`, at most one operation runs at a time for one `HealthCheck`
instance. Concurrent reports share its result while keeping their own deadline and
cancellation. The operation's own signal is aborted when all waiting reports leave. If
the operation ignores cancellation, later reports return unhealthy until it actually
finishes; there are no repeated runs and no piling up of work. After it finishes, the
next report runs a new check. A late Promise rejection is handled. A check must be
registered as a singleton, like the built-in Infra checks. The `concurrency` limit stays
a per-report limit; different HealthService instances and different checks get no shared
global limit. The `HealthCheckOptions` and result signatures are kept. Rationale and acceptance:
[plan](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-infra-config-acceptance/PLAN.md).

## 1. Responsibility and structure

The Kernel starts and stops the registered DI services and manages timeouts,
notifications and process exit. No split into new submodules is needed. The existing
host composition in `KernelBuilder` is kept: `BazisKernelModule` imports
`BazisKernelInfraModule` and the user root. Domain module data, HTTP authorization and
database schema changes are out of scope.

## 2. Components

| Component | File | Changed contract |
| --- | --- | --- |
| Kernel | [Kernel.ts](Kernel.ts) | The shared startup deadline, cancellation, the shared `run`, cleanup errors |
| LifecycleCoordinator | [LifecycleCoordinator.ts](LifecycleCoordinator.ts) | Actual completion of async hooks before rollback; keeping the timeout and cleanup errors |
| ApplicationLifetime | [ApplicationLifetime.ts](ApplicationLifetime.ts) | Cancelling the wait for started callbacks; skipping the rest after cancellation |
| EventBus | [events/EventBus.ts](events/EventBus.ts) | An optional signal to stop dispatch |
| SupervisedHostedService | [SupervisedHostedService.ts](SupervisedHostedService.ts) | Passing the signal, cancelling retries/backoff |
| KernelBuilder | [KernelBuilder.ts](KernelBuilder.ts) | Timeout checks; resolving declarations for its environment before DI clients are created |
| ConsoleLogger | [logging/ConsoleLogger.ts](logging/ConsoleLogger.ts) | A safe representation of non-serializable fields; inside a request adds `requestId`/`traceparent` from the request context (since 0.97.11) |
| Configuration | [config/Configuration.ts](config/Configuration.ts) | A copy of the input Map |
| defineConfig / ConfigRegistry | [config/defineConfig.ts](config/defineConfig.ts), [config/ConfigRegistry.ts](config/ConfigRegistry.ts) | An immutable declaration and separate kernel views; the contract is in §7 |

The internal cancellation and timer range utilities are not public TS inputs.
The checks live in `test/kernel.audit-regressions.test.ts` and `test/fixtures/`.

## 3. DI and public surfaces

TypeScript entry: [index.ts](index.ts), alias `bazis/core/kernel`.
The described scope has no public HTTP/AI inputs.
The Kernel registers the infrastructure and the resolved configuration views:

| provide | Implementation | Dependencies | Lifetime / visibility |
| --- | --- | --- | --- |
| Environment | a value from the builder | kernel options / process env | singleton, global |
| Configuration | a value from the builder | config sources | singleton, global |
| ConfigRegistry | a value from the builder | declarations from the graph, Environment, Configuration | singleton, global |
| `definition.token` | a ConfigView from the registry | one declaration and the kernel's sources snapshot | singleton, global |
| ApplicationLifetime | a value from the builder | none | singleton, global |
| LOGGER | the chosen value | a user Logger or ConsoleLogger | singleton, global |
| EventBus | the existing resolver factory | the current container's ServiceResolver | singleton, global |
| HealthService | the existing resolver factory | the current container's ServiceResolver | singleton, global |

The historical `BazisKernelInfraModule` has no `exports` field; its open global surface
is kept. The registry and the views are registered as values; the existing codegen
wires the regular class dependencies. The explicit dependencies of diagnostic
factories apply only to synthetic test services, not to an alternative class binding.

## 4. Data and lifecycle

No own ORM entities, migrations, UI or AI are used. Since 2026-10-02 plan checks belong
to the relevant capability through `HostedService.planValidator`.
The Kernel gets an immutable array of the real hosted services, calls each unique
validator once per plan version and passes the startup signal. `validate(services,
signal?)` returns void or Promise<void>; an exception/cancellation aborts startup.
The field is optional, with no default and no null. The ORM implementations provide
their stateless validator automatically; the Kernel knows nothing about tables, ORM
phases or kinds of AI connectors. The `HostedServicePlanValidator` type is published by
DI next to HostedService; there are no new DI registrations. The lightweight Application
and startHostedServices apply the same check. The initial plan is checked before
onInit/start. A validator is a pure repeatable configuration check: a retry may call it
again for a plan with services already started.
A simple Kernel without validators keeps the regular order.
Checks: `lifecycle-plan.test.ts` and the existing ORM/Agent hosting regressions.

SupervisedHostedService supports services with their own planValidator and nested
supervised wrappers. The shared DI preparation first calls all factories and keeps the
first instances, then checks the full plan of real services before onInit and any
start. A factory only constructs the object; connections and work belong to start.
The repeated check and the first start use the same instance. A factory error during
preparation stops the startup without retries. The wrapper's own `planValidator` is
kept and delegates to the shared preparation; when wrappers are unwrapped it does not
replace the validators of the real services.

Without policy.phase the wrapper inherits the real service's phase after preparation;
before that the getter returns 0 without calling the factory. An explicit override is
kept for plans without validators. If any service of the plan has a validator, a
mismatching override is rejected before the check and the start: the old validator
contract reads service.phase and must see the actual phase. Real services are not
changed. The Kernel keeps the registration order within a phase; Application/helpers
still use the registration order without sorting phases.

After a start error the supervisor first stops the attempt successfully, then applies
maxAttempts/backoff and calls the factory again. The shared DI coordinator serializes
replacements, rechecks the full current plan and atomically accepts the candidate before
its start; the phase of the root position cannot change. The check includes the
candidate's new validators and keeps the real identities of the other services.
A factory/admission error, a cycle, a duplicate or cancellation stops this replacement.
Reusing the same instance after a successful stop is allowed; whether the instance is
ready for a new start is up to the service implementation. A stop error is not hidden:
an AggregateError holds the original start error and the cleanup error, and a new attempt
is forbidden. An external stop can still clean up the held instance.
Concurrent starts/stops of each kind share their operation; a start after a successful
stop creates a new run, and after a failed stop it is not allowed.

A direct supervised.start uses the same mechanism with a one-element plan.
An already aborted signal does not call the factory; cancelling an async validator does
not publish the candidate and does not allow a late start. The first check before any
effects and the repeatability of validators are different guarantees; unknown future
retry candidates are checked right before their start. Checks:
[supervised-plan.test.ts](test/supervised-plan.test.ts).

Cancellation stops waiting for and starting the next callbacks/handlers; arbitrary user
code that is already running cannot be stopped by force. Its Promise is observed so a
late rejection does not become an unhandled rejection. Hosted services get the existing
`AbortSignal`. The Coordinator checks an already aborted signal before resolving the
plan, then again right before `onInit`, `start` and `onBootstrap` inside their
microtask. So a cancellation between scheduling and execution does not run the callback.
A user `start` that finished successfully after cancellation, already started work and
ignores the signal still gets one `stop`.
Regressions: [lifecycle-cancellation.test.ts](test/lifecycle-cancellation.test.ts).

Cancelling an already started `onInit` or `onBootstrap` does not run `onDestroy` in
parallel with it. The Coordinator keeps the original Promise and first waits for it to
actually finish, then stops the started services in reverse order and cleans up hooks.
The Kernel releases the container after this sequence, so an unfinished hook keeps
access to its dependencies. `shutdownTimeoutMs` bounds the whole wait for rollback and
container release with one budget; 0 disables the limit. Running out of the budget gives
`ShutdownTimeoutError`, not a successful `stop`/`run`. A late completion continues the
real cleanup; a repeated `stop` keeps the original timeout. An endlessly hanging hook is
not considered cleaned up: `Bazis.run` performs the planned forced exit. An arbitrary
Promise is not interrupted by force.

A late hook rejection and `stop`/`onDestroy` errors are collected, and the other
available cleanup steps run; startup and cleanup errors are returned through an
`AggregateError` with the original startup error in `cause`. If the deadline has already
passed, a later cleanup failure is reported with the fixed `[bazis] startup.cleanup failed.`
without the error content. The internal `waitForRollback`, `rollbackFailure`,
`rollbackElapsedMs` link the Coordinator with the Kernel and register no new DI services.
`onStarted` and EventBus subscribers keep their behavior; they are not resource lifecycle hooks.

`RestartPolicy.onRetry` is a diagnostic notification before a retry, not a controlling
callback. A synchronous exception, a Promise/thenable rejection and an error reading
`then` do not stop the retry and do not replace the original startup error. The Promise
is observed but does not delay recovery. The failure shows as
`[bazis] supervised.onRetry failed.`; the original error is not serialized, and a failure
of the diagnostic sink itself is isolated.

A built Kernel keeps an independent copy of the unique `signals`. A repeated value in the
array does not create a second handler; changing the source array after build does not
change the Kernel. The first signal delivery starts a graceful shutdown; a separate next
delivery during shutdown keeps the immediate `exit(130)`.
Checks of these cases:
[kernel.repeat-audit-regressions.test.ts](test/kernel.repeat-audit-regressions.test.ts).

## 5. Changed inputs and results

These are trusted in-process TypeScript calls. `null` is not supported, strings are not
converted to numbers; unknown options fields are not used.

| Input / field | Type, source | Required / default | Check and result |
| --- | --- | --- | --- |
| `KernelOptions.startupTimeoutMs` | number, builder options | no; 30000 | An integer 0…2147483647 ms; 0 disables the deadline of the whole startup |
| `KernelOptions.shutdownTimeoutMs` | number, builder options | no; 10000 | The same range; 0 disables the shutdown deadline |
| `KernelOptions.signals` | readonly NodeJS.Signals[], builder options | no; SIGINT, SIGTERM | A snapshot of unique values is kept at build; an empty array disables the handlers |
| `useStartupTimeout(timeoutMs)`, `useShutdownTimeout(timeoutMs)` | number, argument | required | The same check at build; invalid → KernelError before config/DI |
| `Kernel.start()` | no input fields | — | Promise<void>; shared by repeated calls; the deadline includes notifications |
| `Kernel.run()` | no input fields | — | A shared Promise<number> and one set of process handlers |
| `Kernel.stop(request)` | object, argument | default `{exitCode:0}` | The shared stop operation |
| `request.exitCode` | number, exit code | required with an explicit request | Passed to the existing runtime; the range contract does not change |
| `request.signal` | string, signal name | no | Passed to the stopping event and shutdown hooks |
| `ApplicationLifetime.notifyStarted(signal?)` | AbortSignal, an internal kernel call | no | The wait and the remaining callbacks are cancelled; Promise<void> |
| `SupervisedHostedService.start(signal?)` | AbortSignal, the HostedService contract | no | The same signal is passed to inner; cancellation forbids the next retry |
| `PublishOptions.signal` | AbortSignal, a publish/publishScoped argument | no | Cancels the wait without starting the remaining handlers; the cancellation reason rejects publish even with isolate |
| `PublishOptions.handlerTimeoutMs` | number, argument | no; unlimited | The existing separate handler timeout; the order/isolate/onError fields are kept |
| `Configuration(values)` | ReadonlyMap<string,string>, argument | required | An own snapshot; values are strings, null is not supported |
| `ConfigDefinition.ensureValid(environment?)` | development / test / production | no; process env | A check without changing the declaration; a ready ConfigView checks that its environment matches |
| `ConsoleLogger.*(message, fields?)` | string and LogFields | message is required | Non-serializable fields are replaced with a fixed marker |

An event cancellation example: `await bus.publish(event, payload, { signal: controller.signal })`.
Event identity, the payload T, the log format and the handler registration policy stay
the existing contracts of [EventBus](events/EventBus.ts) and [Logger](logging/Logger.ts).
RestartPolicy keeps `maxAttempts` (3), `backoffMs` (100), `maxBackoffMs` (5000),
`onRetry?`; the default phase is inherited from the service, an explicit phase is checked
as described above. Cancellation is checked before the factory and after a failed attempt.

The startup error stays the main one if the cleanup finished successfully in time.
If the cleanup finished with a failure, the startup error stays in `AggregateError`/`cause`
together with the release errors; the public `stop` does not present such a rollback as
success. If the cleanup exceeded the deadline, a `ShutdownTimeoutError` with the original
error in `cause` comes out, so `Bazis.run()` performs the planned forced exit.
A regular startup failure is printed by `Bazis.run()` to stderr after the existing
`redactSensitive`: nested details are formatted explicitly without collapsing into
`[Object ...]`. Secret masking and the redaction depth limit are kept; formatting
supports BigInt and already anonymized circular references and does not call a user
`inspect`. The exit code stays 1.
Reading a declaration through `get()` and `ensureValid(environment)` does not fix the
environment and does not change future reads. The host uses a separate `resolve`, and
services use the view from DI/ConfigRegistry of their kernel.

## 6. Historical checks of the K01–K08 fixes

| Check | Result |
| --- | --- |
| Kernel, app/config, background, Infra | 121 PASS / 0 FAIL, 286 expect, 11 files |
| Including the new K01–K08 regressions | 27 PASS / 0 FAIL |
| TypeScript of the kernel and its imported dependencies | PASS, `tsc --noEmit -p tsconfig.kernel.json` |
| TypeScript of the whole `src` when K01–K08 were fixed | PASS, exit 0; intermediate WebSocket errors are kept in the report |

The checked commands and logs are recorded in the
[fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-fixes-2026-09-14.md).
Physical PostgreSQL/container checks do not apply to these changes.
These results refer to the K01–K08 fixes and do not confirm the implementation of §7.
The public constructor dependencies and generated contracts did not change when the
architectural decision was recorded. The transitional config state is described below.

<a id="config-isolation-decision"></a>

## 7. The accepted decision: configuration per kernel

Basis: the owner's decision of 2026-09-14 and
[MOD-ARCH-001 §5.4](../../../../docs/architecture/MODULE_ARCHITECTURE.md#kernel-config-isolation).
Status: implemented; checked in the sources and in a built binary.

The implementation contract is aligned with the current Infra/config work:
`Configuration` holds the sources snapshot, `ConfigRegistry` the views by declaration
identity. `ConfigRegistry.get(config)` returns one typed `AppConfig<T>` of the current
kernel. `defineConfig` returns an immutable `ConfigDefinition<T>` with
`resolve(environment?, configuration?)` and the `token` DI token. Validating a
declaration does not change its state.
A declaration's direct `get/has` are kept for separate calls outside a kernel and read
the current process env without a shared cache; services get `definition.token` through
the existing DI or use `ConfigRegistry.get`.
A user `AppConfig.resolve(environment?, configuration?)` may build its own independent
view; older objects with only `ensureValid` stay validators, and their author is
responsible for having no mutable shared state in them.

Sources are set with the existing `KernelBuilder.addConfigSource`, the environment with
`useEnvironment`. The full sources contract is in [config/README.md](config/README.md).
`InfraConnector.create(configs?: ConfigRegistry)` gets the owner of the values; a call
without an argument stays a standalone scenario. The application's JWT configuration is
assembled by a factory when TokenService is resolved through DI, not on file import.

A module owns the shared immutable configuration declaration. The Kernel owns the chosen
environment, the snapshot of resolved values and the cache. One declaration must support
several kernels in one process without manual copying by the consumer. Resolution and
checks do not change the declaration or a neighboring kernel.

The responsibility stays inside the existing `config/defineConfig.ts` and
`KernelBuilder`. The transition affects collecting `@Module.config`, the `runApp` host
composition, DI consumers and Infra connectors: all of them must use the view of the
corresponding kernel. Typed reading, source priorities and `Secret` are kept; the exact
signatures are described above.

The temporary ban on reusing a declaration is lifted. The K07 regression now checks a
successful build of two kernels and independent reading of their views.
Checks of services, Infra, deferred LLM profiles, JWT and the composite session
protection config were added. The registry calls the composite config factory once for
its kernel; the session protection adapter gets exactly that result.

Result of the focused run: **225 PASS / 15 SKIP / 0 FAIL**, 653 expect, 30 files.
Twelve new isolation checks live in kernel, auth and session.
TypeScript of the affected area, codegen and the binary checks passed.
The state of the overall TypeScript and the SKIP composition are listed in the
[report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).
