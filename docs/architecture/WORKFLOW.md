# Business processes in the framework

Identifier: **WORKFLOW-001**. Version: **1.0 (draft for review)**. Date: **2026-10-31**.
Status: **proposal; waits for the user's decisions in §11**.
Basis: the user asked to finish business processes in the framework itself: no
UI (that is the CMS's job), but everything a process needs to be designed well
and to run reliably under the hood. bazis-cms already has a process catalog,
drafts, versions and a validated document (`cms.workflow/v1`, merged) and an
engine in review (bazis-cms#8). This document moves the general part of that
work into bazis and leaves the product part in the CMS.

Steps that act call Tools per [TOOLS-001](TOOLS.md) as the caller `workflow`.

## 1. What goes where

| In bazis (`bazis/core/workflow`) | Stays in the application (bazis-cms) |
| --- | --- |
| The process document format, its node kinds and its validation | The designer, BPMN rendering, the diagram layout |
| Published versions (immutable) and their lookup by key | Drafts, the catalog UI, names and descriptions in languages |
| Instances, tokens, jobs and history in PostgreSQL | Spaces, who may start a process, admin HTTP |
| The engine: start, step, gateways, timers, events, boundaries, retries, cancel | The task inbox, resolving a role to people, task UI |
| Service tasks through `ToolRunner.as("workflow")` | Which Tools a module offers to processes (`callers`) |
| Human task waits, `completeTask`, task events | Form field types (the data manager) through the input validator hook |
| Retention of finished instances | The retention period of each process (passed at publish) |

## 2. The process document (`bazis.workflow/v1`)

The format of bazis-cms (`cms.workflow/v1`) becomes the framework format under
the name `bazis.workflow/v1`, unchanged in meaning:

```json
{
  "schemaVersion": "bazis.workflow/v1",
  "input": { "fields": [{ "code": "amount", "type": "number", "required": true }] },
  "nodes": {
    "Start": { "kind": "manualStart", "title": "Start" },
    "Pay": { "kind": "serviceTask", "title": "Pay", "config": { "tool": "payments.charge", "input": { "amount": "$input.amount" }, "saveTo": "payment" } },
    "End": { "kind": "end", "title": "End" }
  },
  "flows": { "f1": { "source": "Start", "target": "Pay" }, "f2": { "source": "Pay", "target": "End" } },
  "diagram": {}
}
```

- Thirteen node kinds: `manualStart`, `scheduleStart`, `eventStart`, `serviceTask`,
  `userTask`, `timerCatch`, `eventWait`, `exclusiveGateway`, `parallelGateway`,
  `boundaryError`, `boundaryTimer`, `boundaryEvent`, `end`; their `config` and graph
  roles as in bazis-cms.
- Data paths `$input.x`, `$vars.x`, `$nodes.Node.x`; conditions `all/any/not` and
  `eq, ne, gt, gte, lt, lte, in, contains, empty, notEmpty`; one default flow per
  exclusive gateway.
- `diagram` is opaque to the framework: stored and returned, never interpreted.
- `input.fields` are checked by a pluggable **input validator** (§7): the framework
  ships a simple one (string, number, boolean, date, enum, required); the CMS plugs
  its data-manager rules.
- `validateProcess(document, { tools })` returns all issues with codes and the node
  or flow (`no_start`, `unknown_tool`, `config_invalid`, …); a `serviceTask` must
  name a Tool whose `callers` include `workflow`.
- Limits: 500 nodes, 1000 flows, 1 MB, condition depth 8.

## 3. Versions

`WorkflowDefinitions.publish(key, document, { retentionDays? })` validates the
document and stores an immutable version (`key`, `version` 1, 2, 3…). An instance
runs on the version it started with; a new version does not touch it.
`latest(key)`, `version(key, n)`, `versions(key)`. The application owns drafts and
its catalog and calls `publish` when its own rules allow it.

## 4. Storage

An [owned store](../guide/database/owned-stores.md) `bazis.workflow`, tables with
the prefix `bazis_wf_`:

| Table | Holds |
| --- | --- |
| `bazis_wf_versions` | key, version, document, retentionDays, publishedAt |
| `bazis_wf_instances` | version, `partition` (the app's scope, e.g. a space), status (`running`, `completed`, `cancelled`, `failed`), input, vars, nodes, businessKey, startedBy (actor), error, endedAt |
| `bazis_wf_tokens` | instance, node, via flow, status (`active`, `waiting`, `done`, `cancelled`, `failed`), output |
| `bazis_wf_jobs` | instance, token, kind (`tool`, `timer`, `retry`, `schedule`), dueAt, attempts, lease, lastError |
| `bazis_wf_subscriptions` | waits for events: instance, token, event key, correlation |
| `bazis_wf_history` | every step: entered, left, tool, timer, event, error, retried, cancelled, completed |

`partition` is a free string the application uses for its scope (a space, an
organization); the framework filters by it and never interprets it.

## 5. The engine

- **No state in memory.** Every change is one transaction with the instance row
  under `FOR UPDATE`; a restart or a second application instance loses nothing.
- **Tokens** move along flows until each waits or ends; the instance is completed
  when no live token is left.
- **Jobs** (`bazis_wf_jobs`) are created in the same transaction as the token that
  waits. A framework background worker claims them with `FOR UPDATE SKIP LOCKED`
  and a lease, runs the work outside the transaction and applies the result in a
  step transaction; a token closed meanwhile drops the result.
- **Service task:** `ToolRunner.as("workflow").run(tool, input, { actor,
  idempotencyKey: tokenId, metadata: { instanceId, partition, processKey, nodeId } })`.
  The actor is the instance's starter (or `system` for scheduled and event starts).
  The approval policy of `TOOL_EXECUTION_OPTIONS` decides as for any caller; there
  is no silent bypass. Tool audit goes to the configured sink and the history.
- **Retries:** a failed Tool call is retried by `config.retry` (`maxAttempts`,
  `backoff`) of the node or the engine default; then a `boundaryError` with a
  matching `errorCode` takes the token, otherwise the instance becomes `failed`
  and waits for `retry` or `cancel`.
- **Gateways:** exclusive (first true condition in document order, else default,
  else `no_branch`), parallel split and join.
- **Timers:** `timerCatch` and `boundaryTimer` (interrupting or not) are jobs with
  `dueAt` (`duration` ISO 8601 without months and years, or `at` from a path).
- **Events:** `workflow.emit(eventKey, payload, { correlation?, partition? })`
  starts processes with a matching `eventStart`, continues tokens waiting in
  `eventWait` and fires `boundaryEvent`; matching uses the subscription table in
  the same transaction. An application may bridge `EventBus` events to `emit`.
- **Schedules:** `scheduleStart` (cron, five fields) creates a `schedule` job per
  published latest version; the next one is planned when it fires.
- **Human tasks:** `userTask` makes the token wait and publishes
  `WORKFLOW_TASK_REQUESTED` (instance, token, node, assignee, form, due) through
  `EventBus`; `workflow.completeTask(tokenId, output, actor)` validates the output
  with the form and moves on; `WORKFLOW_TOKEN_CLOSED` tells the application to drop
  a task when the token is cancelled. The inbox and assignment stay in the app.
- **Cancel and retry** of an instance; cancel closes tokens, jobs and subscriptions.
- **Retention:** finished instances of versions with `retentionDays` are deleted in
  batches by a background job; failed ones are kept.

## 6. Public API (`bazis/core/workflow`)

```ts
@Module({ imports: [workflowModule({ worker: { intervalMs: 1000, batch: 10 } })] })
export class AppModule {}

constructor(private readonly workflow: Workflow) {}

await this.workflow.definitions.publish("vacation", document, { retentionDays: 365 });
const instance = await this.workflow.start("vacation", { input, partition: spaceId, actor, businessKey: "req:42" });
await this.workflow.completeTask(tokenId, { approved: true }, actor);
await this.workflow.emit("payments.received", payload, { correlation: "req:42" });
await this.workflow.cancel(instance.id, { reason, actor });
await this.workflow.retry(instance.id, { actor });
await this.workflow.instances.list({ partition, status, processKey, businessKey });
await this.workflow.instances.history(instance.id);
```

Errors are `WorkflowError` with codes (`not_found`, `invalid_document`,
`invalid_input` with issues, `wrong_status`, `unknown_process`). Events:
`WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED`, `WORKFLOW_INSTANCE_FINISHED`.

## 7. Extension points

- `inputValidator`: checks `input.fields` and task forms (default built in; the CMS
  passes its data-manager validator).
- `taskAssignee` stays data: the framework passes `config.assignee` as written.
- Node kinds are closed in v1: new kinds come with a new document version, not
  with application plugins, so stored versions keep their meaning.

## 8. Reliability and security

- Exactly one worker applies a job (lease + `SKIP LOCKED`); a Tool may run again
  after a crash between the call and the step transaction, so `write` Tools must
  honour `idempotencyKey` (TOOLS-001 §7).
- A process can only call Tools whose `callers` include `workflow`; the document
  validation and the runner both check it.
- Instances keep the actor who started them; Tool calls run on their behalf.
- Data paths never read `__proto__` and similar keys; conditions have no code.

## 9. Migration of bazis-cms

The CMS keeps `wf_processes` (catalog, draft, names, spaces, starters) and calls
`definitions.publish` on publish; it drops its own `wf_instances`, `wf_tokens`,
`wf_jobs`, `wf_history`, `WorkflowEngine`, `ToolStep`, `WorkflowWorker`,
`RetentionCleaner`, `nodeKinds`, `validateDocument` and `instanceData`, and keeps
its HTTP, task inbox and data-manager validator. The document schema version
moves from `cms.workflow/v1` to `bazis.workflow/v1` (same content).

## 10. Delivery

One minor release per stage, each with tests on PostgreSQL and the guide chapter:

1. Document, validation, versions, storage, start/end, service tasks, exclusive and
   parallel gateways, cancel/retry, history (what bazis-cms#8 does today).
2. Retries and error boundaries; timers (catch and boundary); retention.
3. Events (start, wait, boundary) and schedules.
4. Human tasks (`completeTask`, events, form validation).

## 11. Decisions for the user

1. **Versions live in bazis** (`bazis_wf_versions`), drafts and the catalog stay in
   the app. Alternative: the app stores versions and gives the engine a port.
2. **Storage is an owned store** with the `bazis_wf_` prefix (the framework owns
   the tables and checks them). Alternative: ordinary ORM tables of a module.
3. **Human tasks:** the framework only waits, publishes events and takes
   `completeTask`; the task table and inbox are the app's. Alternative: a task table
   in the framework too.
4. **Delivery in four stages** as in §10, or all at once.
