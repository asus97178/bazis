# Configuration contracts

Date: 2026-09-14. Contracts per MODULE_ARCHITECTURE §5.4.
A component of the existing kernel; no new architectural module is created.

Isolation of the views of each kernel, its services and connectors is implemented and
checked: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).

`defineConfig` returns an immutable `ConfigDefinition<T>` declaration.
The `default`, `development`, `test`, `production` fields are kept. Additions:

| Input | Type / default | Rule |
| --- | --- | --- |
| `env` | Optional map of local key → name or array of names | Explicit extra BAZIS_* names; the canonical name is accepted too; different values in one source are an error |
| `validate` | Optional map of key → `(value) => string \| undefined` | Synchronous domain check; a string is a safe error description without the value |
| `configEnum(values, defaultValue)` | A non-empty readonly array of strings or numbers, the default taken from it | Restricts both the TS type and the runtime env; needed for fields with a literal union |
| `resolve(environment?, configuration?)` | Environment; an immutable Configuration | Creates an independent ConfigView; without sources it snapshots BAZIS_* at call time |
| `token` | InjectionToken<ConfigView<T>> | The kernel registers the view in the existing DI for every declaration from Module.config |
| `ConfigRegistry.get(definition)` | A declaration from the current kernel's graph | Returns the one view of this kernel; an unknown declaration is an error |
| `AppConfig.resolve(environment?, configuration?)` | Optional factory of a user declaration | A composite config builds its own independent view from the kernel snapshot; all its consumers use the same result |
| `ConfigView.inspect()` | No arguments | Key, type, allowed env names, source and a safe value; a Secret is always `***` |

Default → environment section → sources snapshot. Kernel sources are merged in
registration order; if no list is given, env and then CLI args are used.
Flat Configuration key names are case-insensitive. A later source also wins
between the canonical name and an explicit env alias.
Numbers are finite; an empty string never becomes zero; a Secret does not allow an
empty or whitespace value. TypeScript forbids unsupported object types.

A declaration stores no chosen environment, values or cache. `get/has/ensureValid`
stay for standalone reading of the process env, but `ensureValid` no longer
switches later reads. Host code gets `resolve`, a service injects
`definition.token`, a connector gets `ConfigRegistry` as the create argument.
All built-in connectors use this argument; a custom connector reads
`configs?.get(config) ?? config`. A direct global get inside a service does not
read the settings of its kernel.

A custom configuration with nested values, for example a set of session protection
keys, implements `resolve(environment, configuration)` if the values depend on the
run. The factory returns an immutable `AppConfig` and does not change the
declaration. Older objects with only `ensureValid` stay compatible as
validators/ready values; their author is responsible for having no mutable shared
run state. The session protection adapter also reads the registry view.

The kernel collects the errors of all declarations before creating DI clients. An
error in one kernel does not change the other views. The historical activeStand
guard is removed only together with the regressions for two kernels, sources,
secrets and connectors.

Health: `HealthService.check(options?)` / `Kernel.health(options?)` accept
`timeoutMs` (the whole report, default 5000), `checkTimeoutMs` (one check, default
1000), `concurrency` (default 4) and an optional `signal`. Numbers are positive
integers, timers up to 2147483647 ms, concurrency up to 1024. Results come in
registration order. `HealthCheck.check(signal?)` gets the cancellation; a timeout
or an exception gives unhealthy. Expired checks that have not started are not run.
This bounds the wait; a custom check must honor the signal to stop its own work.
Diagnostics go through the existing redaction.
Concurrent reports of one HealthService share one operation per singleton
check instance. Cancelling one report does not abort the others.
When all waiters finish, the operation's signal is aborted. If the operation keeps
hanging, repeated reports give unhealthy until it actually finishes, without starting
duplicates. The next call after it finishes runs a fresh check.
