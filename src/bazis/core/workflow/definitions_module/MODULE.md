# WorkflowDefinitionsModule

Passport version: 1.1. Check date: 2026-11-01.
Status: implemented; checks in the [pack passport](../MODULE.md#4-checks).
Type: atomic, a part of the composite [WorkflowModule](../MODULE.md).
Path: `src/bazis/core/workflow/definitions_module`.
Connection point: [WorkflowDefinitions.module.ts](WorkflowDefinitions.module.ts), class `WorkflowDefinitionsModule`.

## 1. Responsibility

The process catalog: a process by key with names, a draft a designer edits
and the retention period; publication of the draft as an immutable version.
Validation is `validateProcess` of `bazis/library/workflow` with the Tools
whose `callers` list `workflow`. Processes declared in code
(`@Module({ processes })`, `defineProcess`) are checked when the container is
built and published at start; they change only through the code.
The part provides the pack's `WorkflowClock`.

## 2. Components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| `WfProcess`, `WfVersion`, `DefinitionsDbContext` | [model](model) | ORM, owned store `bazis.workflow.definitions.v2` | tables `bazis_wf2_def_processes`, `bazis_wf2_def_versions` |
| `IWorkflowDefinitions` / `WorkflowDefinitions` (scoped) | [services](services) | `DefinitionsDbContext`, `WorkflowTools`, `CodeProcessCatalog`, `WorkflowClock`, `WorkflowEvents` | catalog operations, `WorkflowError`; `conflict` on changes of a process declared in code and on an out-of-date `expected` of a draft; `publishCode`; `WORKFLOW_PROCESS_CHANGED` after the commit |
| `defineProcess`, the `processes` channel | [code/defineProcess.ts](code/defineProcess.ts), [code/codeProcesses.ts](code/codeProcesses.ts) | module-owned metadata of DI | build-time check: the fields, the document without Tools, one key per application, `WorkflowModule` imported; `WorkflowSetupError` as a configuration error |
| `CodeProcessCatalog` (singleton) | [code/CodeProcessCatalog.ts](code/CodeProcessCatalog.ts) | the container's contributions | which module owns a key (`ProcessSummary.module`) |
| `CodeProcessPublisher` (hosted, phase 0) | [code/CodeProcessPublisher.ts](code/CodeProcessPublisher.ts) | `CodeProcessCatalog`, `WorkflowTools`, `WorkflowDefinitions` | after the schema: checks with the Tools (an unknown Tool stops the start), then publishes under `pg_advisory_xact_lock(hashtext('bazis.workflow.code'))` as `{ kind: "system", id: "code" }` |
| `inspectProcesses` | [code/inspectProcesses.ts](code/inspectProcesses.ts) | the module tree, `@Tool` metadata | the checks of build and start without the container, for `bazis workflow check` |
| `WorkflowClock` (singleton) | [../contracts/WorkflowClock.ts](../contracts/WorkflowClock.ts) | — | the engine's time; `SystemWorkflowClock` by default |
| `WorkflowEvents` (scoped) | [../internal/WorkflowEvents.ts](../internal/WorkflowEvents.ts) | `EventBus`, the scope, `Logger` | publishes in the scope of the action; a failing handler is logged |
| `WorkflowTools` (singleton) | [../internal/WorkflowTools.ts](../internal/WorkflowTools.ts) | `ToolRunner.as("workflow")` if the application has Tools | which Tools a service task may call, their contracts |
| `ProcessesController` | [http/Processes.controller.ts](http/Processes.controller.ts) | `IWorkflowDefinitions`, `IAccess` | `/workflow/processes…`, `/workflow/tools` |
| `ProcessReferences` (scoped) | [access/Process.references.ts](access/Process.references.ts) | `DefinitionsDbContext` | reference kind `workflow.process`: what an administrator picks in a condition |

exports: `[IWorkflowDefinitions, WorkflowTools, WorkflowClock, WorkflowEvents]`.
Permissions: `workflow.processes.*` ([access/Definitions.permissions.ts](access/Definitions.permissions.ts)), without a partition until `WorkflowPartitions` (WORKFLOW-002 stage 4).

## 3. Data

`bazis_wf2_def_processes`: `id` uuid v7, `key` unique, `title` and `description` (`LocalizedText`), `titleText`, `folder`, `owner`,
`draft` json, `draftUpdatedAt/ByKind/ById`, `latestVersion`, `retentionDays`,
`archivedAt`, `createdAt`, `updatedAt`.
`bazis_wf2_def_versions`: `id` uuid v7, `processId` (FK, cascade), `version`
(unique with `processId`), `document` json, `documentHash` (sha-256 of the
canonical JSON), `publishedAt`, `publishedByKind/ById`.

Publishing holds the process row `FOR UPDATE`; the same document again returns
the latest version instead of a new one. Ownership by code is not stored: it is
known from the modules, so a process removed from code becomes the catalog's own.

## 4. HTTP

| Route | Right | Result |
| --- | --- | --- |
| `GET /workflow/processes?filter[archived]&filter[search]&sort&page[size]&page[number]` | `workflow.processes.read` | JSON:API list document |
| `POST /workflow/processes` `{ key, title, description?, retentionDays? }` | `workflow.processes.manage` | 201 / 409 `conflict` / 422 |
| `GET /workflow/processes/:key` | `workflow.processes.read` | process with the draft / 404 |
| `PATCH /workflow/processes/:key` `{ title?, description?, retentionDays?, archived? }` | `workflow.processes.manage` | 200 |
| `PUT /workflow/processes/:key/draft` `{ document }` | `workflow.processes.manage` | 200 `{ issues }` |
| `POST /workflow/processes/:key/publish` | `workflow.processes.publish` | 201 version / 409 `archived` / 422 `invalid_document` with issues |
| `GET /workflow/processes/:key/versions` | `workflow.processes.read` | `{ data }`, newest first |
| `GET /workflow/processes/:key/versions/:version` | `workflow.processes.read` | version with the document |
| `GET /workflow/tools` | `workflow.processes.read` | `{ data }`: Tool contracts with JSON schemas |
