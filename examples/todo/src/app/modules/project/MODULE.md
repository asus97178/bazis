# ProjectModule

Passport 1.0. Type: atomic. CLI profile: minimal.
Created with (from `examples/todo`):
`../../scripts/bazis-bun node_modules/bazis/cli/main.ts g module Project --minimal`
File names were renamed to `<Module>.<role>.ts` after the 0.96.1 CLI naming
change (the command above generated `ProjectController.ts`-style names).
Entry: [Project.module.ts](Project.module.ts), class `ProjectModule`.

## Responsibility

Owns projects: the `projects` table (`Project` entity, `ProjectDbContext`),
its invariants (non-empty unique name) and the HTTP resource `/projects`.
`migrateOnStart: true` creates or extends the table on start.

imports: none. exports: `IProjectService` (DI token + interface,
`services/IProject.service.ts`); used by `task` and `report`.

## Inputs, outputs, effects

| Operation | Input | Output | Errors |
| --- | --- | --- | --- |
| `GET /projects` | `ProjectListQuery`: `filter[name]` eq/contains/startsWith, `sort` name/createdAt, `page[number]`, `page[size]` ≤ 100 (default 20) | JSON:API list document | 400 invalid query |
| `GET /projects/:id` | `id` uuid | `ProjectResponse` | 404 |
| `POST /projects` | `CreateProjectRequest.name`: string, required, 2–100 chars | 201 `ProjectResponse` + `Location` | 400 validation, 409 name taken |
| `PUT /projects/:id` | `UpdateProjectRequest.name`: optional, 2–100 chars | `ProjectResponse` | 400, 404, 409 |
| `DELETE /projects/:id` | `id` uuid | 204 | 404 |

`IProjectService.create/update` return `"conflict"` for a taken name: the
unique index rejects the save with `UniqueViolationError` from `bazis/core/orm`,
so concurrent requests cannot both succeed. Deleting a project does not touch
its tasks.

## Checks

`src/app/test/api.test.ts` (end-to-end with PostgreSQL), `bazis build`
(codegen + typecheck), `bazis build --bin`.
