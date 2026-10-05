# osnv module architecture and directory structure

Identifier: **MOD-ARCH-001**. Version: **1.11**. Date: **2026-10-06**.
Status: **mandatory repository rule**.

The specification fixes the choice between an atomic and a composite module, the
placement of components, their input contracts and the agent's working order. It
applies to new development and to the changed part of existing code. It is not an
instruction to restructure all existing modules.

"Must" and "must not" mark requirements. "By default" allows a justified decision
recorded in the module passport. Examples of the current implementation are kept
apart from the rules in the [review of existing modules](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/docs/architecture/EXISTING_MODULES.md).
End-to-end TypeScript examples are in the [code appendix](MODULE_CODE_EXAMPLES.md).

## 1. What counts as a module

A **module** is a named boundary of responsibility, dependency registration and
public contract. The usual connection point is a class with `@Module(...)` in
`<Name>.module.ts`. A configurable factory may return a module. A directory without
its own module contract does not become a module.

An **atomic module** implements one coherent domain or technical responsibility.
It owns the models, ORM contexts, services, controllers, input/output contracts
and adapters it needs. "Atomic" does not mean one file, one class, one table or
no dependencies.

A **composite module** (`module pack`) combines several atomic modules, each with
its own independent responsibility and contract. The pack root connects them
through `imports` and, when needed, re-exports public DI tokens through `exports`.
The implementation itself lives in the atomic modules.

The **application root** (`AppModule`) assembles the application features. The
infrastructure manifest (`AppInfra`) and the entry point (`runApp`) connect the
environment, transport and shared resources. They are not a template for the
structure of every simple feature.

A **group directory**, for example `actor_modules`, only organizes files. It
becomes a composite module only when the matching composition exists.

This is an architectural classification. No new `kind: "atomic"` or `submodules`
fields or a separate decorator are introduced for it: both kinds use the existing `@Module`.

**Agents are independent entities alongside modules.** An agent defines behaviour
and its own set of Tools; a module provides the application services and data a
Tool implementation can use. A concrete agent is not part of a module or of its
`imports`. The target boundaries and the migration order are fixed in
[AGENT-ARCH-001](AGENT_ARCHITECTURE.md).
`@Module.agents` in the current code reflects the previous registration path, kept
for the migration period; it is not the target way to create new agents.

## 2. Choosing atomicity

| Situation | Decision | Reason |
| --- | --- | --- |
| Tasks (`Task`): create, read, change status in one domain | Atomic module | One coherent feature, its own data and operations |
| Guests (`Guest`): registering and tracking guests | Atomic module | HTTP, model and service serve one feature |
| Users, Employee, Product (osnova application) | Atomic module | Existing examples of a vertical feature |
| DataManager (osnova application) | Composite module | Tables, fields, validators and records have independent responsibilities |
| A large area with separate orders, cart and history | Composite, if the boundaries are really independent | There are several own contracts and behaviour owners |
| A controller, worker, UI profile, tool or second ORM class was added | Keep the atomic module | A new technical component alone is not a new feature |

For a composite module, its atomic parts must be listed before implementation.
For each part, state the responsibility, the data it owns, the public inputs, the
dependencies and separate test scenarios. If the parts differ only by layer names
(`HttpModule`, `ServiceModule`, `ModelModule`), there is no reason for such a
split.

By default a new feature is atomic. Code growth is a reason to review the
boundaries, but not an automatic requirement to split. A dependency on Auth, ORM,
the cache or another module does not make an atomic module composite. A framework
module also chooses its structure by responsibility, not by the word "runtime" in its name.

### 2.1. Design and implementation priorities

For the application, the framework and the CLI the priorities are **OOP and SOLID,
performance, fault tolerance, binary builds and simplicity of implementation**.
Decisions are assessed against all these criteria while keeping correctness and
public contracts. When the requirements are met, the simplest clear option is
preferred. Significant trade-offs are recorded in the affected module's passport.

**OOP and SOLID.** State and invariants have an explicit owner. Classes group
coherent behaviour; dependencies are expressed through contracts and the existing DI.
Pure functions are fine for computations and transformations that need no stateful
object. The number of classes and inheritance levels is not a quality measure.

| Principle | How to apply it |
| --- | --- |
| S — single responsibility | A class and a module have a coherent duty and a clear reason to change |
| O — open/closed | New behaviour plugs in through the needed contract extension points; abstractions are not created for hypothetical variants |
| L — substitution | An alternative implementation keeps the contract's promises, including results, errors and lifecycle |
| I — interface segregation | A consumer depends on the operations it needs; unrelated duties are not merged into a shared interface |
| D — dependency inversion | Domain behaviour uses port contracts; infrastructure implementations are bound in the composition through the existing DI |

**Performance.** When designing, consider algorithmic complexity, the number of
database and network calls, the volume of processed data, memory and concurrency.
Hot paths must not contain extra work, N+1 queries or unbounded
buffers/selections. For significant changes of such paths, compare the behaviour
under a representative load: latency (including p95/p99 where applicable),
throughput, memory and the number of queries. State the data volume, the
environment and the result. Budgets come from the task requirements; without
measurements performance is not declared confirmed. An optimization that adds
complexity needs a measurable need.

**Fault tolerance.** For operations with external effects and long-running work,
describe dependency errors, time limits, cancellation, partial completion and
recovery. Resources and scopes are released on success and on error. Retries are
bounded and take into account the kind of failure and whether repeating the effect
is safe; idempotency and transaction boundaries are defined where the contract needs them.
Do not hide a failure behind a successful result or promise guarantees the API in
use does not provide. Significant failure scenarios are tested with controlled
faults and an explicit expected result.

**Binary builds.** Running the application and the CLI from built binaries is a
priority delivery scenario. Dependencies, imports, codegen and resources must
support `bun build --compile`. Statically resolvable entry points and generated
bindings are preferred. Resource access must not implicitly depend on the
developer's working directory or on the presence of the source tree.
Required external configuration, data and tools are described explicitly;
for example, the CLI `codegen` command uses the project and its toolchain.

The current build targets of this repository are defined in [package.json](../../package.json):

| Script | Artifact |
| --- | --- |
| `build:bin` | `bin/osnv`: the CLI built from `src/osnv/cli/main.ts` |
| — | Application binaries are built by the application repository (for example osnova) |
| — | Codegen runs as a separate step before an application build |

Use the qualified Bun through `scripts/osnv-bun`. When checking a single target,
first refresh the required codegen results.
A change that affects the binary build or execution is checked by building the
affected target and a control run of the matching scenario in a controlled
environment. Typecheck, unit tests and running from TypeScript do not replace this check.
Mark an unchecked platform, external dependency or execution path separately.

**Simplicity of implementation.** Use the existing ORM, DI and other mechanisms,
explicit data flows and the minimum number of necessary components. Do not add
layers, factories, inheritance, submodules or dependencies without a concrete duty.
Simplicity is judged by how clear the behaviour is and how costly a change is, not
only by line count. OOP and SOLID are applied in proportion to the task and keep this simplicity.

Checks are proportional to the affected behaviour. For a documentation-only change,
checking the content, the links and the consistency of the rules is enough;
running the application, load measurements and binary builds are not needed for such an edit.

## 3. Dependency direction and owners

1. `src/osnv/library` contains library mechanisms; it does not depend on the
   application or on the `core` integration layer.
2. `src/osnv/core` integrates library mechanisms, DI, HTTP, ORM and lifecycle;
   it does not import application code (`src/app`, `admin-ui` in osnova). The lower DI layer does not import ORM/HTTP:
   extensions are registered by the upper layer through existing mechanisms.
3. The application (`src/app` in osnova) defines features, configuration and composition. Consumers
   use the public osnv entry points (`osnv/core/di`, `osnv/core/orm` and so on),
   not internal framework implementation files.
4. `admin-ui` and `client-ui` in osnova are client adapters. Domain services do not
   depend on Vue, UI components or browser state.
5. Dependencies between modules are declared explicitly through `imports` and public
   contracts. The domain dependency graph must stay acyclic.
6. Every ORM entity, context, provider and handler has one owning module.
   The pack root does not register them again. Depending on another module's service
   does not give the consumer ownership of its tables or migrations.
7. Shared connections are created by the infrastructure. An atomic module gets
   `DATABASE_PROVIDER` and other clients through DI; it does not create a second pool
   for convenience. An isolated standalone composition is described separately.

A public service may physically live in `services/`: what matters is the declared
contract, not the path depth. Importing such an exported service is allowed. Importing
a private store, an internal ORM context or a neighbour's `internal/` to bypass its
API is not allowed. A TypeScript type import and `@Module.imports` solve different
tasks; one does not replace the other.

## 4. Directory structure

### 4.1. Repository level

```text
AGENTS.md                          mandatory entry point for the agent
docs/architecture/                 the shared specification and the passport template
src/
  osnv/
    index.ts                       the framework's public entry
    library/<capability>/          library implementation
    core/<capability>/             runtime and DI integration
    cli/                           the generator and templates
  generated/                       codegen results; do not edit by hand

An application on osnv (the osnova layout):
src/
  index.ts                         startup and publishing of the application surfaces
  app/
    config/                        configuration of the application and shared resources
    infra/App.infra.ts             infrastructure connection
    agents/                        standalone agent declarations (target structure)
    modules/
      App.module.ts                composition of the application features
      <feature>/                   a standalone atomic module
      <feature>_modules/           a composite module and its atomic parts
      actor_modules/               the existing grouping by actor
  generated/                       codegen results; do not edit by hand
admin-ui/                          the application client
client-ui/                         the user-facing Vue chat
```

This is a responsibility map, not a requirement to add missing directories.
Existing additional entry points and directories are kept.

### 4.2. A new atomic module

A new module is created only by a CLI command per §8.1. The base layout matches
the [CLI template](../../src/osnv/cli/templates/module.ts).
The `task/` example below is a template for a future module, not an existing implementation.

```text
task/
  MODULE.md                        passport: responsibility, inputs, contents
  Task.module.ts                   the single regular connection point
  index.ts                         the public TS facade, if consumers need it
  model/
    Task.model.ts                  ORM entity
    TaskDbContext.ts               context and entity sets
  services/
    ITask.service.ts               interface and DI token
    Task.service.ts                domain operations
  contracts/                       contracts shared by several adapters
  http/
    TaskController.ts              HTTP inputs
    contracts/
      TaskRequests.ts              input runtime models
      TaskResponses.ts             output models
      TaskListQuery.ts             the allowed surface of a list query
  background/                      hosted services / periodic handlers
  ui/                              @UiProfile declarations
  ai/
    tools/                         tools that call the module's services
    contracts/                     inputs and outputs of AI adapters
  events/                          events and their handlers, if needed
  config/                          configuration owned by the feature
  infra/                           application connectors and external clients
  migrations/                      migrations owned by the module
  errors/                          domain errors
  internal/                        private implementation details
  test/                            checks of responsibility and contracts
```

The passport and the connection point are mandatory; other files appear only when
the matching behaviour exists. For example, an SMS feature without its own database
needs no `model/`, `DbContext` or `migrations/`. HTTP and AI are optional as well.
Empty directories and "for the future" stubs are not created.

Agent declarations and the prompts they own live outside the module per
[AGENT-ARCH-001](AGENT_ARCHITECTURE.md). The `ai/tools` directory may contain
adapters of this module's public services; it does not define the set of agents.
The current CLI `--full` still creates an agent inside the module: splitting the
generation is part of the first migration stage, not a completed change of this layout.

Names of new standalone directories are lowercase/kebab-case, as in the CLI.
Composite modules keep the accepted `<feature>_modules` and
`<responsibility>_module` scheme. An existing module keeps its local naming:
the flat Users and the Product layout with `api/` and `dbContext/` in osnova
do not need to move just because of this specification.

New and renamed components must follow the
[simple naming from AGENTS.md](../../AGENTS.md#code-naming).
Names in the current CLI templates and examples do not cancel this rule; existing
public contracts and the scope of the change are kept.

One significant runtime class per file. Short related DTOs may share
`*Requests.ts`/`*Responses.ts`, as in the generator.
Type-only contracts live next to the owner in `contracts/` or `types/`.
Do not create global `services/` and `models/` for the implementation of all features.

An example connection point of the atomic Task. The full definitions of the imported
classes are in the [code appendix](MODULE_CODE_EXAMPLES.md).

```ts
// file: src/app/modules/task/Task.module.ts
import { Module, scoped } from "osnv/core/di";
import { AuthModule } from "../auth/Auth.module";
import { Task } from "./model/Task.model";
import { TaskDbContext } from "./model/TaskDbContext";
import { ITaskService } from "./services/ITask.service";
import { TaskService } from "./services/Task.service";
import { TaskController } from "./http/TaskController";

@Module({
  imports: [AuthModule],
  ormOsnv: { context: TaskDbContext, entities: [Task] },
  providers: [scoped(ITaskService, TaskService)],
  controllers: [TaskController],
  exports: [ITaskService],
})
export class TaskModule {}
```

Task owns its whole implementation. `imports: [AuthModule]` is a dependency on
authorization; it does not make Task a composite module. The shared provider and
schema readiness are provided by the host composition.

### 4.3. A composite module

```text
datamanager_modules/
  MODULE.md                        pack passport and dependency map
  DataManager.module.ts            imports / exports and the composition factory
  tables_module/                   atomic responsibility "tables"
  fields_module/                   atomic responsibility "fields"
  validators_module/               atomic responsibility "validators"
  records_module/                  atomic responsibility "records"
  test/                            checks of the composition and joint scenarios
```

The pack root and every new atomic part are created through the CLI per §8.1.
Each part uses its own layout from §4.2 and its own passport.
The pack root has no domain `providers`, `controllers`, `config`,
`ormOsnv`, `background`, `uiProfiles` or executable AI handlers of its own.
If orchestration of several parts is needed, it gets an explicit atomic
owner; it is not placed as a hidden business service in the pack root.

A module factory may substitute a dependency and return a configured composition.
Its arguments are described as
public inputs of the pack. A consumer only needs to connect the pack root;
the internal dependencies of the parts stay explicitly declared.

A code example of an existing composite module (DataManager in osnova):

```ts
// file: src/app/modules/datamanager_modules/DataManager.module.ts
import { Module } from "osnv/core/di";
import { AuthModule } from "../auth/Auth.module";
import { DataManagerTablesModule } from "./tables_module/DataManagerTables.module";
import { DataManagerFieldsModule } from "./fields_module/DataManagerFields.module";
import { DataManagerValidatorsModule } from "./validators_module/DataManagerValidators.module";
import { DataManagerRecordsModule } from "./records_module/DataManagerRecords.module";

@Module({
  imports: [
    AuthModule,
    DataManagerTablesModule,
    DataManagerFieldsModule,
    DataManagerValidatorsModule,
    DataManagerRecordsModule,
  ],
  exports: [],
})
export class DataManagerModule {}
```

Here the root only assembles the parts. The code of the atomic Records part and the
dependencies between parts are shown in the [code appendix](MODULE_CODE_EXAMPLES.md).

## 5. Module connection fields

### 5.1. Base `@Module` metadata

Type source: [OsnvModuleMetadata](../../src/osnv/core/di/module/types/OsnvModule.ts).
All listed fields are optional in TypeScript. Project rules may require an explicit
value, for example `exports` on a new feature module.

| Field | Input type / value | Purpose and rule |
| --- | --- | --- |
| `imports` | `readonly OsnvModuleRef[]` | Connected dependencies; for a pack also its atomic parts |
| `config` | `ModuleConfig` or a readonly array | Declarations and validators; the kernel resolves the values and checks them before clients are created per [§5.4](#kernel-config-isolation) |
| `providers` | `readonly ProviderDefinition[]` | Own DI registrations; the token, implementation, dependencies and lifetime are described in the passport |
| `controllers` | `readonly Class<object>[]` | HTTP controller classes; registered as scoped automatically |
| `uiProfiles` | `readonly unknown[]` | UI profile declarations; the upper layer checks the controller/request/response references |
| `background` | `readonly Class<HostedService>[]` | Singleton handlers with managed start and stop |
| `exports` | `readonly ModuleExport[]` | Tokens/classes/open generic families available to importing modules |
| `global` | `boolean` | Global visibility of exports; meant for infrastructure, not for bypassing `imports` |
| `configure` | `(di: DiRegistrar) => void` | Programmatic registration when needed; regular registrations are declarative |

The module name comes from the class with `@Module`; this metadata has no separate
`name` field. `OsnvModuleRef` also allows plain metadata for internal/compatibility
scenarios; a new application module uses a named class.

The semantics of `exports` matter:

- the field is absent — the module is open to importing modules;
- `exports: []` — its providers are private;
- `exports: [IService]` — a specific contract is declared outward;
- the DI container root can technically resolve any registration. This does not
  permit application code to bypass module boundaries;
- `exports: []` does not disable controllers, background jobs or registered
  tools. Their publication and authorization are checked separately;
- `index.ts` limits the TypeScript surface but does not replace DI exports.

New feature modules and packs set `exports` explicitly. The existing application
root does not have to change because of this rule.

### 5.2. ORM: `ormOsnv`

This is a metadata extension from `osnv/core/orm`, not a field of the lower DI layer.
It takes one `OrmModuleConfig<DbContext>` or a readonly array of configurations.
A regular atomic module uses `context` and `entities` on the shared connection.
Several ORM contexts do not automatically mean several atomic modules.

Source and the exact combination checks: [ormModule.ts](../../src/osnv/core/orm/ormModule.ts).

| Field | Input type | Value / condition |
| --- | --- | --- |
| `context` | a `DbContext` subclass | Required for feature mode; the constructor receives `DbContextOptions` |
| `entities` | a readonly array of entity classes | An explicit list of the models owned by the context |
| `provider` | `DatabaseProvider` | Without it the shared `DATABASE_PROVIDER` is used; with it — connection/standalone mode |
| `validateOnSave` | `boolean` | `true` by default; disabling it needs a described alternative validation |
| `ensureCreated` | `boolean` | `false` by default; a schema creation mode, not a universal rule for new features |
| `migrateOnStart` | `boolean` | `false` by default; additive migration of models with the matching metadata |
| `migrations` | `readonly Migration[]` | The module's versioned migrations |
| `runMigrationsOnStart` | `boolean` | `false` by default; runs the versioned migrations |
| `executionStrategy` | `DbContextOptionsConfig["executionStrategy"]` | Retry settings for transient save errors |
| `healthCheck` | `boolean` | On by default for connection/standalone and off for feature |
| `registerRepositories` | `boolean` | `true` by default; scoped `IRepository<T>` |
| `imports` | `readonly OsnvModuleRef[]` | Extra dependencies of the context |
| `ownedStore` | `OrmOwnedStoreDefinitionV1` | A special contract of a managed PostgreSQL store and its lifecycle |

Do not combine `ensureCreated` with active startup migrations or a non-empty
`migrations` list. `ownedStore` requires a context and non-empty entities;
it must not get a provider, activate the listed startup flags or get
`migrations`. Standalone PostgreSQL with `ensureCreated` is also limited by the
current ORM contract. The schema mode is chosen explicitly for the task and environment;
the CLI scaffold sets no startup flags for creating or updating the schema: its
readiness is provided by the host composition.

### 5.3. AI and other extensions

gRPC is connected by importing `osnv/core/grpc`: the field
`grpcControllers?: readonly Class<object>[]` registers classes with
`@GrpcController` as scoped per RPC through the existing owner-bound DI
extension. A feature module can own both `controllers`
and `grpcControllers`; splitting into submodules by transport is not needed.
The server is enabled through `runApp(..., { grpc: ... })` or `grpcModule(options)`.
Contracts and checks are in the [gRPC passport](../../src/osnv/core/grpc/MODULE.md).

Source of the current AI fields: [agent/index.ts](../../src/osnv/core/agent/index.ts).
The table describes the current implementation. The decision of 2026-09-20 separates
agents from modules; the migration follows [AGENT-ARCH-001](AGENT_ARCHITECTURE.md).

| Current API field | Input type | What to describe in the passport |
| --- | --- | --- |
| `agents` | `readonly Class<object>[]` | The previous module path, only for compatibility during the migration; new agents are declared separately |
| `tools` | `readonly Class<object>[]` | A class with `@Tool`, input/output schema, side effects, access, DI dependencies |
| `prompts` | `readonly Class<object>[]` | The current module registration path; an agent's prompts move together with its standalone declaration |
| `agentToolHooks` | `readonly AgentToolHookRegistrationV1[]` | The hook kind and identity, handler, order, timeout, input event and result |

In an `agentToolHooks` entry the `kind`, `id`, `version` and `handler` fields are required;
`order` and `timeoutMs` are optional. `kind` is `enforcement`, `settlement` or
`observer`; `id` is 1–128 printable ASCII characters; `version` is a positive safe
integer; `order` is a safe integer; `timeoutMs` is a positive safe integer.
The handler implements the matching `enforce`, `settle` or `observe`. The exact
event contracts come from [AgentToolHooks.ts](../../src/osnv/core/agent/AgentToolHooks.ts).

`tools` automatically creates a regular scoped provider of the class in the declaring
module. An exact existing scoped registration of the same owner is reused;
a different lifetime, a factory, a duplicate name or an owner conflict fail the
container build. Repeating a Tool in `providers` for a regular connection is not needed.
A hook is still registered as the owner's private contribution. Source:
[moduleContributions-v1.ts](../../src/osnv/core/agent/moduleContributions-v1.ts).

Linking a Tool implementation to a DI owner does not put the agent into the module.
Assigning Tools to an agent and the actual permissions to act are defined separately.
In the osnova application the shared [ToolsModule](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/MODULE.md)
lives in the agents area. `AgentRegistry.fromContainer` builds a catalog of the
actual registrations without instantiating Tools; `AgentCatalogExtras`
and the previous registry factories are kept for existing consumers.

Do not invent a missing API and do not treat an arbitrary `@Module` key as
automatically executable. A new declarative capability needs a typed field, a
connected handler and a registration check.

<a id="kernel-config-isolation"></a>

### 5.4. Configuration declaration and the values of each kernel

**Decision accepted on 2026-09-14:** a configuration declaration is shared and immutable;
the selected environment and the computed values belong to a specific kernel.
One declaration object may be used in several kernels of one process, including
at the same time with different environments.

The model is implemented through `ConfigDefinition`, `ConfigRegistry` and the existing DI.
The state of the checks and the boundaries are in the
[implementation report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/kernel-config-isolation-2026-09-14.md).

| Part | Contents | Owner and lifetime |
| --- | --- | --- |
| Configuration declaration | Prefix, keys and types, defaults, `development` / `test` / `production` sections, validation and secret rules | A domain or infrastructure module; can be reused without change |
| Configuration view | The selected environment, validated values from the source snapshot and the resolution cache | One kernel; consumers of its DI container get this view |

Data flow: **declaration + kernel environment + source snapshot → the validated
view of this kernel**. The host composition resolves and validates the configuration
before the clients that use it are created and services start. Modules keep ownership
of their declarations and connect them through the existing `@Module` / `@Infra`.
Building a kernel does not change shared module metadata or configuration declarations.

Required properties of the target model:

1. The shared declaration holds no `activeStand`, selected values, secrets from env
   or a cache that depends on a specific run. Reading and validating for one
   kernel do not switch the configuration of another.
2. Each kernel gets its own immutable resolution result.
   The same environment name does not make the cache shared: the source values of two
   kernels may differ. Connecting the same declaration again inside
   one kernel uses its already resolved view.
3. The environment is chosen at the host composition boundary. The
   `defineConfig` rules are kept: `default` → the selected environment section → the snapshot
   of the kernel's configured sources, including `OSNV_*`; typed conversion
   and `Secret` are kept. Source values
   are fixed for this kernel's resolution; a later change of `process.env`
   does not change a ready result. Switching `process.env` to pick a context
   while reading is not allowed. The source order is set in the
   [configuration contract](../../src/osnv/core/kernel/config/README.md).
4. Services get their kernel's view through the existing DI;
   host factories may get it as an explicit argument. A shared declaration import
   alone does not define which kernel's values to read. A global
   "current kernel" and manual copying of the declaration by a consumer are not needed.
5. A resolution or validation error aborts the build of the affected kernel,
   keeping the shared declaration and the ready views of other kernels. Stopping a
   kernel does not change another kernel's configuration either. Secrets keep the existing
   masking in diagnostics.

The implementation lives inside the existing kernel/config, DI and Infra.
`defineConfig` returns an immutable declaration with `resolve(environment?, configuration?)`
and `token`. A service gets `ConfigView<T>` by `definition.token` through DI;
`ConfigRegistry.get(definition)` returns the same view of its kernel.
A connector gets the registry as the `create(configs?)` argument. The declaration's direct `get/has`
are kept for standalone code and read the process env; `ensureValid` does not switch
their environment. Inside a kernel its DI view is required.

A composite user declaration may implement
`AppConfig.resolve(environment?, configuration?)`, returning an independent
immutable result. An object with only `ensureValid` stays compatible
as a validator/ready value; the kernel cannot isolate arbitrary
mutable state hidden in its user closures.

**Implementation acceptance criteria:** two kernels with a shared declaration build
successfully for `production` and `test`; sequential and concurrent reads
through their services and connectors keep each kernel's values. Separately checked:
two kernels of one environment with different source snapshots, a build error of one
and stopping the other, no effect of later source changes, and
keeping the rules for defaults, type conversion and `Secret`.

**Migration done:** the shared declaration no longer stores `activeStand` and does not
forbid use in another environment. The built-in connectors, JWT and the session
protection adapter get the kernel view. A ready view stays
immutable; for another kernel the declaration is reused.
The state and boundaries are recorded in the
[kernel passport](../../src/osnv/core/kernel/MODULE.md#config-isolation-decision).

## 6. Components of an atomic module and their inputs

The component roles are listed below. The passport must list the concrete
files and symbols, not just copy directory names. Parts that do not apply are
marked "not used" with a short reason, without creating stubs.

| Component | Where it lives | What it gets as input | Responsibility / output |
| --- | --- | --- | --- |
| Module declaration / factory | `*.module.ts` | The §5 fields; typed factory options, if any | The dependency graph and public DI contracts |
| Interface and DI token | `services/`, `contracts/` | The arguments of each public operation | Typed results and errors |
| Business service | `services/` | Constructor DI deps; DTO/command/query; operation context, if needed | Domain rules, transactions, ORM and external port calls |
| ORM entity | `model/` | Model fields with types, keys, nullability, defaults and constraints | Data owned by the module; not an automatic HTTP model |
| DbContext / repository | `model/` | Options, provider, entities; read and change criteria | Data access through the existing ORM |
| Migration | `migrations/` | Version, execution context, expected schema state | A concrete schema change and its execution conditions |
| HTTP controller | `http/` | DI service; path/query/body/header; server HTTP/auth context | Request binding and validation, the service call, the HTTP result |
| Request/command | `http/contracts/`, `contracts/` | Each input field per the §7 rules | Runtime validation at the matching boundary |
| List/query model | `http/contracts/` | Allowed sort/filter/page, operators and limits | A typed query, not arbitrary column access |
| Response and mapper | `http/contracts/`, `contracts/` | The service result/model; the list of published fields | A stable output DTO with a described serialization format |
| Configuration | `config/` or the existing `infra/` | The shared declaration, the kernel environment and value sources | The view of each kernel per [§5.4](#kernel-config-isolation); secrets are not duplicated in the passport |
| External adapter / client | `infra/` | Connection settings, DI port, request and time limits | Translating the external contract into the module contract |
| Background handler | `background/` | DI; schedule/event; `AbortSignal`; payload, if any | Managed work and correct resource release |
| UI profile | `ui/` | `surface`, controller/request/response references, operations and navigation | An interface declaration; not a replacement for server authorization |
| Module Tool adapter | `ai/tools/`, `ai/contracts/` | The §5.3 contracts; input schema, DI and runtime context | Calls public application operations and returns a checkable output; the agent is declared separately |
| Event adapter | `events/` | Event type/version, payload and context per the integration API | Translating the event into module operations |
| Errors | `errors/` | Code, domain details and the original cause per the contract | A defined error without leaking internal data |
| Internal implementation | `internal/`, next to the owner | Typed local arguments and deps | An implementation detail, not a public input |
| Checks | `test/` or existing colocated tests | Fixtures, concrete inputs, substituted ports | Checking behaviour, boundaries and negative cases |

Do not add new fields to working APIs just because the description table names them.
For example, `context`, `timeout` or `idempotencyKey` belong in a signature
only when a concrete operation needs them and its API supports them.

### 6.1. DI and lifetime

For each registration the passport states: `provide` (token/class), `useClass` or
a factory/value, the constructor dependency types, the lifetime, the source module of each
dependency and its availability through `exports`. Describing dependencies in the passport
does not require repeating them as an array in the registration.

The regular path is `scoped`, `singleton`, `transient` and the existing factory/value
shortcuts from [shortcuts.ts](../../src/osnv/core/di/module/shortcuts.ts).
A regular class uses `scoped(IService, Service)` or `scoped(Service)`.
Dependencies are declared in the constructor; codegen extracts their types, including
`IRepository<Entity>`, and DI uses the generated binding.
A manual third `deps` argument is not needed to repeat these same dependencies.
It is allowed for a concrete justified override, not as the standard for a
new module. After a constructor changes, codegen is refreshed.

A controller is already registered through `controllers` (HTTP) or `grpcControllers`
(gRPC), a background class through
`background`: do not duplicate them in `providers` without a separate reason.
A singleton does not hold a scoped service. A background handler creates a scope for
a unit of work and releases it; an example is `UserStatsReporter` in osnova.

## 7. Input and output contracts

### 7.1. Passport of each entry point

For each public method, HTTP route, factory options, tool, background
payload and event, record:

1. The operation name, the file/symbol and how it is invoked: route + method, DI method,
   configuration factory, schedule, event or tool name.
2. The calling consumer, access rights and the source of the context. User
   fields do not replace server identity or permissions.
3. The input model with all fields, including nested objects and arrays.
4. The result: type, fields, date/identifier format, null/empty semantics;
   for HTTP also the status and significant headers.
5. Errors, when they happen and how they map at the boundary; in particular,
   the behaviour for an unknown identifier and invalid input.
6. Changed state and external effects. For operations with retries or long-running
   work — the actually supported idempotency, concurrency,
   transaction, deadline and cancellation. If they are not supported, say so plainly.
7. Checks: a regular request, boundary values, invalid inputs and dependency
   failures that matter for this operation.

Describe an operation without arguments too: "no input fields", plus its
DI dependencies and the triggering mechanism. Do not invent an empty Request class for it.

### 7.2. Field table

Each field requires the following information:

| Item | What to record |
| --- | --- |
| Path | The exact name: `name`, `options.limit`, `items[].id`; the external alias, if any |
| Type and format | TS/runtime type; enum, date/time, UUID, numeric units and range |
| Source | `body`, `path`, `query`, `header`, `config`, a method argument, an event or the server context |
| Required | Whether presence is required; conditional dependencies on other fields |
| Nullability | Whether `null` is allowed, separately from absence/`undefined` and an empty string |
| Default | The value when absent and where it is applied; "none" if there is none |
| Checks | Required, length, range, enum, nested validation, domain invariants |
| Example | A valid value without secrets or real personal data |

For an array, state the element type and the length limits; for a nested model,
expand its fields or give an exact link to its contract. For an open dictionary,
describe the schema of the allowed keys/values and the limits. Do not write only
"`input: object`", "`data: any`" or "standard fields".

State separately how unknown fields and type conversions behave.
Do not promise that extra fields are rejected if the binder strips them, and do not call
`age?: number` permission for `null` without checking the runtime path.
Being required, a class initializer and a domain default are different facts.

HTTP requests need runtime classes and working binding/validation:
codegen by convention or an explicit `@RequestModel()`/binding registration if
the path in use requires it. A TypeScript interface alone does no runtime
validation. Calling a service from a tool, an event or another service does not get
HTTP validation automatically: its owner must be defined for each input.

A local passport does not replace the schema code. After a DTO, validator,
settings or signature change, the passport is updated in the same task. If the code
and the previous document disagree, the agent records the discrepancy and
fixes it within the task; it does not declare the desired behaviour verified.

## 8. How the agent applies the rule

The mandatory working order:

1. Read `AGENTS.md`, this specification and the passport of the affected module.
2. Check the current connection points, input models, public exports,
   owners of ORM/DI registrations and the tests relevant to the task.
3. Choose an atomic or a composite module and record the reason. For a composite
   one, list the atomic parts and the directed dependencies between them.
   Assess the decision against the §2.1 priorities; state significant trade-offs
   and the applicable performance, failure and binary execution checks.
4. Before generating or changing code, describe the affected components and input
   fields in the task plan. Create a new module with a CLI command per §8.1, then fill in
   the generator-created `<module>/MODULE.md` per the [template](MODULE_SPEC_TEMPLATE.md).
   For an existing module, when its architecture/public inputs change, create
   or update its passport.
5. Implement the domain behaviour in the created scaffold or the existing module
   through the current APIs. Extend the passport together with the components and inputs.
6. When constructors or generated contracts change, run the needed
   codegen in the existing project way, then the applicable checks.
   Before running, check that the scripts exist and the toolchain requirements.
7. Compare the result with the passport and the criteria below; report separately
   the checks performed, the errors and what was not checked.

For a regular local fix without architecture or public input changes,
the existing passport and a description of the affected behaviour are enough;
a full inventory of neighbouring features is not needed. If there is no passport yet,
that is no reason to stop an allowed fix: use the general rules and the code.

### 8.1. Creating modules only through the CLI

All new architectural modules of the application and the framework are created **only
by osnv CLI commands**. The rule covers atomic modules, composite roots and
atomic parts, including those added to an existing pack. Creating the scaffold by hand,
copying a neighbouring module and creating files from documentation examples
instead of running the CLI are forbidden.

| Kind | CLI command | Result |
| --- | --- | --- |
| Atomic without a ready implementation | `g module <Name> --empty` | The connection point and the passport |
| Atomic with CRUD | `g module <Name>` or `g module <Name> --minimal` | A sample CRUD and the passport |
| Extended atomic | `g module <Name> --full` | CRUD with extra adapters and the passport; this is one atomic module |
| Composite | `g pack <Name> --parts <part-a,part-b,...>` | The composition root and empty atomic parts with their own passports |

Commands run from the repository root through
`./scripts/osnv-bun run osnv <command>` with a qualified `OSNV_BUN_BIN`.
Path, connection and codegen parameters are described in the
[CLI passport](../../src/osnv/cli/MODULE.md). `--dry-run` shows the
plan; it does not replace actually creating the module.

After a successful generation the author fills in the domain responsibility, the input
fields and the other `MODULE.md` sections, records the actual creation command
and finishes the scaffold sources. For pack parts, the pack creation command
is recorded. The CLI sample fields do not become domain requirements.

If the CLI does not support the needed variant, location or adding a part,
first extend the generator and check the change, then run the creation
command. A generator error must be fixed; falling back to creating the
module by hand is not allowed.

Regular work on an existing module and on the sources of a created scaffold is allowed,
including adding models, services, DTOs and other needed components.
Codegen result files are updated only by the matching generator.
Modules that existed before this rule do not need to be recreated; an unknown
historical creation command must not be made up.

Mandatory reading of the specification and creation through the CLI are fixed in the root
`AGENTS.md`. These are rules for the agent's work and for review. There is currently no
automatic CI check proving that the specification was read or the CLI was run.

## 9. Change compliance criteria

- [ ] The module type is chosen by independent responsibility, not by layers.
- [ ] OOP/SOLID and simplicity of implementation are kept; extra abstractions
  have a concrete reason, significant trade-offs are described.
- [ ] For affected hot paths the costs and applicable performance metrics
  are assessed; claims of improvement are backed by measurements.
- [ ] The applicable failure, cancellation, partial completion and resource
  release scenarios are defined and checked; retries have safe bounds.
- [ ] Changes affecting the binary path are checked by building the affected target
  and a control run; environment limits and SKIPs are listed explicitly.
- [ ] Each new module is created by an actual CLI command; the command is recorded
  in its passport. The scaffold is not created by hand or copied from a neighbouring module.
- [ ] For a composite module the atomic parts and their contracts are listed;
  the root does the composition without repeated implementation registrations.
- [ ] Each changed component has its file, role, inputs and result stated.
- [ ] New file, class and method names follow the simple domain
  style from [AGENTS.md](../../AGENTS.md#code-naming) and the actual behaviour.
- [ ] For new/changed public inputs the fields, defaults,
  nullability, checks, outputs and errors are filled in; the passport matches the code.
- [ ] Dependencies, lifetime and DI exports are declared; there is no private API bypass
  and no duplicated ownership of ORM models, migrations and handlers.
- [ ] For a configuration change, the shared declaration and the view of
  each kernel are separated per §5.4; isolation is checked or the transitional state is described explicitly.
- [ ] Only the needed directories are created; other paths and public APIs are kept.
- [ ] The applicable behaviour is checked. Missing infrastructure, scripts,
  failed live checks and unavailable integrations are not reported as PASS.

The rules and the passport format are updated together with an approved architectural
decision. An unchanged historical layout alone is no reason
to reopen all existing modules.
