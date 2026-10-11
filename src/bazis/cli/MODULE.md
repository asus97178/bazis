# bazis CLI

Passport version: 1.10. Check date: 2026-10-06. Type: atomic technical module.
Scope: command parsing, project and module generation, host registration, codegen,
running the application and building (`bazis dev`, `bazis build`, `bazis build --bin`).
Entry point: [main.ts](main.ts), the `runCli(argv, runtime)` function.
The CLI runs as a separate process and is not registered in `AppModule`.

## Running and building

```sh
bunx bazis dev                         # codegen, then src/index.ts from sources (BAZIS_ENV=development if not set)
bunx bazis dev --watch                 # the same; a change in src/ restarts codegen and the application
bunx bazis test [<bun test arguments>]  # codegen, then bun test
bunx bazis build                       # codegen and a type check (tsc --noEmit)
bunx bazis build --bin                 # + the executable bin/<name from package.json>
bunx bazis build --bin --outfile dist/app
bunx bazis build --bin --dotenv        # the executable also reads .env files from its working directory
```

Implementation: [build.ts](build.ts). The entry point comes from `bazis.config.json`
(the first entrypoint of the default target), TypeScript from the project's `node_modules`.
With TypeScript 7, which has no compiler API, codegen and module registration load the
TypeScript 6 API from `@typescript/typescript6` (`core/scripts/typescriptApi.ts`, preloaded into the
codegen process); without it they stop with `BAZIS_TYPESCRIPT_API_MISSING`.
`dev` forwards SIGINT/SIGTERM to the application and returns its exit code.
`dev --watch` watches `src/` recursively (except `src/generated`, otherwise codegen
would restart itself), merges events within 150 ms, stops the application, reruns
codegen and starts again; on a codegen error it waits for the next change. `test`
passes everything after `test` (or `test --`) to `bun test`.

`codegen` runs the framework generator directly; no project script is needed: first
`node_modules/bazis`, then the `src/bazis` source (a framework checkout), then the CLI's
own package. The generator writes `src/generated/bazis/fingerprint.ts`: the list of the
target's sources, their SHA-256 and the `bazis` version. The generated `runtime.ts`
checks them at startup from sources and warns loudly if the code or the framework
version changed after generation (about 10 ms for 750 files). A binary has no sources,
so the check is skipped. In the framework repository `fingerprint.ts` is not committed:
it changes with every source edit.
`build --bin` compiles from a temporary directory (`compileBinary`): Bun 1.4.0 leaves
`.bun-build` in the working directory if its executable is read-only or has the `uchg`
flag. The Bun for child processes is `scripts/bazis-bun`, otherwise `BAZIS_BUN_BIN`,
otherwise `bun` from PATH.
Since 0.98.29 the executable does not read `bunfig.toml` from the directory it starts in
(`--no-compile-autoload-bunfig`: a `preload` there would run foreign code inside the
application) and, unless built with `--dotenv`, does not read `.env`, `.env.local`,
`.env.<NODE_ENV>` either (`--no-compile-autoload-dotenv`): a binary gets its settings
from the real environment. `bazis dev` and `bazis test` run from sources and still
read `.env`. `bazis new` ignores `.env` and `.env.*` in git, except `.env.example`.

The `agent run` command (a client of the application chat API) moved into the osnova
application: `bun run agent:run` and `src/app/modules/agent-chat/client/AgentClient.service.ts`.
The framework knows nothing about the addresses and cookies of a concrete application.

## Responsibility and components

The CLI creates scaffolds per [MOD-ARCH-001](../../../docs/architecture/MODULE_ARCHITECTURE.md).
By the mandatory rule of §8.1, all new application and framework modules, including
composite roots and their atomic parts, are created with CLI commands. The author
adapts the created scaffold, fills in the passport and records the actual creation
command. If the needed variant is missing or the generator is wrong, the CLI is
improved first. Creating or copying a scaffold by hand instead of the CLI is forbidden.
The domain CRUD fields are the learning `name`/`email`; the author replaces them and
updates the passport. `full` stays an atomic module. `pack` holds independent empty atomic parts.

**Agent/Module transition:** per [AGENT-ARCH-001](../../../docs/architecture/AGENT_ARCHITECTURE.md)
agents are created separately from modules. The current `--full` still generates an
AnalystAgent inside the module and the `@Module.agents` field; this is a known mismatch
with the target architecture. Separating the generation is part of the first stage of work.
There is no separate agent generation command yet. The tables below describe the
current CLI; the `--full` template was not changed by this step. AgentsModule was
created with the regular `--empty`.

Project OpenAPI codegen now takes inherited DTO properties into account, including an
empty RequestModel subclass of an imported input contract. Validators come from the
source declarations of the base class. Without inheritance the former fast path of
analyzing members is kept. The fix is in the [OpenAPI analyzer](../library/openapi/codegen.ts)
and is called by the regular [di-generate](../core/scripts/di-generate.ts); only the
generator updates the result.

Agent schemas (R4, 2026-10-04) use the same OpenAPI analyzer naming function for the
real declarations of input/output DTOs. Schema selection keeps the inputs/outputs of
Agent, Task, Tool and their references; the constructor → schema links of root and
nested class DTOs extend the existing `GENERATED_OPENAPI_SCHEMA_MODELS`.
An unrelated interface with the same name no longer loses the class schema.
A linked class DTO that cannot be imported is rejected with
`BAZIS_AGENT_SCHEMA_MODEL_UNIMPORTABLE` before generated files are written.
The Agent collector's existing limits on ambiguous class names and named exports are
kept. The public commands and input DTOs of this CLI do not change.
The [Agent standalone integration](../core/agent/test/agent.standalone.integration.test.ts)
check runs real codegen, typing, source and binary for a copy of the package outside the checkout.

DI codegen (D3, 2026-10-02) stores classes by their exact TypeScript declaration, so
services with the same name in different files of one target are allowed. The generated
descriptor gets unique import aliases for the concrete constructors; export
alias/default and renaming imported dependency types through a re-export are supported.
The existing DI wires named dependencies within the module's visibility. Two visible
named tokens with the same name stay an explicit ambiguity, and private tokens of
different modules are not mixed. The TypeScript program and the target pipeline stay
shared; no runtime compiler is added. Exported dependency classes, including Lazy, are
passed as exact constructor tokens: renaming during bundling does not change identity.
Interfaces/IRepository stay named; the runtime also accepts the older string
descriptors. Check: `di-class-identity.integration.test.ts` runs generation, typing,
DI and a compiled application from another cwd.

DI codegen also infers the dependencies of an inherited constructor with generic
parameters substituted and binds them to the concrete subclass. An own constructor and
explicitly set deps keep priority. Local non-exported helpers are skipped; a private
class in a regular DI registration without its own metadata gets
`BAZIS_DI_CLASS_UNIMPORTABLE` before generated files are written. Exporting the class or
its alias is enough to continue with the regular automatic binding. Details and the
binary check are in the [DI passport](../core/di/MODULE.md).

| Component | File | Input | Output / effect |
| --- | --- | --- | --- |
| `parseCliArgs` | [parseCli.ts](parseCli.ts) | `readonly string[]` | A command, help or an error; no I/O |
| `generateProject` | [generateProject.ts](generateProject.ts) | Name, path, local framework package, dry-run | A separate starter project or a file plan |
| `parseModuleName` | [naming.ts](naming.ts) | The name string | Names of directories, classes, the route and the table |
| `generateModule` / `generateModulePack` | [generateModule.ts](generateModule.ts) | Generation options | A file plan; writes it unless dry-run |
| `registerModuleInSource` | [moduleRegistration.ts](moduleRegistration.ts) | Host source, absolute paths, class | TypeScript with the import and registration |
| Templates | [templates/module.ts](templates/module.ts), [templates/pack.ts](templates/pack.ts), [templates/passport.ts](templates/passport.ts) | The normalized name and profile | Files and `MODULE.md` |
| `runCodegen` | [codegen.ts](codegen.ts) | cwd and target | Runs the framework generator for the project, the exit code |
| `runDev`, `runBuild`, `compileBinary` | [build.ts](build.ts) | cwd, `{ bin, outfile, dotenv }`, the codegen function | Runs the application; type check; an executable without `.bun-build` in the project |

The CLI itself uses no DI, ORM, HTTP, AI or background. Generated modules connect the
existing public ORM/DI APIs; codegen wires the constructor dependencies.

## Commands and input fields

```sh
bunx bazis --help
bunx bazis new MyApp --dry-run
bunx bazis new MyApp
bunx bazis g module Task --dry-run
bunx bazis g m Guest --no-codegen
bunx bazis g module Mailer --empty --no-register
bunx bazis g module Catalog --full --no-codegen
bunx bazis g pack DataManager --parts tables,fields,validators,records --dry-run
bunx bazis codegen --target production
```

In this repository Bun commands run through `scripts/bazis-bun` with a qualified
`BAZIS_BUN_BIN` (`./scripts/bazis-bun run bazis …`). The compiled CLI is `bin/bazis`.
In a created project the `dev`, `build`, `build:bin`, `codegen` scripts wrap
`bazis dev|build|build --bin|codegen`.

| Field | Type / source | Required / default | Check / behavior |
| --- | --- | --- | --- |
| command | positional string | Required | `g` / `generate`, `codegen` |
| `new <Name>` | positional string | For a new project | Creates a separate folder with a kebab-case name; name rules as for modules |
| `--path` | path string | Only `new`, default `./<kebab-name>` | The exact path of the new directory; the parent must exist, an existing directory is never overwritten |
| `--framework` | path string | Only `new`, default `./src/bazis` or the package next to the source CLI | The local `bazis` package: its version sets the npm dependency; `--vendor` copies it, `--link-framework` links it |
| `--vendor` | flag | Only `new`, false | Copy the package into `vendor/bazis` and depend on `file:./vendor/bazis` instead of npm; for offline projects |
| `--link-framework` | flag | Only `new`, false | Keep a relative `file:` link to the external checkout; the project needs it when moved. Incompatible with `--vendor` |
| generator | positional string | For `g` | `module` / `m`; `pack` / `p` / `module-pack` |
| name | positional string | For `g` | A Latin letter, then letters/digits; parts joined by a single hyphen |
| `--parts` | CSV string | Only pack, required | At least 2 non-empty distinct parts, names as for a module |
| `--modules-root` | path string, cwd | `src/app/modules` | A non-empty value; an absolute path is allowed |
| `--app-module` | path string, cwd | `{modules-root}/App.module.ts` | The import is computed relative to this file |
| `--pack` | module name | — | `g module` only: adds the module as a part of the existing composite `{modules-root}/<pack>_modules`, in `<part>_module/`, connected in the pack root; not combined with `--app-module`. The part passport names the pack; the pack passport is the author's and is not rewritten (the command prints a reminder to add the part to its table) |
| `--empty` | flag | false | Only module: the connection point and the passport |
| `--minimal` | flag | true | Only module: CRUD and the passport |
| `--full` | flag | false | Only module: CRUD/list/cache/auth/background/AI; the old alias is `--enterprise`. `@Authorize` is generated if the project has `src/app/modules/auth/{tokenKinds,jwtAuth}.ts`; otherwise the routes are public and the CLI warns. Running the host needs a cache (`runApp({ cache: memory() })`) and a database provider |
| `--no-register` | flag | false | Skip the host and the automatic codegen |
| `--no-codegen` | flag | false | Create and connect, do not run codegen |
| `--target` | string | The project default | A name from `bazis.config.json` or `all`; for codegen or generation with registration |
| `--dry-run` | flag | false | Read and check the plan, do not write and do not run codegen |
| `--force` | flag | false | Allow overwriting scaffold files, including the passport; other files are not deleted |
| `-h`, `--help` | flag | false | Help in any position; no writes and no codegen |

The CLI does not accept null. Missing flag values, unknown options, extra positional
arguments and conflicting profiles are rejected before writing.
`--target` is incompatible with `--no-codegen` and `--no-register`.
The target name follows project codegen: a lowercase Latin letter, then lowercase
letters, digits and hyphens. `all` selects all configured targets.

`new` accepts only `--path`, `--framework`, `--vendor`, `--link-framework`, `--dry-run` and `--help`.
It does not install packages, run codegen or start the application. It creates
`package.json`, `tsconfig.json`, `bazis.config.json`, `.gitignore`, `AGENTS.md`, a local
architecture note, `README.md`, `src/index.ts` and the root `App.module.ts`. The
application root is a composition with `imports: []`, without a domain module. The HTTP
entry listens on loopback on port `PORT` (3000 by default) and enables `/health`.
Modules are still generated with `bunx bazis g module ...` in the new project; for a
first feature without a ready database, `--empty` fits. The root's DI exports: `[]`;
the TypeScript entry: `src/index.ts`; the published HTTP entry: `/health`.

By default (since 0.96.2) a new project depends on the npm package of the CLI's own
version, `"bazis": "^<version>"`, and copies nothing; `bun install` downloads it and
`bun update bazis` updates it. Before 0.96.2 the default was the vendor snapshot below.

With `--vendor` the project gets a snapshot of the package in `vendor/bazis` and the
dependency `file:./vendor/bazis`. The whole project moves, including vendor; the source
checkout is no longer needed. The snapshot holds index.ts, package.json, core, library,
cli, LICENSE and README.md; node_modules, tests, hidden files and compile scratch are
excluded. A symlink inside the copied sources is an explicit error before the project
is published. The snapshot is not updated automatically. The CI package check uses `--vendor` so the
app runs on the package it has just packed, not on the npm release. The `--link-framework` mode
keeps the live link to a checkout for joint development. Since 0.96.1 the package is
called `bazis` and is prepared for npm: the project imports the framework by the package
name (`bazis/core/di`), so the generated `tsconfig.json` has no `@/*` and `bazis/*`
aliases. A compiled CLI outside the checkout needs `--framework`. The source package
does not change. `dry-run` returns the number of snapshot files but writes nothing; the
CLI does not print hundreds of vendor paths.

Module profiles: `empty` is 2 files; `minimal` is 10; `full` is 14, including the passport.
In `full` the Tool is registered once in `tools`; the scoped provider is created by the
module extension of the Agent API. There is no second entry in `providers`.
A pack with N parts is 2 + 2N files. CRUD uses RequestModel and the email validator;
both CRUD profiles create getAll(query): PageResult with paging (HTTP: 20 by default,
at most 100). The controller builds JSON:API; summary returns the total count and at
most 20 names in id order. The service gets the DbContext through codegen and calls
db.saveChanges() for all changes of the context. The IRepository API semantics did not
change. In `full` the cache is reset after a successful write. HTTP Location and list
links take the actual host prefix. ORM startup flags are not set: the host makes sure
the schema is ready. `--full` checks for the auth helpers before writing, and relative
imports take the chosen directory and real paths behind symlinks into account.

## Results, effects and errors

Generators return `moduleDir`, `files`, `registered`, `dryRun`, `changes`
(`path`, `action: create | update`) and `warnings`. File paths in the report are relative to cwd.
In dry-run `registered` reflects the plan; in a regular run, the final registration.
The pack folder is `{kebab-name}_modules`, a part is `{kebab-part}_module`.
Names follow the module as it was typed (`g module Stats`). A file name is the class
name with the role moved into a suffix: `StatsController` → `http/Stats.controller.ts`,
`StatsListQuery` → `http/contracts/StatsList.query.ts`, `StatsSummaryTool` →
`ai/tools/StatsSummary.tool.ts`. The full set: `Stats.module.ts`,
`model/Stats.model.ts`, `model/Stats.dbContext.ts`, `services/IStats.service.ts`,
`services/Stats.service.ts`, `http/Stats.controller.ts`,
`http/contracts/Stats.requests.ts`, `Stats.responses.ts`, `StatsList.query.ts`;
`--full` adds `background/Stats.reporter.ts`, `ai/agents/StatsAnalyst.agent.ts`,
`ai/tools/StatsSummary.tool.ts`, `ai/contracts/Stats.brief.ts`. Role classes:
`StatsModule`, `StatsController`, `IStatsService`/`StatsService`, `StatsDbContext`,
`StatsListQuery`, `StatsReporter`, `StatsSummaryTool`, `StatsAnalystAgent`.
The record and its DTOs stay singular: `class Stat`, `CreateStatRequest`,
`StatResponse`; the route is `/stats`. Before 0.96.1 names were built from the entity
(`StatController.ts`, `StatService`). Pack parts that coincide in the singular
(`records,record`) are rejected. These are bounded rules for English names, not a
universal dictionary.

An existing folder without `--force` is an error. The host is checked before files are
written. Registration supports a `@Module` object with a literal `imports` array (or
adds the missing field); dynamic metadata needs a manual connection. Comments do not
count as a registration. Connecting again does not duplicate the import. Without a host
a warning is printed, the files are created, and the automatic codegen is skipped.
Registration in the host does not prove it is reachable from the chosen target; project
codegen checks that.

Each file is written through a temporary file and a rename. On a write error the
completed changes are rolled back; this is not a transaction for concurrent readers.
Codegen runs after writing; its error keeps the scaffold for fixing and returns a
non-zero code. A successful command returns 0, a CLI error 1, a codegen error the child
process's code. There are no automatic retries.

`new` prepares the content in a temporary folder next to the final directory and
publishes it with a rename after the check; on an error the temporary files are
removed. An existing final path is an error without changing files. Project codegen
excludes the sources of the installed framework outside the application root and does
not write framework shim files into a project without a local `src/bazis`.

## Checks

Regressions are in [test](test). The checks run in temporary directories; a live
application, PostgreSQL and an LLM are not needed to check the CLI.
Historical generator check: the original base 15 PASS / 0 FAIL, then 93 PASS / 0 FAIL,
361 assertions in 6 files. The command (after setting BAZIS_BUN_BIN):

```sh
./scripts/bazis-bun test --isolate ./src/bazis/cli/test
```

Checked: CLI parsing, no effects of help/dry-run, TypeScript registration, write
rollback, keeping other files with force, the structure and links of passports, the
types of all generated profiles against the current API, the cache and the HTTP prefix.
The [integration check](test/codegen.integration.test.ts) runs real codegen in a copy of
the framework and checks DbContext DI, HTTP and AI metadata.
A separate CLI binary was also built and checked in a temporary directory.
The TypeScript check of the CLI and its tests against the framework's public
declarations: PASS. With the current Agents integration: the shared `build` PASS; a
separate CLI binary build and `bin/bazis --help` PASS. Real CLI/codegen integration:
1/1 PASS, full-scan codegen: 10/10 PASS. Full-scan needed a test timeout of 30000 ms:
one generation process exceeded the original 5000 ms limit; the original failure is not
counted as success. Inherited DTOs and the existing Product UiProfile were checked too.
Full commands and evidence are in the [Agents report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agents-module-2026-09-20.md).

### API usability work, 2026-10-03

Check of the affected CLI/ORM/HTTP/DI and application services: 247 unique tests in
29 files. The shared run: 244 PASS, 3 timeouts on a heavily loaded host; a separate
rerun of these three tests with the same 30000 ms limit: 3 PASS / 0 FAIL.
TypeScript of the whole project and production/test codegen: PASS. The two full-scan
tests that run the compiler got an explicit 30000 ms limit instead of 5000 ms; the
checked conditions are kept. The standard test command excludes browser specs.

[standalone-runtime.integration.test.ts](test/standalone-runtime.integration.test.ts)
builds the CLI, creates a project with a vendor snapshot, moves it, generates a module,
checks types and runs the source and the built application from another cwd: PASS.
The main application binary was built too; config check from an external directory:
52 settings, PASS, without creating clients. Loopback HTTP conventions were checked.
Physical PostgreSQL, an LLM and production load are not part of this run.

Regressions of query limits and cache saving:
[templates.test.ts](test/templates.test.ts). Context and route binding:
[codegen.integration.test.ts](test/codegen.integration.test.ts). Generation errors:
[codegen-dx.integration.test.ts](../core/scripts/test/codegen-dx.integration.test.ts).
The commands ran through the qualified scripts/bazis-bun; compiler integrations use
test --isolate --timeout 30000 with exact ./src/… paths.

Generated passports record the creation command in a canonical form (`Created
with: \`bunx bazis g module Task --minimal\``); the parts of a pack record the
pack command. Since 0.97.8.
