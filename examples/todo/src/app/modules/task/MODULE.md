# TaskModule

Passport 1.0. Type: atomic. CLI profile: minimal.
Created with (from `examples/todo`):
`../../scripts/osnova-bun node_modules/osnv/cli/main.ts g module Task --minimal`
File names were renamed to `<Module>.<role>.ts` after the 0.96.1 CLI naming
change (the command above generated `TaskController.ts`-style names).
Entry: [Task.module.ts](Task.module.ts), class `TaskModule`.

## Responsibility

Owns tasks: the `tasks` table (`Task` entity, `TaskDbContext`) and the HTTP
resource `/tasks`. A task belongs to a project; the project id is checked on
create through `IProjectService` (the project module owns projects, this module
only stores the id). `migrateOnStart: true` creates or extends the table.

imports: `ProjectModule`. exports: `ITaskService` (used by `report`).

## Inputs, outputs, effects

| Operation | Input | Output | Errors |
| --- | --- | --- | --- |
| `GET /tasks` | `TaskListQuery`: `filter[projectId]` eq, `filter[title]` eq/contains, `filter[done]` eq, `sort` title/createdAt, paging ≤ 100 (default 20) | JSON:API list document | 400 invalid query |
| `GET /tasks/:id` | `id` uuid | `TaskResponse` | 404 |
| `POST /tasks` | `projectId`: uuid, required; `title`: string, required, 1–200 chars | 201 `TaskResponse` | 400 validation or unknown project |
| `PUT /tasks/:id` | `title`: optional 1–200 chars; `done`: optional boolean | `TaskResponse` | 400, 404 |
| `DELETE /tasks/:id` | `id` uuid | 204 | 404 |

`ITaskService.count(done?)` counts all tasks, or only finished ones when
`done` is true.

## Checks

`src/app/test/api.test.ts` (end-to-end with PostgreSQL), `osnv build`.
