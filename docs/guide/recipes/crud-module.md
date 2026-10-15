# CRUD-модуль целиком

Модуль задач от команды `g module` до теста: таблица в PostgreSQL,
проверка входных данных, список с фильтрами, сортировкой и страницами,
своё действие «выполнить», ответы 400/404 и тест на настоящей базе.

Проверено на bazis 0.100.3 и PostgreSQL 17.

## 1. Проект и база

```sh
bunx bazis new Planner
cd planner && bun install
bunx bazis g module Tasks
```

`g module` без флагов создаёт пример CRUD (`--minimal`) — дальше мы его
перепишем под задачи. Модулю нужна база: настройки и подключение.

```ts
// src/app/config/db.config.ts
import { defineConfig, secret } from "bazis/core/kernel";

export const dbConfig = defineConfig("db", {
  default: { host: "127.0.0.1", port: 5432, database: "planner", username: "postgres", password: secret("postgres") },
  test: { database: "planner_test" },
  production: { password: secret() },
});
```

```ts
// src/app/infra/App.infra.ts
import { Infra } from "bazis/core/infra";
import { ormBazisConnect } from "bazis/core/orm";
import { dbConfig } from "../config/db.config";

@Infra({ db: ormBazisConnect(dbConfig) })
export class AppInfra {}
```

```ts
// src/index.ts
import { runApp } from "bazis/core/app";
import { databaseErrorStatus } from "bazis/core/orm";
import { AppModule } from "./app/modules/App.module";
import { AppInfra } from "./app/infra/App.infra";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: {
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    health: true,
    errorHandler: { status: databaseErrorStatus },
  },
});
```

Секция `test` направляет тесты в отдельную базу `planner_test`.
`databaseErrorStatus` превращает ошибки базы в понятные коды: нарушение
уникальности — `409`, а не `500` ([Ошибки базы данных](../database/errors.md#http-статусы)).

## 2. Модель

```ts
// src/app/modules/tasks/model/Tasks.model.ts
import { Column, Entity, Index, Required, UUID } from "bazis/core/orm";

@Entity({ table: "tasks" })
export class Task {
  @UUID()
  id = "";

  @Required()
  @Column({ type: "text" })
  title = "";

  @Required()
  @Column({ type: "boolean" })
  done = false;

  @Required()
  @Index()
  @Column({ type: "integer" })
  priority = 3;

  @Column({ type: "datetime", nullable: true })
  dueAt: Date | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
```

`DbContext` из шаблона не меняется — у него одна таблица:

```ts
// src/app/modules/tasks/model/Tasks.dbContext.ts
export class TasksDbContext extends DbContext {
  readonly tasks = this.set(Task);
}
```

В модуле включите создание таблицы при старте:

```ts
// src/app/modules/tasks/Tasks.module.ts
@Module({
  ormBazis: {
    context: TasksDbContext,
    entities: [Task],
    ensureCreated: true,
  },
  controllers: [TasksController],
  providers: [
    scoped(ITasksService, TasksService),
  ],
  exports: [ITasksService],
})
export class TasksModule {}
```

При первом запуске:

```text
[orm:schema] applied 2 operation(s): create table tasks, create index ix_tasks_priority on tasks (priority)
```

Подробнее о столбцах и ключах — [Сущности](../database/entities.md), о
создании схемы — [Управление схемой](../database/schema.md).

## 3. Что принимает и отдаёт API

```ts
// src/app/modules/tasks/http/contracts/Tasks.requests.ts
import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class CreateTaskRequest {
  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;

  @Validator({ min: 1, max: 5 })
  priority?: number;

  @Validator({ type: "date" })
  dueAt?: string;
}

@RequestModel()
export class UpdateTaskRequest {
  @Validator({ minLength: 1, maxLength: 200 })
  title?: string;

  done?: boolean;

  @Validator({ min: 1, max: 5 })
  priority?: number;

  @Validator({ type: "date" })
  dueAt?: string;
}
```

```ts
// src/app/modules/tasks/http/contracts/Tasks.responses.ts
import type { Task } from "../../model/Tasks.model";

export interface TaskResponse {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly priority: number;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
}

export function toTaskResponse(task: Task): TaskResponse {
  return { id: task.id, title: task.title, done: task.done, priority: task.priority, dueAt: task.dueAt, createdAt: task.createdAt };
}
```

Ответ — отдельный тип, а не сама сущность: в API не уйдут поля, которые
вы потом добавите в таблицу. Поле `done` в создании не принимается —
новая задача всегда невыполненная; лишние поля тела отбрасываются
([Проверка данных](../overview/validation.md)).

### Список

```ts
// src/app/modules/tasks/http/contracts/TasksList.query.ts
import { Filterable, ListOptions, ListRequest, Sortable } from "bazis/core/http";
import type { Task } from "../../model/Tasks.model";

@ListOptions({ defaultSize: 20, maxSize: 100, defaultSort: "-priority" })
export class TasksListQuery extends ListRequest<Task> {
  @Sortable()
  @Filterable("contains")
  title!: string;

  @Filterable("eq")
  done!: boolean;

  @Sortable()
  @Filterable("eq", "gte", "lte")
  priority!: number;

  @Sortable()
  @Filterable("lt", "gte")
  dueAt!: Date;

  @Sortable()
  createdAt!: Date;
}
```

Сортировать и фильтровать можно только по объявленным полям и
операторам — остальное отклоняется с `400`
([Списки](../http/lists.md)).

## 4. Сервис

Контракт — абстрактный класс, он же токен DI:

```ts
// src/app/modules/tasks/services/ITasks.service.ts
import type { PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateTaskRequest, UpdateTaskRequest } from "../http/contracts/Tasks.requests";
import type { TaskResponse } from "../http/contracts/Tasks.responses";

export abstract class ITasksService {
  abstract list(query: ListQuery): Promise<PageResult<TaskResponse>>;
  abstract get(id: string): Promise<TaskResponse | null>;
  abstract create(body: CreateTaskRequest): Promise<TaskResponse>;
  abstract update(id: string, body: UpdateTaskRequest): Promise<TaskResponse | null>;
  abstract complete(id: string): Promise<TaskResponse | null>;
  abstract delete(id: string): Promise<boolean>;
}
```

```ts
// src/app/modules/tasks/services/Tasks.service.ts
import { paginate, type PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateTaskRequest, UpdateTaskRequest } from "../http/contracts/Tasks.requests";
import { toTaskResponse, type TaskResponse } from "../http/contracts/Tasks.responses";
import { Task } from "../model/Tasks.model";
import { TasksDbContext } from "../model/Tasks.dbContext";
import type { ITasksService } from "./ITasks.service";

export class TasksService implements ITasksService {
  constructor(private readonly db: TasksDbContext) {}

  async list(query: ListQuery): Promise<PageResult<TaskResponse>> {
    const { items, total } = await paginate(this.db.tasks.asNoTracking(), query);
    return { items: items.map(toTaskResponse), total };
  }

  async get(id: string): Promise<TaskResponse | null> {
    const task = await this.db.tasks.find(id);
    return task ? toTaskResponse(task) : null;
  }

  async create(body: CreateTaskRequest): Promise<TaskResponse> {
    const task = Object.assign(new Task(), {
      title: body.title,
      priority: body.priority ?? 3,
      dueAt: body.dueAt === undefined ? null : new Date(body.dueAt),
    });
    this.db.tasks.add(task);
    await this.db.saveChanges();
    return toTaskResponse(task);
  }

  async update(id: string, body: UpdateTaskRequest): Promise<TaskResponse | null> {
    const task = await this.db.tasks.find(id);
    if (!task) return null;
    if (body.title !== undefined) task.title = body.title;
    if (body.done !== undefined) task.done = body.done;
    if (body.priority !== undefined) task.priority = body.priority;
    if (body.dueAt !== undefined) task.dueAt = new Date(body.dueAt);
    await this.db.saveChanges();
    return toTaskResponse(task);
  }

  async complete(id: string): Promise<TaskResponse | null> {
    return this.update(id, { done: true });
  }

  async delete(id: string): Promise<boolean> {
    const task = await this.db.tasks.find(id);
    if (!task) return false;
    this.db.tasks.remove(task);
    await this.db.saveChanges();
    return true;
  }
}
```

- `paginate` применяет к запросу фильтры, сортировку и страницу из
  `ListQuery` и считает общее число строк.
- `asNoTracking()` — для чтения: список не отслеживается и не сохраняется.
- `find` + изменение полей + `saveChanges()` — обновление: ORM запишет
  только изменённые столбцы и сам обновит `updatedAt`.

## 5. Контроллер

```ts
// src/app/modules/tasks/http/Tasks.controller.ts
import { Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from "bazis/core/http";
import { buildListDocument } from "bazis/library/jsonapi";
import { TasksListQuery } from "./contracts/TasksList.query";
import { CreateTaskRequest, UpdateTaskRequest } from "./contracts/Tasks.requests";
import type { ITasksService } from "../services/ITasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: ITasksService) {}

  @Get()
  async list(query: TasksListQuery, ctx: HttpContext) {
    const { items, total } = await this.tasks.list(query);
    return buildListDocument(items, query, total, { basePath: ctx.path });
  }

  @Get(":id(uuid)")
  async get(id: string) {
    const task = await this.tasks.get(id);
    return task ? Ok(task) : NotFound({ error: `task ${id} not found` });
  }

  @Post()
  async create(body: CreateTaskRequest, ctx: HttpContext) {
    const task = await this.tasks.create(body);
    return Created(`${ctx.path}/${task.id}`, task);
  }

  @Put(":id(uuid)")
  async update(id: string, body: UpdateTaskRequest) {
    const task = await this.tasks.update(id, body);
    return task ? Ok(task) : NotFound({ error: `task ${id} not found` });
  }

  @Post(":id(uuid)/complete")
  async complete(id: string) {
    const task = await this.tasks.complete(id);
    return task ? Ok(task) : NotFound({ error: `task ${id} not found` });
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    return (await this.tasks.delete(id)) ? NoContent() : NotFound({ error: `task ${id} not found` });
  }
}
```

`:id(uuid)` пропускает к методу только UUID: `/tasks/not-a-uuid` получит
`404` ещё в маршрутизаторе. Своё действие — обычный маршрут
`POST /tasks/:id/complete`, вызывающий метод сервиса.

## 6. Проверка

```sh
bunx bazis dev
```

В примерах `curl -g`: без него curl принимает `[...]` в адресе за свой
шаблон.

```text
$ curl -i -X POST localhost:3000/tasks -H 'content-type: application/json' \
    -d '{"title":"Write the recipe","priority":5,"dueAt":"2026-10-20T12:00:00Z"}'
HTTP/1.1 201 Created
Location: /tasks/e6d20c17-d947-4fae-b7b2-de573a914e5c
{"id":"e6d20c17-…","title":"Write the recipe","done":false,"priority":5,"dueAt":"2026-10-20T12:00:00.000Z","createdAt":"2026-10-15T11:54:29.162Z"}

$ curl -X POST localhost:3000/tasks -H 'content-type: application/json' \
    -d '{"title":"","priority":9,"dueAt":"tomorrow"}'
{"error":"Validation failed","details":[
  {"property":"title","message":"Field \"title\" must be at least 1 characters long","code":"minLength"},
  {"property":"priority","message":"Field \"priority\" must be at most 5","code":"max"},
  {"property":"dueAt","message":"Field \"dueAt\" must be a valid date","code":"date"}]}
```

Список — по приоритету, фильтры и страницы:

```text
$ curl -g 'localhost:3000/tasks'
  Write the recipe (5), Tag release (4), Review PR (3)     meta: total 3, page 1, size 20

$ curl -g 'localhost:3000/tasks?filter[priority][gte]=4&sort=dueAt'
  Tag release (2026-10-16), Write the recipe (2026-10-20)  meta: total 2

$ curl -g 'localhost:3000/tasks?page[size]=2&page[number]=2&sort=title'
  Write the recipe                                         meta: total 3, page 2, size 2, pageCount 2
  links: self, first, last, prev

$ curl -g 'localhost:3000/tasks?filter[title][eq]=x'
{"error":"Invalid list query","details":[{"parameter":"filter[title][eq]","message":"operator \"eq\" is not allowed for \"title\""}]}
```

Действие и остальные методы:

```text
$ curl -X POST localhost:3000/tasks/e30652ec-…/complete
{"id":"e30652ec-…","title":"Review PR","done":true,"priority":3,"dueAt":null,…}

$ curl -g 'localhost:3000/tasks?filter[done][eq]=true'           → Review PR
$ curl -X PUT localhost:3000/tasks/e30652ec-… -d '{"priority":1}'  → 200, "priority":1
$ curl -X DELETE localhost:3000/tasks/e30652ec-…                   → 204
$ curl localhost:3000/tasks/e30652ec-…                             → 404 {"error":"task e30652ec-… not found"}
$ curl localhost:3000/tasks/not-a-uuid                             → 404 {"error":"Not Found"}
```

## 7. Тест

Тест запускает приложение в процессе на тестовой базе и чистит таблицу
перед каждым случаем:

```ts
// src/app/modules/tasks/test/tasks.http.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DATABASE_PROVIDER } from "bazis/core/orm";
import { startTestApp, type TestApp } from "bazis/core/testing";
import { AppModule } from "../../App.module";
import { AppInfra } from "../../../infra/App.infra";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp(AppModule, { infra: AppInfra });
});
afterAll(async () => {
  await app.stop();
});
beforeEach(async () => {
  await app.container.resolve(DATABASE_PROVIDER).execute("DELETE FROM tasks", []);
});

function post(path: string, body: unknown) {
  return app.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("a task is created, completed and found by the done filter", async () => {
  const created = await post("/tasks", { title: "Write the recipe", priority: 5 });
  expect(created.status).toBe(201);
  const task = await created.json() as { id: string; done: boolean };
  expect(created.headers.get("location")).toBe(`/tasks/${task.id}`);
  expect(task.done).toBe(false);

  expect((await post(`/tasks/${task.id}/complete`, {})).status).toBe(200);
  const done = await (await app.fetch("/tasks?filter[done][eq]=true")).json() as { data: { id: string }[] };
  expect(done.data.map((item) => item.id)).toEqual([task.id]);
});

test("invalid input is 400 with every field, an unknown id is 404", async () => {
  const invalid = await post("/tasks", { title: "", priority: 9 });
  expect(invalid.status).toBe(400);
  const body = await invalid.json() as { details: { property: string }[] };
  expect(body.details.map((detail) => detail.property)).toEqual(["title", "priority"]);
  expect((await app.fetch("/tasks/00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("the list sorts by priority by default and pages", async () => {
  for (const [title, priority] of [["low", 1], ["high", 5], ["mid", 3]] as const) await post("/tasks", { title, priority });
  const page = await (await app.fetch("/tasks?page[size]=2")).json() as { data: { title: string }[]; meta: { total: number; pageCount: number } };
  expect(page.data.map((item) => item.title)).toEqual(["high", "mid"]);
  expect(page.meta).toMatchObject({ total: 3, pageCount: 2 });
});
```

```text
$ bunx bazis test
 4 pass
 0 fail
    ✔  SUCCESS   all tests passed · 351 ms
```

Четвёртый тест — `health.test.ts` из шаблона проекта. Таблицу в
`planner_test` создаёт тот же `ensureCreated` при старте тестового
приложения; саму базу `planner_test` нужно создать заранее.

## Дальше

- [JWT и защита маршрутов](jwt-auth.md) — закрыть этот API
- [Запросы](../database/queries.md) и [Сохранение](../database/saving.md)
- [Списки](../http/lists.md)
- [Тестирование](../fundamentals/testing.md)
