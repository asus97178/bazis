# WorkflowTasksModule

Passport version: 1.1. Check date: 2026-10-31.
Status: implemented (stage 4 of WORKFLOW-001); checks in the [pack passport](../MODULE.md#4-checks).
Type: atomic, a part of the composite [WorkflowModule](../MODULE.md).
Path: `src/bazis/core/workflow/tasks_module`.
Connection point: [WorkflowTasks.module.ts](WorkflowTasks.module.ts), class `WorkflowTasksModule`; imports `WorkflowRuntimeModule`.

## 1. Responsibility

The inbox of `userTask` steps: who a task is for, its form and deadline, who
took it, and completing it. The task follows its step through events of the
Runtime part; completing a task completes the step through
`IWorkflowRuntime.completeToken`, which checks the form. Resolving a role to
people stays with the application (`WorkflowAccess.assignees`).

## 2. Components

| Component | File | Dependencies | Output |
| --- | --- | --- | --- |
| `WfTask`, `TasksDbContext` | [model](model) | ORM, owned store `bazis.workflow.tasks` | table `bazis_wf_task_items` |
| `IWorkflowTasks` / `WorkflowTasks` (scoped) | [services](services) | `TasksDbContext`, `IWorkflowRuntime`, `WorkflowClock` | `list`, `get`, `claim`, `release`, `complete` |
| `TaskEvents` (scoped subscriber) | [events/TaskEvents.ts](events/TaskEvents.ts) | `WorkflowTasks` | `WORKFLOW_TASK_REQUESTED` creates the task (one per token), `WORKFLOW_TOKEN_CLOSED` cancels it, `WORKFLOW_INSTANCES_DELETED` deletes the tasks of deleted instances |
| `TasksController` | [http/Tasks.controller.ts](http/Tasks.controller.ts) | `IWorkflowTasks`, `WorkflowAccess` | `/workflow/tasks…` |

exports: `[IWorkflowTasks]`.

## 3. Data

`bazis_wf_task_items`: `id` uuid v7, `tokenId` (unique), `instanceId`,
`processKey`, `nodeId`, `partition`, `title`, `assignee` (`role:<code>` or
`user:<id>`), `form` json, `dueAt`, `status` (`open`, `claimed`, `completed`,
`cancelled`), `claimedById`, `claimedAt`, `completedById`, `completedAt`,
`output` json, `createdAt`. References are text: they point into the Runtime
store. Indexes `(assignee, status)`, `(partition, status)`, `instanceId`.

## 4. HTTP

A task is visible to a caller when its `assignee` is one of
`WorkflowAccess.assignees(ctx, actor)` or the caller claimed it; any other task
answers 404. Every route needs `tasks.work`.

| Route | Result |
| --- | --- |
| `GET /workflow/tasks?status&partition&processKey&limit&offset` | `{ data, meta: { total } }`, open and claimed by default, oldest first |
| `GET /workflow/tasks/:id` | the task with its form |
| `POST /workflow/tasks/:id/claim` | 200 / 409 `conflict` (taken by someone else) / 409 `wrong_status` |
| `POST /workflow/tasks/:id/release` | 200 / 409 `wrong_status` (not taken by the caller) |
| `POST /workflow/tasks/:id/complete` `{ output }` | 200 / 409 / 422 `invalid_input` with the form issues |

## 5. Known limits

- The task is created by an event after the step commits: a failing handler
  (the database went down in between) leaves the step waiting without a task;
  the step can still be completed through `IWorkflowRuntime.completeToken`.
- Completing first moves the process, then marks the task; if the second write
  fails, the next attempt finds the step closed and cancels the task.
