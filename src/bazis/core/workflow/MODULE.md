# WorkflowModule

Passport version: 1.1. Check date: 2026-10-31.
Status: implemented for stages 1–5 of [WORKFLOW-001](../../../../docs/architecture/WORKFLOW.md); checks below.
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
example bazis-cms); who may do what (the application's `AccessPolicy`,
ACCESS-001: the pack only declares permissions); the
Tools themselves (the modules that own the operations, TOOLS-001).

Priorities: no state in memory (restarts and several application instances
are safe); services registered the agreed way (`scoped(IContract, Implementation)`)
with the pack's generated wiring [generated/deps.ts](generated/deps.ts); pure
document functions in `library/workflow`.

## 2. Parts and dependencies

| Part | Passport | Owns | Depends on |
| --- | --- | --- | --- |
| Definitions | [definitions_module](definitions_module/MODULE.md) | `bazis_wf_def_*`: processes, versions | `library/workflow`, `ToolRunner` |
| Runtime | [runtime_module](runtime_module/MODULE.md) | `bazis_wf_run_*`: instances, tokens, jobs, subscriptions, history | Definitions (`IWorkflowDefinitions`), `ToolRunner`, `EventBus` |
| Tasks | [tasks_module](tasks_module/MODULE.md) | `bazis_wf_task_*`: tasks | Runtime (`IWorkflowRuntime`, its events), Definitions (`WorkflowClock`) |

Shared contracts of the pack (no providers): `contracts/WorkflowError.ts`,
`contracts/WorkflowInputValidator.ts` (field check port),
`contracts/WorkflowClock.ts` (the engine's time; registered by Definitions),
`contracts/types.ts`; internal helpers `internal/http.ts`, `internal/WorkflowTools.ts`.
Tests of processes: the entry `bazis/core/workflow/testing` ([testing/index.ts](testing/index.ts)):
`testWorkflow` starts the application with a `ManualWorkflowClock` and runs jobs
only in `drain` / `advance`.

## 3. Public inputs

`exports: [IWorkflowDefinitions, IWorkflowRuntime, IWorkflowTasks]`; the parts' HTTP under
`/workflow/...`; the `@Module` field `processes` with `defineProcess`; events `WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED`,
`WORKFLOW_INSTANCE_FINISHED`, `WORKFLOW_INSTANCES_DELETED`, and for the audit `WORKFLOW_PROCESS_CHANGED`, `WORKFLOW_INSTANCE_STARTED`,
`WORKFLOW_INSTANCE_CANCELLED`, `WORKFLOW_INSTANCE_RETRIED`, `WORKFLOW_TASK_COMPLETED`; settings `workflowRuntimeConfig` (prefix `workflow`).

## 4. Checks

- PASS `src/bazis/library/workflow/test/workflow.document.test.ts` — document validation, paths, conditions, forms, durations.
- PASS `src/bazis/core/workflow/test/workflow.postgres.contract.live.test.ts` on PostgreSQL 17: JSON:API lists, the draft lock, audit events with the request, `context.actor` and `context.metadata`.
- PASS `src/bazis/core/workflow/test/workflow.postgres.live.test.ts` on PostgreSQL 17
  (`BAZIS_WORKFLOW_PG_URL`, database `bazis_wf_*`; run by `ops/live-postgres`):
  closed HTTP without an access, catalog, draft with `unknown_tool`, publication once
  per document, start with an invalid input, Tools on behalf of the starter with the token
  as idempotency key and `caller: "workflow"` in the approval request, exclusive and
  parallel gateways, user task event and form check, cancel with `WORKFLOW_TOKEN_CLOSED`,
  failure and retry, retention, a second start over the existing stores; stage 2:
  `config.retry` with one idempotency key over three attempts, a `ToolError` reason
  routed to `boundaryError` without retries, `timerCatch` by duration and by date,
  interrupting and non-interrupting `boundaryTimer` on a user task; stage 3: a
  correlated `eventWait` through the service and HTTP, `eventStart` with the
  payload checked against the input, an interrupting `boundaryEvent` on a task,
  one schedule job under concurrent reconciles, a firing that starts an instance
  and plans the next minute, an archived process losing its job; stage 4: a role
  task in the inbox of its assignees only, claim / conflict / release, the form
  checked on completion, a completed task moving the process, a personal task,
  a cancelled instance cancelling its task, retention deleting the tasks of
  deleted instances.
- PASS `src/bazis/core/workflow/test/workflow.code.test.ts` — build-time errors of `processes`
  (document, form, one key per application, `WorkflowModule` missing), `inspectProcesses`,
  `ManualWorkflowClock`.
- PASS `src/bazis/core/workflow/test/workflow.postgres.code.live.test.ts` on PostgreSQL 17
  (stage 5, own database `bazis_wf_code_*`): publication at start once per document,
  `module` in the catalog, `conflict` on HTTP and service changes of a code process,
  archive kept over a restart, a changed document as the next version, a process
  removed from code becoming the catalog's own, an unknown Tool stopping the start;
  `testWorkflow`: no worker behind the test, `drain`, `complete` through the task,
  a boundary timer by `advance`, a schedule firing by the clock and no catch-up after
  three days.
- PASS `src/bazis/library/workflow/test/workflow.mermaid.test.ts`, `src/bazis/cli/test/workflow.cli.test.ts`.
- Not checked: OpenAPI of the workflow routes (the framework's controllers read
  `HttpContext` directly and do not appear in the application's OpenAPI document).
