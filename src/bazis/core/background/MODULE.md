# Background

Passport version: 1. Date: 2026-10-04. Status: partial passport of the existing
implementation. Type: atomic technical module. Path: `src/bazis/core/background`.
Connection point: [backgroundModule(config)](backgroundModule.ts); public
entry: [index.ts](index.ts). Scope: isolation of diagnostic callbacks on errors
and restarts; a full audit of the other options/lifecycle is out of scope.
The original creation command is unknown; no new scaffold was created.

## Responsibility and components

The module runs long or periodic work through the existing HostedService.
BackgroundService owns cancellation, the running task and a bounded number of
restarts; PeriodicBackgroundService owns sequential ticks. DI, ORM, HTTP, data and
the task's external effects belong to the consumer. No parts, own container or
persistent storage are used.

| Component | Input and responsibility | Result |
| --- | --- | --- |
| [BackgroundService](BackgroundService.ts) | execute(signal), restart policy | Execution and restarts with backoff |
| [PeriodicBackgroundService](BackgroundService.ts) | intervalMs, tick(signal) | Sequential ticks without overlap |
| [Background](decorator.ts) | Metadata options | Class settings; an explicit super(options) wins |
| [delay](delay.ts) | ms, signal? | A pause that ends early on cancellation |

The classes, inheritance and simple internal functions are kept; there are no new
layers, dependencies or DI tokens. Observer error handling is separate from task
control. Each failure adds bounded work to observe the callback result; no
performance improvement is claimed.

## Diagnostics (since 0.97.10)

Failures the service handles itself go to the application logger: the kernel
passes it through `HostedService.useDiagnostics` before start (also through
`SupervisedHostedService`). One line per event, the class name in `service`,
the error redacted: `background <Name> crashed`, `... tick failed`,
`... stopped after N restarts and will not run again` (or `... after a crash
... (no restart policy)`), and the warning `... did not stop within Nms:
shutdown continues, but its unfinished work keeps the process alive until it
ends`. Without a logger the same text goes to the console as
`[background:<Name>] ...`. Subclasses report their own failures with the
protected `reportFailure(message, error, fields?)`.

## Connection and DI

`backgroundModule({ services })` registers the classes as singletons and publishes
each through the existing enumerable HOSTED_SERVICE. The historical factory has no
imports and no explicit exports; its former visibility is kept. Regular codegen
wires the service constructors. Example and types: [backgroundModule.ts](backgroundModule.ts).
Environment configuration, ORM, schema and migrations are not used here.

## Changed diagnostics contract

| Input | Type / default | Execution and errors |
| --- | --- | --- |
| `restart.onError` | `(error: unknown, restarts: number) => void`; optional, null is not supported | Called for every execute failure before the retry decision. A synchronous observer error is isolated |
| `onTickError` | protected `(error: unknown) => void`; default is safe logging | A tick failure is observed, then the schedule continues; an observer error is isolated too |
| An unexpectedly returned Promise/thenable | Does not extend the synchronous public contract | The rejection is observed without waiting; it does not stop the loop and does not become an unhandled rejection |

An observer error is logged with the existing secret masking. An error of the
diagnostic sink itself is isolated too. The observer does not decide task success:
the execute error is still handled by the existing restart policy. The final error
of the internal supervisor is additionally observed at start. The public start
stays non-blocking, and stop keeps the existing grace period. Forced cancellation
of arbitrary user code was not added.

An async observer is not awaited and is not part of the service shutdown; the
contract is meant for short synchronous notifications. The module does not
guarantee external effects, retries of the logging itself or the completion of a
hung callback.

## Checks and limits

[background.test.ts](test/background.test.ts) checks that three runs are kept with
maxRestarts=2 for a sync throw, a Promise rejection, a thenable rejection and a
broken console.error; the secret never appears in the log. Periodic ticks are also
checked to continue on sync/async onTickError failures. The existing lifecycle, DI
and masking checks are kept.

The R7 fix needs no codegen, new resources or dynamic imports. A regression
fixture built with `bun build --compile` checked three task runs on a sync throw
and a Promise rejection of the diagnostic callback; the binary ran outside the
project. Commands and results are in the
[fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-reaudit-2026-10-04/FIXES.md).
The database, load tests and production were not involved.
