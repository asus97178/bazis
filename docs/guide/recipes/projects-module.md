# Второй модуль и связь между модулями

Продолжение [JWT и защиты маршрутов](jwt-auth.md): у пользователя
появляются проекты, задача может принадлежать проекту. Модуль задач
спрашивает модуль проектов через его контракт, а удаление проекта
сообщается событием. Так модули зависят друг от друга только в одну
сторону: задачи знают о проектах, проекты о задачах — нет.

Проверено на bazis 0.111.2 и PostgreSQL 17.

## 1. Модуль проектов

```sh
bunx bazis g module Projects --empty
```

```text
src/app/modules/projects/
├── Projects.module.ts
├── projectEvents.ts            событие «проект удалён»
├── model/                      таблица projects
├── services/                   контракт и реализация
└── http/                       контроллер и модель запроса
```

```ts
// src/app/modules/projects/model/Project.model.ts
import { Column, Entity, Index, Required, UUID } from "bazis/core/orm";

@Entity({ table: "projects" })
@Index(["ownerId", "name"], { unique: true })
export class Project {
  @UUID()
  id = "";

  @Required()
  @Column({ type: "text" })
  ownerId = "";

  @Required()
  @Column({ type: "text" })
  name = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
```

```ts
// src/app/modules/projects/model/Projects.dbContext.ts
import { DbContext } from "bazis/core/orm";
import { Project } from "./Project.model";

export class ProjectsDbContext extends DbContext {
  readonly projects = this.set(Project);
}
```

Уникальный индекс по `(ownerId, name)`: у одного пользователя два проекта с
одинаковым именем — `409`, у разных пользователей — можно.

## 2. Контракт

Другие модули видят не сам сервис, а его контракт — абстрактный класс. Он
же токен DI ([Провайдеры](../overview/providers.md#интерфейс-и-токен)):

```ts
// src/app/modules/projects/services/IProjects.service.ts
export interface ProjectResponse {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** What the projects module offers the rest of the application. */
export abstract class IProjectsService {
  abstract list(): Promise<ProjectResponse[]>;
  abstract create(name: string): Promise<ProjectResponse>;
  abstract delete(id: string): Promise<boolean>;
  /** Whether the project exists and belongs to the current user. */
  abstract isOwn(id: string): Promise<boolean>;
}
```

```ts
// src/app/modules/projects/projectEvents.ts
import { createEventToken } from "bazis/core/kernel";

export interface ProjectDeleted { readonly id: string }
/** Published after a project is deleted; other modules clean up their links to it. */
export const PROJECT_DELETED = createEventToken<ProjectDeleted>("projects.deleted");
```

```ts
// src/app/modules/projects/services/Projects.service.ts
import { ServiceProvider } from "bazis/core/di";
import { EventBus } from "bazis/core/kernel";
import { CurrentUser } from "../../auth/CurrentUser";
import { Project } from "../model/Project.model";
import { ProjectsDbContext } from "../model/Projects.dbContext";
import { PROJECT_DELETED } from "../projectEvents";
import type { IProjectsService, ProjectResponse } from "./IProjects.service";

const toResponse = (project: Project): ProjectResponse => ({ id: project.id, name: project.name, createdAt: project.createdAt });

export class ProjectsService implements IProjectsService {
  constructor(
    private readonly db: ProjectsDbContext,
    private readonly current: CurrentUser,
    private readonly events: EventBus,
    private readonly services: ServiceProvider,
  ) {}

  async list(): Promise<ProjectResponse[]> {
    const me = this.current.get();
    const projects = await this.db.projects.asNoTracking().where((p) => p.ownerId.eq(me.id)).orderBy((p) => p.name).toList();
    return projects.map(toResponse);
  }

  /** A name the user already has is a unique violation: 409. */
  async create(name: string): Promise<ProjectResponse> {
    const project = Object.assign(new Project(), { ownerId: this.current.get().id, name });
    this.db.projects.add(project);
    await this.db.saveChanges();
    return toResponse(project);
  }

  async delete(id: string): Promise<boolean> {
    const project = await this.findOwn(id);
    if (!project) return false;
    this.db.projects.remove(project);
    await this.db.saveChanges();
    await this.events.publishScoped(this.services, PROJECT_DELETED, { id });
    return true;
  }

  async isOwn(id: string): Promise<boolean> {
    return (await this.findOwn(id)) !== null;
  }

  private async findOwn(id: string): Promise<Project | null> {
    const project = await this.db.projects.find(id);
    return project && project.ownerId === this.current.get().id ? project : null;
  }
}
```

`ServiceProvider` scoped-сервиса — область текущего запроса, поэтому
`publishScoped` передаёт её подписчикам: они получат сервисы того же
запроса ([Контейнер вручную](../fundamentals/dependency-injection.md#контейнер-вручную)).
Сервис проектов не знает, кто подписан, и не зависит от HTTP.

## 3. Контроллер и модуль

```ts
// src/app/modules/projects/http/contracts/Projects.requests.ts
import { Validator } from "bazis/library/validation";

export class CreateProjectRequest {
  @Validator({ required: true, minLength: 1, maxLength: 100 })
  name!: string;
}
```

```ts
// src/app/modules/projects/http/Projects.controller.ts
import { Authorize, Controller, Created, Delete, Get, NoContent, NotFound, Post } from "bazis/core/http";
import { requireTokenKind } from "../../auth/jwtAuth";
import { TokenKind } from "../../auth/tokenKinds";
import { IProjectsService } from "../services/IProjects.service";
import { CreateProjectRequest } from "./contracts/Projects.requests";

@Controller("projects")
@Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))
export class ProjectsController {
  constructor(private readonly projects: IProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Post()
  async create(body: CreateProjectRequest) {
    const project = await this.projects.create(body.name);
    return Created(`/projects/${project.id}`, project);
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    return (await this.projects.delete(id)) ? NoContent() : NotFound({ error: `project ${id} not found` });
  }
}
```

```ts
// src/app/modules/projects/Projects.module.ts
import { Module, scoped } from "bazis/core/di";
import { AuthModule } from "../auth/Auth.module";
import { ProjectsController } from "./http/Projects.controller";
import { Project } from "./model/Project.model";
import { ProjectsDbContext } from "./model/Projects.dbContext";
import { IProjectsService } from "./services/IProjects.service";
import { ProjectsService } from "./services/Projects.service";

@Module({
  imports: [AuthModule],
  ormBazis: { context: ProjectsDbContext, entities: [Project], ensureCreated: true },
  controllers: [ProjectsController],
  providers: [scoped(IProjectsService, ProjectsService)],
  exports: [IProjectsService],
})
export class ProjectsModule {}
```

`exports: [IProjectsService]` — то, чем модуль делится. Контекст базы и
сам `ProjectsService` наружу не выходят: таблицу `projects` меняет только
этот модуль ([Инкапсуляция](../fundamentals/encapsulation.md)).

## 4. Задача в проекте

В модуле задач — поле проекта, проверка «проект свой» и фильтр:

```ts
// tasks/model/Tasks.model.ts — новое поле
  @Index()
  @Column({ type: "text", nullable: true })
  projectId: string | null = null;
```

```ts
// tasks/http/contracts/Tasks.requests.ts — в CreateTaskRequest
  @Validator({ uuid: true })
  projectId?: string;
```

В `TaskResponse` и `toTaskResponse` добавьте `projectId`, в
`TasksListQuery` — `@Filterable("eq") projectId!: string;`.

Сервис задач получает контракт проектов через конструктор:

```ts
// tasks/services/Tasks.service.ts — что изменилось
import { IProjectsService } from "../../projects/services/IProjects.service";

export class TasksService implements ITasksService {
  constructor(
    private readonly db: TasksDbContext,
    private readonly current: CurrentUser,
    private readonly projects: IProjectsService,
  ) {}

  async create(body: CreateTaskRequest): Promise<TaskResponse | "unknown-project"> {
    if (body.projectId !== undefined && !(await this.projects.isOwn(body.projectId))) return "unknown-project";
    const task = Object.assign(new Task(), {
      projectId: body.projectId ?? null,
      ownerId: this.current.get().id,
      // … как раньше
    });
    // …
  }
}
```

В `ITasksService` у `create` тот же тип результата. Контроллер отвечает
`422`, если проект чужой или его нет:

```ts
// tasks/http/Tasks.controller.ts
  @Post()
  async create(body: CreateTaskRequest, ctx: HttpContext) {
    const task = await this.tasks.create(body);
    if (task === "unknown-project") return StatusCode(422, { error: `project ${body.projectId} not found` });
    return Created(`${ctx.path}/${task.id}`, task);
  }
```

Модуль задач импортирует модуль проектов:

```ts
// tasks/Tasks.module.ts
import { withEventSubscribers } from "bazis/core/kernel";

@Module({
  imports: [AuthModule, ProjectsModule],
  providers: [
    scoped(ITasksService, TasksService),
    scoped(ProjectCleanup),
    ...withEventSubscribers(ProjectCleanup),
  ],
  …
})
```

Если забыть `exports` в модуле проектов, приложение не запустится:

```text
[bazis] configuration error: Module encapsulation violated:
Module "TasksModule": "ITasksService" depends on "IProjectsService", which module "ProjectsModule"
provides but does not export. Add it to the exports of "ProjectsModule".
```

## 5. Проект удалён — задачи остаются

Модуль задач подписывается на событие и убирает ссылку на проект:

```ts
// src/app/modules/tasks/ProjectCleanup.ts
import { OnEvent } from "bazis/core/kernel";
import { PROJECT_DELETED, type ProjectDeleted } from "../projects/projectEvents";
import { TasksDbContext } from "./model/Tasks.dbContext";

/** A deleted project leaves its tasks without a project. */
export class ProjectCleanup {
  constructor(private readonly db: TasksDbContext) {}

  @OnEvent(PROJECT_DELETED)
  async onProjectDeleted(event: ProjectDeleted): Promise<void> {
    await this.db.tasks.asNoTracking().where((t) => t.projectId.eq(event.id)).executeUpdate({ projectId: null });
  }
}
```

- `scoped(ProjectCleanup)` и `withEventSubscribers(ProjectCleanup)` —
  подписчик живёт в запросе и получает контекст базы этого запроса
  ([События](../fundamentals/events.md#методом-класса)).

> [!NOTE]
> До 0.106.0 `ServiceProvider` в scoped-сервисе был корневым контейнером, и
> `publishScoped(this.services, …)` падал с
> `ScopedServiceFromRootError: Cannot resolve scoped service "ProjectCleanup" from root provider`.
> Тогда подписчика делали singleton со своей областью.
- `executeUpdate` меняет строки одним `UPDATE`, без загрузки задач. Перед
  ним нужен `asNoTracking()`, иначе
  `OrmUnsafeImmediateMutationError: … call .asNoTracking() before executeUpdate()`
  ([Немедленные изменения](../database/immediate.md)).

> [!WARNING]
> Удаление проекта и очистка задач — две разные транзакции. Если
> подписчик упал, проект уже удалён, клиент получил `500`, а у задач
> осталась ссылка на несуществующий проект. Шина событий не надёжна, как
> очередь ([Чего шина не делает](../fundamentals/events.md#чего-шина-не-делает)).
> Здесь это безопасно: чужой или удалённый проект `isOwn` не найдёт, а
> ссылку можно убрать повторно.

## 6. Проверка

При запуске на базе из прошлых рецептов `ensureCreated` создаёт таблицу
проектов и сам добавляет новый столбец — он допускает `NULL`:

```text
[orm:schema] applied 2 operation(s): create table projects, create unique index ix_projects_ownerId_name on projects (ownerId, name)
[orm:schema] applied 2 operation(s): add column tasks.projectId, create index ix_tasks_projectId on tasks (projectId)
```

| Запрос | Ответ |
| --- | --- |
| `POST /projects {"name":"Release 1.0"}` от Ann | `201` |
| То же имя ещё раз от Ann | `409` |
| То же имя от Bob | `201` — у Bob свой проект |
| `POST /tasks {"title":"Tag release","projectId":"<проект Ann>"}` от Ann | `201`, `"projectId":"<проект Ann>"` |
| То же от Bob | `422 {"error":"project <…> not found"}` |
| `POST /tasks {"title":"x","projectId":"nope"}` | `400`, `Field "projectId" must be a valid UUID` |
| `GET /tasks?filter[projectId][eq]=<проект Ann>` от Ann | только задачи проекта |
| `DELETE /projects/<проект Ann>` от Ann | `204`, у задачи `"projectId":null` |

## 7. Тест

```ts
// src/app/modules/projects/test/projects.http.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DATABASE_PROVIDER } from "bazis/core/orm";
import type { TestApp } from "bazis/core/testing";
import { startPlanner } from "../../../test/testApp";

let app: TestApp;

beforeAll(async () => {
  app = await startPlanner();
});
afterAll(async () => {
  await app.stop();
});
beforeEach(async () => {
  const db = app.container.resolve(DATABASE_PROVIDER);
  await db.execute("DELETE FROM tasks", []);
  await db.execute("DELETE FROM projects", []);
  await db.execute("DELETE FROM users WHERE kind = 'client'", []);
});

async function call(path: string, init: { body?: unknown; token?: string; method?: string } = {}) {
  return app.fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function signIn(email: string): Promise<string> {
  await call("/auth/register", { body: { email, password: "correct-horse" } });
  const response = await call("/auth/login", { body: { email, password: "correct-horse" } });
  return ((await response.json()) as { accessToken: string }).accessToken;
}

test("a task joins only your own project", async () => {
  const ann = await signIn("ann@example.com");
  const bob = await signIn("bob@example.com");
  const project = await (await call("/projects", { token: ann, body: { name: "Release" } })).json() as { id: string };

  expect((await call("/tasks", { token: ann, body: { title: "Tag", projectId: project.id } })).status).toBe(201);
  expect((await call("/tasks", { token: bob, body: { title: "Sneak", projectId: project.id } })).status).toBe(422);
  expect((await call("/projects", { token: ann, body: { name: "Release" } })).status).toBe(409);
  expect((await call("/projects", { token: bob, body: { name: "Release" } })).status).toBe(201);
});

test("a deleted project leaves its tasks without a project", async () => {
  const ann = await signIn("ann@example.com");
  const project = await (await call("/projects", { token: ann, body: { name: "Release" } })).json() as { id: string };
  const task = await (await call("/tasks", { token: ann, body: { title: "Tag", projectId: project.id } })).json() as { id: string };

  expect((await call(`/projects/${project.id}`, { token: ann, method: "DELETE" })).status).toBe(204);
  const after = await (await call(`/tasks/${task.id}`, { token: ann })).json() as { projectId: string | null };
  expect(after.projectId).toBeNull();
});
```

```text
$ bunx bazis test
 9 pass
 0 fail
    ✔  SUCCESS   all tests passed · 2.1 s
```

## Дальше

- [Учебный проект](../introduction/tutorial.md) — сборка и запуск в production
- [Модули](../overview/modules.md) и [инкапсуляция](../fundamentals/encapsulation.md)
- [События](../fundamentals/events.md)
