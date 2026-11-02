# StandardToolsModule

Passport version: 1.0. Check date: 2026-11-03.
Status: implemented for §7 of [WORKFLOW-002](../../../../docs/architecture/WORKFLOW_BUILDER.md); checks below.
Type: atomic.
Path: `src/bazis/core/tools`.
Connection point: [StandardTools.module.ts](StandardTools.module.ts), class `StandardToolsModule`; public entry `bazis/core/tools`.
Scaffold creation: framework module, written by hand.

## 1. Responsibility

Tools that come with the framework and work only when an application asks for
them. What is outside: the Tools of an application's own operations, and
deciding what is open: nothing is open by itself.

## 2. Parts

| Part | Where | Depends on | What it does |
| --- | --- | --- | --- |
| `ormEntityTools` | [orm/ormEntityTools.ts](orm/ormEntityTools.ts) | `core/agent`, `core/orm`, `core/di` | Makes Tool classes at run time with a JSON Schema contract; they check their input themselves |
| `HttpRequestTool` | [http/HttpRequest.tool.ts](http/HttpRequest.tool.ts), [http/publicAddress.ts](http/publicAddress.ts) | `core/agent`, `core/kernel` | `http.request`: closed list of hosts, public addresses only, limits |
| `SecretStore`, `ConfigSecretStore` | [secrets/SecretStore.ts](secrets/SecretStore.ts) | `core/kernel` | Values of `$secrets.NAME`; the process engine asks for them, this module only provides them |
| `OrmEntityReferences`, `OrmFieldReferences` | [orm/OrmEntity.references.ts](orm/OrmEntity.references.ts) | `core/access`, the Tool catalog | Reference kinds `orm.entity`, `orm.field`: what `ormEntityTools` opened |

## 3. Data

No tables: the Tools work with the application's own context.

## 4. Checks

`test/workflow.postgres.tools.live.test.ts` on PostgreSQL: contracts, partition, open fields, limits, dry run, setup errors, reference kinds.
`test/tools.http.test.ts`: the list of hosts, addresses, limits, redirects, statuses, trial.
`test/workflow.postgres.secrets.live.test.ts` on PostgreSQL: `$secrets` and `http.request` in a process, nothing kept.
