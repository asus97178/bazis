# WorkflowModule

Passport version: 1.0. Check date: 2026-10-31.
Status: implemented for stage 1 of [WORKFLOW-001](../../../../docs/architecture/WORKFLOW.md); checks below.
Type: composite.
Path: `src/bazis/core/workflow`.
Connection point: [Workflow.module.ts](Workflow.module.ts), class `WorkflowModule`; public entry `bazis/core/workflow`.
Passport scope: the whole pack.
Scaffold creation: framework module, written by hand (the CLI generates application modules).

## 1. Responsibility and choice of structure

Purpose: business processes without a UI — a catalog of processes and their
published versions, and the execution of those versions with Tools as steps.
Why composite: the catalog (drafts, immutable versions) and the execution
(instances, tokens, jobs, history) change for different reasons and have
separate data; an application may use the catalog alone.
What is outside: the designer, task inbox and forms UI (the application, for
example bazis-cms); who may do what (the application's `WorkflowAccess`); the
Tools themselves (the modules that own the operations, TOOLS-001).

Priorities: no state in memory (restarts and several application instances
are safe); explicit DI dependencies, because the framework's classes are not
covered by the application's codegen; pure document functions in
`library/workflow`.

## 2. Parts and dependencies

| Part | Passport | Owns | Depends on |
| --- | --- | --- | --- |
| Definitions | [definitions_module](definitions_module/MODULE.md) | `bazis_wf_def_*`: processes, versions | `library/workflow`, `ToolRunner` |
| Runtime | [runtime_module](runtime_module/MODULE.md) | `bazis_wf_run_*`: instances, tokens, jobs, subscriptions, history | Definitions (`IWorkflowDefinitions`), `ToolRunner`, `EventBus` |
| Tasks | — | stage 4 of WORKFLOW-001, not implemented | Runtime |

Shared contracts of the pack (no providers): `access/WorkflowAccess.ts` (HTTP
rights port, default: closed), `contracts/WorkflowError.ts`,
`contracts/WorkflowInputValidator.ts` (field check port), `contracts/types.ts`;
internal helpers `internal/http.ts`, `internal/WorkflowTools.ts`.

## 3. Public inputs

`exports: [IWorkflowDefinitions, IWorkflowRuntime]`; the parts' HTTP under
`/workflow/...`; events `WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED`,
`WORKFLOW_INSTANCE_FINISHED`; settings `workflowRuntimeConfig` (prefix `workflow`).

## 4. Checks

- PASS `src/bazis/library/workflow/test/workflow.document.test.ts` — document validation, paths, conditions, forms, durations.
- PASS `src/bazis/core/workflow/test/workflow.postgres.live.test.ts` on PostgreSQL 17
  (`BAZIS_WORKFLOW_PG_URL`, database `bazis_wf_*`; run by `ops/live-postgres`):
  closed HTTP without an access, catalog, draft with `unknown_tool`, publication once
  per document, start with an invalid input, Tools on behalf of the starter with the token
  as idempotency key and `caller: "workflow"` in the approval request, exclusive and
  parallel gateways, user task event and form check, cancel with `WORKFLOW_TOKEN_CLOSED`,
  failure and retry, retention, a second start over the existing stores.
- Not checked: OpenAPI of the workflow routes (the framework's controllers read
  `HttpContext` directly and do not appear in the application's OpenAPI document).
