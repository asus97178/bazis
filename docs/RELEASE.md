# Release history and the former Osnova candidate procedure

This document is a history from the time when the framework and the osnova application
lived in one repository; the commands and paths below refer to that layout. Current osnv
releases follow [CHANGELOG.md](../CHANGELOG.md) and the tag-triggered `publish` job in
[ci.yml](../.github/workflows/ci.yml). The procedure was recorded on 2026-10-02 while
preparing **0.95.0**. That is the SemVer number of the requested version "0.95", not a
version of the HTTP API, database schemas or wire protocols. A number in the sources does
not by itself confirm that checks passed or that a release happened. At that time the
repository had no automatic publish/tag workflow, and both packages were private.

## Starting state and boundaries

When working on top of uncommitted changes, first save a separate snapshot of the
current sources, their SHA-256, HEAD and Git status. A clean HEAD does not replace this
snapshot. Do not include credentials, working env, databases, runtime data, node_modules,
binaries or caches. Make fixes in a separate copy; build the final diff from the saved
state, and do not claim earlier changes of the checkout as your own.
Do not apply reset/clean/stash to someone else's tree. Integrate only the agreed list of
files after rechecking the original hashes and an independent review.

## Versions and dependencies

Align `package.json` and `src/osnova/package.json`, then the active application metadata
in `src/index.ts` and the Codex `clientInfo.version`.
The admin-ui/client-ui packages have an independent version `0.1.0`.
Do not change API/schema versions, historical reports or example versions automatically.

Use the qualified Bun from the [toolchain](../toolchain/README.md).
Bumping the version without Git operations:

```sh
./scripts/osnova-bun --no-env-file pm version 0.95.0 --no-git-tag-version --allow-same-version
# The same command in src/osnova, through ../../scripts/osnova-bun.
./scripts/osnova-bun --no-env-file install --lockfile-only --ignore-scripts
```

Check the resulting `bun.lock`: the versions and integrity of external packages must
stay the same. Bun 1.4.0 may leave an old version of an unused workspace when the
graph does not change. In that case, in an isolated copy temporarily add the root
dependency `osnova: "workspace:0.95.0"`, run the same lockfile-only command, restore the
original manifest and run the command again.
The temporary local dependency does not stay in the result. Do not use `--force`: it
requests fresh versions of external dependencies. Do not edit generated TypeScript and
the lockfile by hand. The `pm version` behavior is described in the
[official Bun documentation](https://bun.com/docs/pm/cli/pm#version).

## Check sequence

Before running, check that the commands exist in `package.json`. All commands run with
an explicit `OSNV_BUN_BIN`, without working env and provider credentials. The shared
codegen and the test servers have one owner; do not run them concurrently.

1. `toolchain:check` and `di:generate --target all`.
2. `build`: production codegen and the full TypeScript `tsc --noEmit`.
3. `test`: the project pretest/codegen and the full isolated suite. Do not count SKIP of
   physical PostgreSQL/Redis tests as a successful infrastructure check.
4. `admin:ui:check`, `admin:ui:build`, `client:ui:build`. Both UI builds run the
   installed `vue-tsc --noEmit` through a real Node ≥22.12 and only then Vite. Bun 1.4.0
   bypasses the needed hook and may let Vue SFCs through without an error.
   If needed, the Node path is set through `OSNV_VUE_NODE_BIN`.
5. `build:bin` creates `bin/osnova-app` and `bin/osnova`. Run both outside the checkout:
   the app with `config check --environment=test`, the CLI with `--help`, and check the
   affected runtime paths with a separate controlled compiled fixture.
6. Check the public API/barrels and the portability of the framework package: public
   smoke/boundary tests, creating a portable CLI project; when packing, only
   `pm pack --ignore-scripts`, without publishing. Check the version inside the artifact.
7. For every defect keep the original FAIL reproduction and the fixed PASS.
   Run physical checks only on your own temporary services and check the cleanup.
   UI: late responses, session changes, the HTTP target of actions and accessibility.

The current manifests have no lint script: state its absence explicitly.
Results, commands, SHA-256 of sources/artifacts and limits are recorded in the report
of the specific candidate. Historical PASS results are not carried over as new ones.

## 0.95.0 defaults migration

- Production bootstrap of the first administrator is closed until the installation
  Secret is configured and `X-Osnova-Setup-Token` is confirmed. The operator delivers
  the secret through a protected configuration source, not through argv/URL, and sends
  the header with their trusted HTTP client. Do not write the value to logs/shell
  history, do not commit it. After installation the existing persistent bootstrap
  marker is kept; remove the no longer needed installation secret. The procedure does
  not create or store a real value automatically. The contract and the conditions of a
  local development/test setup: [AdminAuth](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/actor_modules/admin_modules/auth_module/MODULE.md).
  A local reverse proxy is seen as a loopback peer: with external access to dev/test
  the installation Secret is needed as well, or the setup must be closed by the network.
- The client cookie gets Secure in production. With TLS termination the operator sets
  the exact external origin shared by HTTP and WS. Arbitrary forwarded headers are not
  trusted. Local HTTP uses development/test or a deliberate operator setting:
  [ClientAuth](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/client-auth/MODULE.md).
- The launcher allows 15 seconds for shutdown by default. With a larger kernel budget,
  align `OSNV_BUN_SHUTDOWN_TIMEOUT_MS`: [toolchain](../toolchain/README.md).
- The SMS endpoint must accept a final POST without redirects. Redirects end with an
  error: [SMS](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/sms/MODULE.md).
- Admin UI and OpenAPI ship together: the UI takes the allowed sorts from
  `x-osnova-sort-fields`; without the metadata it offers no unknown fields.
- Auth limits requests before parsing the body; administrative operations have a
  per-process concurrency limit. Clients behind one proxy share the limit of its
  direct IP. The values and the 429 behavior are described in the passports of
  [AdminAuth](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/actor_modules/admin_modules/auth_module/MODULE.md)
  and [ClientAuth](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/client-auth/MODULE.md).
- After the upper length bound is exceeded, the framework skips the content checks of
  the same decorator, so the error array is shorter. Separate pattern/custom checks
  stay the author's responsibility: [validation](../src/osnv/library/validation/SPEC.md).

## Readiness decision

Assess separately the framework, the application with external dependencies, the
admin/client UI, the sources, the packed framework and the binaries. List the unchecked
platforms and real providers. Even a full local PASS does not mean absolute security or
a check of the production environment. Tag, push, publish and accepting someone else's
baseline are not part of preparing a candidate and need a separate decision.

## Removal of manual HTTP binding (2026-10-03, a change after the 0.95 candidate)

Breaking change: `@Bind` and its descriptors `Param`, `Query`, `Body`, `Header`, `Req`,
`Res`, `Ctx`, `FromServices`, `List`, the aliases `FromRoute`, `FromQuery`, `FromBody`,
`FromHeader` and `ValueBindingOptions` were removed from the public HTTP API.
Remove their imports and decorators. Regular codegen infers the parameter sources:

```ts
@Put("tables/:table/validators")
replace(table: string, input: ReplaceValidatorsRequest) { /* ... */ }
```

`table` comes from the route, the DTO from the JSON body with the same validation as before.
Read headers and arbitrary bodies through `ctx: HttpContext`; inject services into the
constructor. For a query default use the method parameter default; for lists use a
`ListRequest` subclass with `Sortable`/`Filterable`/`ListOptions`.
After the migration run `di:generate --target all` and the typecheck.
`@RequestModel()` stays for compatibility; regular generation handles the DTOs of the
current application without it. The binding runtime and generated descriptors are kept.
Generation additionally publishes the `ReplaceValidatorsRequest` and
`ValidatorRuleRequest` schemas in OpenAPI; routes and validation rules do not change.

This source change does not update the previously approved tarball. A new artifact and
moving Docs to it need a separate check and an agreed step.

The collision of a consumer `UsersController.list()` with the old binding map of the
source application is fixed. Codegen writes an empty descriptor for methods without
parameters, the runtime uses only the concrete target class, and the package
compatibility map no longer holds application metadata.

## Qualification on live PostgreSQL (2026-10-04, a change after the 0.95 candidate)

The physical check runs with one command on a throwaway PostgreSQL 17 with TLS:

```sh
python3 ops/live-postgres/runner.py <directory-outside-the-repository>/<run-name>
```

The runner runs the full suite and every gated live suite in its own database, checks
that no sessions remain and removes the container. The native Bun.SQL cancellation is
marked as a known external defect and is not counted as PASS. The Redis suites need a
durable server configuration (`appendonly yes`, `appendfsync always`,
`maxmemory-policy noeviction`). Results: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/release-0.95-live-postgres-2026-10-04/REPORT.md).

Behavior changes:

- A new key `db.tlsCa` (`OSNV_DB__TLS_CA`): the PEM of an extra CA for
  `db.tls=verify-full`; empty means system trust only. In the ORM connector an empty
  `tlsCa` now means "no CA set" instead of a configuration error.
- The Kernel, `Application` and the hosted helpers start a singleton that several
  `HOSTED_SERVICE` registrations point to only once. A module with several
  `ownedStore` contexts now starts.

## Release 0.96.0 (2026-10-04)

An incremental release on top of the 0.95.0 candidate. The version is aligned in
`package.json`, `src/osnova/package.json`, `bun.lock`, the `src/index.ts` metadata,
`src/admin-ui-dev.ts` and the Codex `clientInfo` (including `ops/codex/check-skills.ts`).

Changes since 0.95.0:

- `db.tlsCa` / `OSNV_DB__TLS_CA` for production `verify-full` with a private CA;
  an empty `tlsCa` in the ORM connector means "no CA set".
- A singleton with several `HOSTED_SERVICE` registrations starts once;
  a module with several `ownedStore` contexts starts in the kernel.
- `build:bin:*` compile through `scripts/build-bin.ts`: the launcher no longer leaves
  undeletable `.bun-build` files in the checkout.
- Removed the manual `deps` that duplicated codegen in DataManager; an explicit
  `exports: []` on `AdminDeveloperTools`; passports of the DataManager/Admin roots and
  of the Access, DeveloperTools, Observability parts.
- Physical qualification: `ops/live-postgres/runner.py`.

Migration: no action needed; `OSNV_DB__TLS_CA` is optional.

## Release 0.96.1 (2026-10-04): the `osnv` package

The framework was turned into a publishable npm package for Bun. It ships TypeScript
sources, no JavaScript build is needed; it runs only on Bun ≥ 1.4.0.

- The package name `osnova` was replaced with `osnv`: on npm `osnova` is taken by another package.
  Generated code and CLI templates import the framework by the package name
  (`osnv/core/di`), not through the `@osnova/*` and `@/*` aliases. A new project from
  `osnv new` has no `paths` in `tsconfig.json`; the snapshot lives in `vendor/osnv`.
- Manifest: `private` removed; `license: MIT`, `bin: osnv`, `engines.bun >= 1.4.0`,
  `peerDependencies.typescript` added (needed only by codegen and the CLI; the runtime
  has no external dependencies). Tests and fixtures are excluded from the package
  (537 files, 0.92 MB instead of 792 and 1.47 MB).
- The `@/…` self-imports in `core/agent/session` were replaced with relative ones.
- `scripts/package-check.ts` (part of `run ci`): pack → install into an empty project →
  `osnv new` → codegen → module → typecheck → `/health`.

Migrating an existing application: the dependency `osnova` → `osnv`, the `tsconfig`
paths `osnova/*` → `osnv/*` (the `@osnova/*` aliases may stay for your own code), then
`di:generate --target all`: the generated files import `osnv/...`.

CLI 0.96.1: all commands are called as `osnv` (`bunx osnv …`; in this repository
`./scripts/osnv-bun run osnv …`, the CLI binary is `bin/osnv`). New commands:
`osnv dev`, `osnv build`, `osnv build --bin [--outfile]`; the scripts of a created
project wrap them. `g module --full` no longer needs an application auth module:
without it the routes are generated public with a warning.
`agent run` moved into the application (`bun run agent:run`).

Also in 0.96.1: `osnv codegen` calls the framework generator directly (the project no
longer needs a `di:generate` script); `osnv dev --watch`; `osnv test`; a warning at
startup from sources changed after codegen (`src/generated/osnv/fingerprint.ts`). A new
project gets the `test` and `start` scripts, `.env.example`, a `/health` test and `HOST`;
the `vendor/osnv` copy matches the npm package contents.

`osnv dev` starts the application with `OSNV_ENV=development` if the variable is not set
in the shell (before, without `.env` the application started as `production` and
required production secrets). The package README was rewritten in English.
The `examples/todo` example was added (project, task, report modules; PostgreSQL with
auto-migration, cross-module DI, validation, JSON:API, an e2e test, a binary);
`run ci` builds it as a user would (`example install/build/test`), and the e2e test runs
when `OSNV_DB__HOST` is set, otherwise it is marked skip.

Finished before the release:
- ORM: a unique index violation in `saveChanges()` arrives as `UniqueViolationError`
  (`constraint`, `table`, `cause`) instead of a raw driver error and HTTP 500.
- ORM: only the module decides table creation and migration (`ensureCreated` or
  `migrateOnStart` in `ormOsnv`). The `@Entity({ migrate: true })` flag was removed:
  `migrateOnStart` now migrates all entities of the module's context.
- HTTP: request body fields declared as `string`/`number`/`boolean` are checked
  against the JSON type without `@Validator` (400, code `type`). gRPC and agents are
  not affected.
- CLI: names follow the module as it was typed. `g module Stats` creates the files
  `<Module>.<role>.ts` (`Stats.module.ts`, `Stats.controller.ts`, `Stats.service.ts`,
  `IStats.service.ts`, `Stats.model.ts`, `Stats.dbContext.ts`, `Stats.requests.ts`,
  `Stats.responses.ts`, `StatsList.query.ts`) and the role classes `StatsModule`,
  `StatsController`, `StatsService`, `StatsDbContext`. The record and its DTOs stay
  singular (`Stat`, `CreateStatRequest`, `StatResponse`).
  Before: `Stat.module.ts`, `StatController.ts`, `StatService`.
- Built-in framework texts and CLI templates are in English. Russian sets:
  `RU_VALIDATION_MESSAGES`, `RU_CODEX_MESSAGES`, `RU_UI_LABELS`. The application
  connects them at startup. Configuration errors and the agent prompt headings are
  English only.

Only the `index.ts` entry point stayed in the `src/` root. Helper scripts moved to their
owner modules (the `bun run …` commands are the same):
`admin:token` → `src/app/modules/auth/AdminToken.cli.ts`, `agent:run` →
`src/app/modules/agent-chat/client/AgentRun.cli.ts`, `config:check`/`config:inspect`
→ `src/app/config/ConfigCheck.cli.ts`. Removed: the stub of the dropped Workflow feature
(`src/system-workflow-producer.ts`) and the separate admin dev backend (`admin:backend`,
`AdminUiDevModule`, the `http.admin*` settings and the `OSNV_ADMIN_*` variables): it
started an outdated set of modules without DataManager.
The Admin UI is developed with the regular `bun run dev` + `bun run admin:ui`.

Names: the framework is called `osnv` everywhere (the application stays `osnova`).
Renamed: the public API (`OsnovaModuleRef` → `OsnvModuleRef`, `ormOsnova` → `ormOsnv`,
`ormOsnovaConnect` → `ormOsnvConnect`, `registerOsnovaGeneratedRuntime` →
`registerOsnvGeneratedRuntime`, `OsnovaSocket` → `OsnvSocket`, the kernel class
`Osnova` → `Osnv` and so on), the package folder `src/osnova` → `src/osnv`, the alias
`@osnova/*` → `osnv/*` imports, `scripts/osnova-bun` → `scripts/osnv-bun`, the toolchain
schema `osnv.bun-toolchain/v1`. Data identifiers: the tables
`__osnv_orm_owned_stores_v1`, `__OsnvMigrations`, the contracts `osnv.orm-owned-store/v1`,
`osnv.agent-execution-state/v1`, `osnv.websocket.publication/v1` and others; the
owned-store golden bytes were recomputed and provably differ only in the domain.
Databases that already have `__osnova_*` tables must be migrated by hand (the osnova
application has none).

Migration: validation messages, configuration errors, Codex texts and UI labels are
English by default; to keep the old behavior connect the Russian sets, and update tests
that compare these texts. `RequestModelFieldShape` became a union (`model` or `primitive`).
