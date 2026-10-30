# WorkflowRuntimeModule

Passport version: 1.0. Check date: 2026-10-31.
Status: implemented for stage 1 of WORKFLOW-001; checks in the [pack passport](../MODULE.md#4-checks).
Type: atomic, a part of the composite [WorkflowModule](../MODULE.md).
Path: `src/bazis/core/workflow/runtime_module`.
Connection point: [WorkflowRuntime.module.ts](WorkflowRuntime.module.ts), class `WorkflowRuntimeModule`; imports `WorkflowDefinitionsModule`.

## 1. Responsibility

Runs published versions. An instance is bound to its version; tokens mark
where execution is. No state lives in memory: one engine step is one
transaction holding the instance row `FOR UPDATE` over the five tables of the
part, which is why they have one owner.

Stage 1 executes: manual start, end, `serviceTask`, `userTask` as a wait,
exclusive and parallel gateways, cancel, retry. `timerCatch` and `eventWait`
fail the instance with `not_supported` until stages 2–3; boundary nodes and
`config.retry` are validated but not executed yet.

## 2. Components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| 5 entities, `RuntimeDbContext` | [model](model) | ORM, owned store `bazis.workflow.runtime` | `bazis_wf_run_instances`, `_tokens`, `_jobs`, `_subscriptions`, `_history` |
| `WorkflowEngine` (scoped) | [internal/WorkflowEngine.ts](internal/WorkflowEngine.ts) | `RuntimeDbContext`, `IWorkflowDefinitions`, `GraphCache`, `EventBus`, the scope | token moves, gateways, finish, cancel, retry; events after commit |
| `GraphCache` (singleton) | [internal/GraphCache.ts](internal/GraphCache.ts) | — | graphs of versions, up to 500 |
| `ToolStep` (scoped) | [internal/ToolStep.ts](internal/ToolStep.ts) | `RuntimeDbContext`, `WorkflowEngine`, `WorkflowTools` | one `tool` job: `ToolRunner.as("workflow").run(tool, input, { actor, idempotencyKey: tokenId, metadata })` |
| `IWorkflowRuntime` / `WorkflowRuntime` (scoped) | [services](services) | engine, `IWorkflowDefinitions`, `WorkflowInputValidator` (the application's or the built-in one) | start, cancel, retry, completeToken, lists, history |
| `InstancesController` | [http/Instances.controller.ts](http/Instances.controller.ts) | `IWorkflowRuntime`, `WorkflowAccess` | `/workflow/instances…` |
| `WorkflowWorker` | [background/WorkflowWorker.ts](background/WorkflowWorker.ts) | `SERVICE_PROVIDER`, settings | claims due jobs `FOR UPDATE SKIP LOCKED` ordered by id, lease 5 min; a full batch is followed at once |
| `WorkflowRetention` | [background/WorkflowRetention.ts](background/WorkflowRetention.ts) | `SERVICE_PROVIDER`, settings, `IWorkflowDefinitions` | deletes old `completed`/`cancelled` instances (cascade) |
| events | [events/Runtime.events.ts](events/Runtime.events.ts) | `EventBus` | `WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED`, `WORKFLOW_INSTANCE_FINISHED` |

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
| `POST /workflow/instances` `{ processKey, input?, partition?, businessKey? }` | `instances.start` (processKey, partition) | 201 instance with tokens / 404 / 409 `archived` / 422 `invalid_input` |
| `GET /workflow/instances?partition&status&processKey&businessKey&startedById&limit&offset` | `instances.read` (partition, processKey) | `{ data, meta: { total } }`, newest first |
| `GET /workflow/instances/:id` | `instances.read` (the instance's partition) | instance with tokens |
| `GET /workflow/instances/:id/history` | `instances.read` | `{ data }` in order |
| `POST /workflow/instances/:id/cancel` `{ reason? }` | `instances.manage` | 200 / 409 `wrong_status` |
| `POST /workflow/instances/:id/retry` | `instances.manage` | 200 / 409 `wrong_status` (not `failed`) |

Events and the tasks HTTP come with stages 3 and 4.

## 5. Known limits of stage 1

- A job that fails outside the Tool (for example the database is down) is taken
  again after its lease, with no attempt limit; bounded retries come with stage 2.
- The read routes load the instance before asking `WorkflowAccess`, so an
  unknown id answers 404 before 403.
