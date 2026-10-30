# WorkflowDefinitionsModule

Passport version: 1.0. Check date: 2026-10-31.
Status: implemented; checks in the [pack passport](../MODULE.md#4-checks).
Type: atomic, a part of the composite [WorkflowModule](../MODULE.md).
Path: `src/bazis/core/workflow/definitions_module`.
Connection point: [WorkflowDefinitions.module.ts](WorkflowDefinitions.module.ts), class `WorkflowDefinitionsModule`.

## 1. Responsibility

The process catalog: a process by key with names, a draft a designer edits
and the retention period; publication of the draft as an immutable version.
Validation is `validateProcess` of `bazis/library/workflow` with the Tools
whose `callers` list `workflow`.

## 2. Components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| `WfProcess`, `WfVersion`, `DefinitionsDbContext` | [model](model) | ORM, owned store `bazis.workflow.definitions` | tables `bazis_wf_def_processes`, `bazis_wf_def_versions` |
| `IWorkflowDefinitions` / `WorkflowDefinitions` (scoped) | [services](services) | `DefinitionsDbContext`, `WorkflowTools` | catalog operations, `WorkflowError` |
| `WorkflowTools` (singleton) | [../internal/WorkflowTools.ts](../internal/WorkflowTools.ts) | `ToolRunner.as("workflow")` if the application has Tools | which Tools a service task may call, their contracts |
| `ProcessesController` | [http/Processes.controller.ts](http/Processes.controller.ts) | `IWorkflowDefinitions`, `WorkflowAccess` | `/workflow/processes…`, `/workflow/tools` |

exports: `[IWorkflowDefinitions, WorkflowTools]`.

## 3. Data

`bazis_wf_def_processes`: `id` uuid v7, `key` unique, `title`, `description`,
`draft` json, `draftUpdatedAt/ByKind/ById`, `latestVersion`, `retentionDays`,
`archivedAt`, `createdAt`, `updatedAt`.
`bazis_wf_def_versions`: `id` uuid v7, `processId` (FK, cascade), `version`
(unique with `processId`), `document` json, `documentHash` (sha-256 of the
canonical JSON), `publishedAt`, `publishedByKind/ById`.

Publishing holds the process row `FOR UPDATE`; the same document again returns
the latest version instead of a new one.

## 4. HTTP

| Route | Right | Result |
| --- | --- | --- |
| `GET /workflow/processes?archived&search&limit&offset` | `processes.read` | `{ data, meta: { total } }` |
| `POST /workflow/processes` `{ key, title, description?, retentionDays? }` | `processes.manage` | 201 / 409 `conflict` / 422 |
| `GET /workflow/processes/:key` | `processes.read` | process with the draft / 404 |
| `PATCH /workflow/processes/:key` `{ title?, description?, retentionDays?, archived? }` | `processes.manage` | 200 |
| `PUT /workflow/processes/:key/draft` `{ document }` | `processes.manage` | 200 `{ issues }` |
| `POST /workflow/processes/:key/publish` | `processes.publish` | 201 version / 409 `archived` / 422 `invalid_document` with issues |
| `GET /workflow/processes/:key/versions` | `processes.read` | `{ data }`, newest first |
| `GET /workflow/processes/:key/versions/:version` | `processes.read` | version with the document |
| `GET /workflow/tools` | `processes.read` | `{ data }`: Tool contracts with JSON schemas |
