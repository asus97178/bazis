# WorkflowRuntimeModule

Passport version: 1.1. Check date: 2026-10-31.
Status: implemented for stage 1 of WORKFLOW-001; checks in the [pack passport](../MODULE.md#4-checks).
Type: atomic, a part of the composite [WorkflowModule](../MODULE.md).
Path: `src/bazis/core/workflow/runtime_module`.
Connection point: [WorkflowRuntime.module.ts](WorkflowRuntime.module.ts), class `WorkflowRuntimeModule`; imports `WorkflowDefinitionsModule`.

## 1. Responsibility

Runs published versions. An instance is bound to its version; tokens mark
where execution is. No state lives in memory: one engine step is one
transaction holding the instance row `FOR UPDATE` over the five tables of the
part, which is why they have one owner.

Executes every node kind of `bazis.workflow/v1` (stages 1–3): manual, event
and scheduled starts, end, `serviceTask` with `config.retry`, `boundaryError`,
`userTask` as a wait, `timerCatch`, `eventWait`, `boundaryTimer` and
`boundaryEvent` (interrupting or not), exclusive and parallel gateways, cancel,
retry, `emit`.

## 2. Components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| 5 entities, `RuntimeDbContext` | [model](model) | ORM, owned store `bazis.workflow.runtime` | `bazis_wf_run_instances`, `_tokens`, `_jobs`, `_subscriptions`, `_history` |
| `WorkflowEngine` (scoped) | [internal/WorkflowEngine.ts](internal/WorkflowEngine.ts) | `RuntimeDbContext`, `IWorkflowDefinitions`, `GraphCache`, `WorkflowEvents`, `WorkflowClock` | token moves, gateways, finish, cancel, retry; events after commit; due times by the clock |
| `GraphCache` (singleton) | [internal/GraphCache.ts](internal/GraphCache.ts) | — | graphs of versions, up to 500 |
| `ToolStep` (scoped) | [internal/ToolStep.ts](internal/ToolStep.ts) | `RuntimeDbContext`, `WorkflowEngine`, `WorkflowTools` | one `tool` job: `ToolRunner.as("workflow").run(tool, input, { actor, idempotencyKey: tokenId, metadata })`; a retry keeps the job with a later `dueAt`; a final failure goes to `WorkflowEngine.failStep` (error boundary or `failed`) |
| `TimerStep` (scoped) | [internal/TimerStep.ts](internal/TimerStep.ts) | `RuntimeDbContext`, `WorkflowEngine` | one `timer` job: `timerCatch` moves on, `boundaryTimer` takes its flow |
| `Schedules` (scoped) | [internal/Schedules.ts](internal/Schedules.ts) | `RuntimeDbContext`, `WorkflowEngine`, `IWorkflowDefinitions` | one `schedule` job per scheduled latest version (reconciled at start and every minute under an advisory lock); a firing starts instances and plans the next from now in one transaction: missed firings are not caught up |
| `EventsController` | [http/Events.controller.ts](http/Events.controller.ts) | `IWorkflowRuntime`, `IAccess` | `POST /workflow/events/:eventKey` |
| `IWorkflowRuntime` / `WorkflowRuntime` (scoped) | [services](services) | engine, `IWorkflowDefinitions`, `WorkflowInputValidator` (`DefaultWorkflowInputValidator`, replaced by the application's own registration) | start, cancel, retry, completeToken, lists, history |
| `InstancesController` | [http/Instances.controller.ts](http/Instances.controller.ts) | `IWorkflowRuntime`, `IAccess` | `/workflow/instances…` |
| `WorkflowJobs` | [internal/WorkflowJobs.ts](internal/WorkflowJobs.ts) | `SERVICE_PROVIDER` | claims due jobs `FOR UPDATE SKIP LOCKED` ordered by id, lease 5 min, runs each in its own scope; used by the worker and by `testWorkflow`'s `drain` |
| `WorkflowWorker` | [background/WorkflowWorker.ts](background/WorkflowWorker.ts) | `SERVICE_PROVIDER`, settings | `WorkflowJobs` every `worker.intervalMs`; a full batch is followed at once; idle with a manual `WorkflowClock` |
| `WorkflowRetention` | [background/WorkflowRetention.ts](background/WorkflowRetention.ts) | `SERVICE_PROVIDER`, settings, `IWorkflowDefinitions`, `WorkflowClock` | deletes old `completed`/`cancelled` instances (cascade); idle with a manual clock |
| events | [events/Runtime.events.ts](events/Runtime.events.ts) | `WorkflowEvents` | `WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED`, `WORKFLOW_INSTANCE_FINISHED`, and for the audit `WORKFLOW_INSTANCE_STARTED`, `WORKFLOW_INSTANCE_CANCELLED`, `WORKFLOW_INSTANCE_RETRIED` (after the step commits), `WORKFLOW_INSTANCES_DELETED` (after each retention batch) |

exports: `[IWorkflowRuntime]`. config: `workflowRuntimeConfig`.

## 3. Settings (`workflow.*`)

| Key | Default | Env |
| --- | --- | --- |
| `worker.enabled` | `true` | `BAZIS_WORKFLOW__WORKER__ENABLED` |
| `worker.intervalMs` | `1000` | `BAZIS_WORKFLOW__WORKER__INTERVALMS` |
| `worker.batchSize` | `10` | `BAZIS_WORKFLOW__WORKER__BATCHSIZE` |
| `retention.enabled` | `true` | `BAZIS_WORKFLOW__RETENTION__ENABLED` |
| `retention.intervalMs` | `3600000` | `BAZIS_WORKFLOW__RETENTION__INTERVALMS` |
| `retention.batchSize` | `500` | `BAZIS_WORKFLOW__RETENTION__BATCHSIZE` |

## 4. HTTP

| Route | Right (target) | Result |
| --- | --- | --- |
| `POST /workflow/instances` `{ processKey, input?, partition?, businessKey? }` | `workflow.instances.start` (partition of the request, process) | 201 instance with tokens / 404 / 409 `archived` / 422 `invalid_input` |
| `GET /workflow/instances?filter[partition\|status\|processKey\|businessKey\|startedById]&sort&page[size]&page[number]` | `workflow.instances.read`, the list is filtered by its grants | JSON:API list document, newest first |
| `GET /workflow/instances/:id` | `workflow.instances.read` (the instance) | instance with tokens |
| `GET /workflow/instances/:id/history` | `workflow.instances.read` | `{ data }` in order |
| `POST /workflow/instances/:id/cancel` `{ reason? }` | `workflow.instances.manage` | 200 / 409 `wrong_status` |
| `POST /workflow/instances/:id/retry` | `workflow.instances.manage` | 200 / 409 `wrong_status` (not `failed`) |
| `POST /workflow/events/:eventKey` `{ payload?, correlation?, partition? }` | `workflow.events.emit` (partition of the request, event) | 202 `{ started, continued, rejected }` |

The tasks HTTP is the [Tasks part](../tasks_module/MODULE.md).

## 5. Known limits of stage 1

- A job that fails outside the Tool (for example the database is down) waits a
  minute per attempt and fails its step with `job_failed` after 5 attempts.
- References are `text` columns; a foreign key makes them native uuid. 0.124–0.125
  declared them `type: "uuid"`, which the ORM fills with a generated value when
  empty: instance-level history entries got a random `tokenId` (cleanup SQL in
  `reference/upgrading.md`, 0.126.0).
- Boundary tokens find their step by its node: two live tokens on one step node
  (possible only in a loop) share its boundary timers.
- A route needs its permission anywhere (`can`), then the handler checks the
  loaded instance: without the right 403 for any id; with a right elsewhere an
  unknown id answers 404 and a foreign one 403.
