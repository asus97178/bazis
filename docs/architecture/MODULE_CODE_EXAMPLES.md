# bazis module code examples

An appendix to [MOD-ARCH-001](MODULE_ARCHITECTURE.md), version 1.3.
The examples use the public bazis APIs. Task is a learning feature that creates and
reads tasks. The code is given for the named files of an application's
`src/app/modules`; this document does not create or connect the module.
DataManager below reproduces a composition from the osnova application.

To implement a new module, first create it with the bazis CLI command per §8.1 of
the specification. For Task, `g module Task --empty` fits; after generation fill
in `MODULE.md` and adapt the sources to the examples below.
Copying these examples does not replace the mandatory CLI scaffold generation.

## 1. Atomic Task: files and call flow

```text
task/
  MODULE.md
  Task.module.ts
  contracts/
    CreateTaskInput.ts
    TaskResponse.ts
  errors/TaskInputError.ts
  model/
    Task.model.ts
    TaskDbContext.ts
  services/
    ITask.service.ts
    Task.service.ts
  http/
    TaskController.ts
    contracts/TaskRequests.ts
```

The creation flow: `POST /api/tasks` → `CreateTaskRequest` →
`TaskController.create` → `ITaskService.create` → `TaskService` →
`TaskDbContext` → `TaskResponse`. All these components belong to one atomic
module. The background job, UI and tool in §2 are added to it only when needed.

### 1.1. Input model: fields and rules

The shared input model does not depend on HTTP: the service and any of its adapters use it.

```ts
// file: src/app/modules/task/contracts/CreateTaskInput.ts
import { Validator } from "bazis/library/validation";

export class CreateTaskInput {
  @Validator({ required: true, type: "string", minLength: 2, maxLength: 200 })
  title!: string;

  @Validator({ required: true, type: "number", integer: true, min: 0, max: 5 })
  priority = 0;
}
```

The HTTP model inherits these fields. `@RequestModel()` explicitly registers the class
for binding by name; regular codegen builds the route and DI metadata.

```ts
// file: src/app/modules/task/http/contracts/TaskRequests.ts
import { RequestModel } from "bazis/core/http";
import { CreateTaskInput } from "../../contracts/CreateTaskInput";

@RequestModel()
export class CreateTaskRequest extends CreateTaskInput {}
```

| Field | Type | Source | Presence in the HTTP body | null | Default | Check |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `string` | body → service argument | Required | No | None | Length 2–200 |
| `priority` | `number`, integer | body → service argument | May be omitted | No | `0`, the model initializer | Integer 0–5 |

`required` on priority checks the received value: a missing field keeps the
initializer `0`, while an explicit `null` must not turn into the default.
The HTTP binder removes unknown fields. An example of a correct request body:

```json
{
  "title": "Prepare the specification",
  "priority": 2
}
```

### 1.2. ORM model and context

The storage model is separate from the input. The ORM sets `id` and `createdAt`, not the client.

```ts
// file: src/app/modules/task/model/Task.model.ts
import { Column, Entity, Key } from "bazis/core/orm";

@Entity({ table: "Tasks" })
export class Task {
  @Key()
  id = 0;

  @Column({ type: "text" })
  title = "";

  @Column({ type: "integer" })
  priority = 0;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
```

```ts
// file: src/app/modules/task/model/TaskDbContext.ts
import { DbContext } from "bazis/core/orm";
import { Task } from "./Task.model";

export class TaskDbContext extends DbContext {
  readonly tasks = this.set(Task);
}
```

### 1.3. Output model and mapping

For HTTP the date is published as an ISO 8601 UTC string. The internal ORM entity is
never returned; the mapper lists the allowed fields explicitly.

```ts
// file: src/app/modules/task/contracts/TaskResponse.ts
import type { Task } from "../model/Task.model";

export class TaskResponse {
  readonly id!: number;
  readonly title!: string;
  readonly priority!: number;
  readonly createdAt!: string;
}

export function toTaskResponse(task: Task): TaskResponse {
  return {
    id: task.id,
    title: task.title,
    priority: task.priority,
    createdAt: task.createdAt.toISOString(),
  };
}
```

### 1.4. Public contract and input error

The contract is an abstract class without code. Unlike an interface it exists at
runtime, so it is the DI token itself: `scoped(ITaskService, TaskService)`,
`exports: [ITaskService]`, and consumers ask for `ITaskService` in the constructor.
`bazis g module` generates contracts in this form.

```ts
// file: src/app/modules/task/services/ITask.service.ts
import type { CreateTaskInput } from "../contracts/CreateTaskInput";
import type { TaskResponse } from "../contracts/TaskResponse";

export abstract class ITaskService {
  abstract create(input: CreateTaskInput): Promise<TaskResponse>;
  abstract getById(id: number): Promise<TaskResponse | null>;
  abstract count(): Promise<number>;
}
```

An interface with a `createToken` constant of the same name works the same way and
remains supported; prefer it when the contract must stay a pure type:

```ts
import { createToken } from "bazis/core/di";

export interface ITaskService { /* … */ }
export const ITaskService = createToken<ITaskService>("ITaskService");
```

```ts
// file: src/app/modules/task/errors/TaskInputError.ts
import type { ValidationError } from "bazis/library/validation";

export class TaskInputError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super("Invalid task fields.");
    this.name = "TaskInputError";
  }
}
```

### 1.5. Service: validation and ORM

The service gets the scoped TaskDbContext. It checks the input itself, so a direct
DI call does not depend on whether the request went through the HTTP validator.

```ts
// file: src/app/modules/task/services/Task.service.ts
import { TaskDbContext } from "../model/TaskDbContext";
import { Validator } from "bazis/library/validation";
import { CreateTaskInput } from "../contracts/CreateTaskInput";
import { toTaskResponse, type TaskResponse } from "../contracts/TaskResponse";
import { TaskInputError } from "../errors/TaskInputError";
import { Task } from "../model/Task.model";
import type { ITaskService } from "./ITask.service";

export class TaskService implements ITaskService {
  constructor(private readonly db: TaskDbContext) {}

  async create(input: CreateTaskInput): Promise<TaskResponse> {
    // Create an instance with the rules and copy only the allowed fields.
    const command = new CreateTaskInput();
    command.title = input.title;
    if (input.priority !== undefined) command.priority = input.priority;

    const validation = Validator.validate(command);
    if (!validation.isValid) throw new TaskInputError(validation.errors);

    const task = new Task();
    task.title = command.title;
    task.priority = command.priority;
    this.db.tasks.add(task);
    await this.db.saveChanges();
    return toTaskResponse(task);
  }

  async getById(id: number): Promise<TaskResponse | null> {
    const task = await this.db.tasks.find(id);
    return task === null ? null : toTaskResponse(task);
  }

  count(): Promise<number> {
    return this.db.tasks.count();
  }
}
```

`create` adds one task and saves all pending changes of TaskDbContext. This example
implements no automatic retry of the creation and no idempotency key. `getById`
returns `null` if the record is not found. `count` has no input fields.

### 1.6. HTTP controller

The controller defines routes, permissions and error mapping; the service does the
saving. The application's existing authorization is used here.

```ts
// file: src/app/modules/task/http/TaskController.ts
import {
  Authorize, Controller, Created, Get, HttpContext,
  ModelValidationError, NotFound, Ok, Post,
} from "bazis/core/http";
import { requireTokenKind } from "../../auth/jwtAuth";
import { TokenKind } from "../../auth/tokenKinds";
import { TaskInputError } from "../errors/TaskInputError";
import type { ITaskService } from "../services/ITask.service";
import { CreateTaskRequest } from "./contracts/TaskRequests";

@Authorize(requireTokenKind(TokenKind.Admin))
@Controller("tasks")
export class TaskController {
  constructor(private readonly tasks: ITaskService) {}

  @Post()
  async create(input: CreateTaskRequest, ctx: HttpContext) {
    try {
      const task = await this.tasks.create(input);
      return Created(`${ctx.path}/${task.id}`, task);
    } catch (error) {
      if (error instanceof TaskInputError) {
        throw new ModelValidationError(error.errors);
      }
      throw error;
    }
  }

  @Get(":id(int)")
  async getById(id: number) {
    const task = await this.tasks.getById(id);
    return task === null ? NotFound({ error: "Task not found" }) : Ok(task);
  }
}
```

Inputs: `POST /api/tasks` takes a body; `GET /api/tasks/:id` takes an integer `id`
from the path. Creation returns 201 and Location; reading returns 200 or 404.
Field errors map to 400. `/api` comes from the host settings, and `ctx.path` keeps
the actual prefix in Location.

### 1.7. Registering the atomic module

```ts
// file: src/app/modules/task/Task.module.ts
import { Module, scoped } from "bazis/core/di";
import { AuthModule } from "../auth/Auth.module";
import { Task } from "./model/Task.model";
import { TaskDbContext } from "./model/TaskDbContext";
import { ITaskService } from "./services/ITask.service";
import { TaskService } from "./services/Task.service";
import { TaskController } from "./http/TaskController";

@Module({
  imports: [AuthModule],
  ormBazis: { context: TaskDbContext, entities: [Task] },
  providers: [scoped(ITaskService, TaskService)],
  controllers: [TaskController],
  exports: [ITaskService],
})
export class TaskModule {}
```

The service dependency is already declared in its constructor:
`constructor(private readonly db: TaskDbContext) {}`.
Codegen extracts `TaskDbContext` and wires it with this module's context; there is
no need to repeat the dependency as a third `scoped` argument.
The controller is registered through `controllers`; codegen wires its dependencies too.
The ORM context gets the shared `DATABASE_PROVIDER`. The schema must be prepared the
way the application chose; the example includes no startup schema change.

## 2. Extra components of the same atomic feature

### 2.1. Background handler

Add this file only if background statistics are needed.
Inputs: the `ServiceProvider` and `Logger` constructor arguments and the
`tick(AbortSignal)` method. The interval is 60 seconds; the first run comes after one interval.

```ts
// file: src/app/modules/task/background/TaskStatsReporter.ts
import { Background, PeriodicBackgroundService } from "bazis/core/background";
import type { ServiceProvider } from "bazis/core/di";
import type { Logger } from "bazis/core/kernel";
import { ITaskService } from "../services/ITask.service";

@Background({ intervalMs: 60_000, runImmediately: false })
export class TaskStatsReporter extends PeriodicBackgroundService {
  constructor(
    private readonly provider: ServiceProvider,
    private readonly logger: Logger,
  ) {
    super();
  }

  protected override async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const scope = this.provider.createScope();
    try {
      const count = await scope.resolve(ITaskService).count();
      if (!signal.aborted) this.logger.info("Task count", { count });
    } finally {
      await scope.dispose();
    }
  }
}
```

The singleton background job does not hold the scoped `ITaskService` in its
constructor: a scope is created per iteration. Checking the signal does not cancel
SQL that was already sent.

### 2.2. UI profile

```ts
// file: src/app/modules/task/ui/TasksAdminUiProfile.ts
import { UiProfile } from "bazis";
import { TaskResponse } from "../contracts/TaskResponse";
import { TaskController } from "../http/TaskController";

@UiProfile({
  surface: "admin",
  controller: TaskController,
  response: TaskResponse,
  title: "Tasks",
  singularTitle: "Task",
})
export class TasksAdminUiProfile {}
```

The profile refers to the existing controller/response and does not declare a second
set of HTTP operations. The host application must publish the `admin` surface.

### 2.3. Tool with a typed input

The tool reads a task through the same public service. The input is a positive
integer `id`; the output is a `TaskResponse` or `null` in the `task` field.

```ts
// file: src/app/modules/task/ai/tools/TaskLookupTool.ts
import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";
import { TaskResponse } from "../../contracts/TaskResponse";
import type { ITaskService } from "../../services/ITask.service";

export class TaskLookupInput {
  @Validator({ required: true, type: "number", integer: true, positive: true })
  id!: number;
}

export class TaskLookupOutput {
  task: TaskResponse | null = null;
}

@Tool({
  name: "tasks.lookup",
  description: "Reads a task by its identifier.",
  input: TaskLookupInput,
  output: TaskLookupOutput,
  sideEffect: "read",
})
export class TaskLookupTool {
  constructor(private readonly tasks: ITaskService) {}

  async execute(
    input: TaskLookupInput,
    _context: AgentToolExecutionContext,
  ): Promise<TaskLookupOutput> {
    const output = new TaskLookupOutput();
    output.task = await this.tasks.getById(input.id);
    return output;
  }
}
```

The input is checked by the regular Tool execution in the Agent Runtime. A direct
`new` and an `execute` call do not get this check automatically. An agent's access
to the tool is configured separately; the HTTP `@Authorize` decorator does not apply to it.

### 2.4. Registering the extra components

Changes in the existing Task.module.ts when all three capabilities are enabled:

```diff
 import { TaskController } from "./http/TaskController";
+import { TaskStatsReporter } from "./background/TaskStatsReporter";
+import { TasksAdminUiProfile } from "./ui/TasksAdminUiProfile";
+import { TaskLookupTool } from "./ai/tools/TaskLookupTool";

-  providers: [scoped(ITaskService, TaskService)],
+  providers: [
+    scoped(ITaskService, TaskService),
+    scoped(TaskLookupTool),
+  ],
   controllers: [TaskController],
+  background: [TaskStatsReporter],
+  uiProfiles: [TasksAdminUiProfile],
+  tools: [TaskLookupTool],
   exports: [ITaskService],
```

`background` registers a singleton automatically; `tools` binds the tool to an
explicitly declared scoped provider. Codegen extracts the tool's constructor
dependency on `ITaskService`; no separate `deps` array is needed.
They stay inside TaskModule.

This example shows the DI registration of a service adapter, not adding an agent to
the module. Per [AGENT-ARCH-001](AGENT_ARCHITECTURE.md) an agent and its set of Tools
are declared separately. The `tools` field above reflects the current way to publish
an adapter; the new standalone agent registration is being developed separately.

## 3. The composite DataManager and its atomic part

### 3.1. Pack root

Source: [DataManager.module.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/datamanager_modules/DataManager.module.ts).

```ts
// file: src/app/modules/datamanager_modules/DataManager.module.ts
import { Module } from "bazis/core/di";
import { AuthModule } from "../auth/Auth.module";
import { DataManagerTablesModule } from "./tables_module/DataManagerTables.module";
import { DataManagerFieldsModule } from "./fields_module/DataManagerFields.module";
import { DataManagerValidatorsModule } from "./validators_module/DataManagerValidators.module";
import { DataManagerRecordsModule } from "./records_module/DataManagerRecords.module";

@Module({
  imports: [
    AuthModule,
    DataManagerTablesModule,
    DataManagerFieldsModule,
    DataManagerValidatorsModule,
    DataManagerRecordsModule,
  ],
  exports: [],
})
export class DataManagerModule {}
```

### 3.2. Records owns the implementation

Source: [DataManagerRecords.module.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/datamanager_modules/records_module/DataManagerRecords.module.ts).

```ts
// file: src/app/modules/datamanager_modules/records_module/DataManagerRecords.module.ts
import { Module, scoped } from "bazis/core/di";
import { DataManagerTablesModule } from "../tables_module/DataManagerTables.module";
import { DataManagerValidatorsModule } from "../validators_module/DataManagerValidators.module";
import { DataController } from "./http/DataController";
import { DynamicDbContext } from "./model/DynamicDbContext";
import { RecordManager } from "./services/RecordManager";

@Module({
  imports: [DataManagerTablesModule, DataManagerValidatorsModule],
  controllers: [DataController],
  providers: [scoped(DynamicDbContext), scoped(RecordManager)],
  exports: [],
})
export class DataManagerRecordsModule {}
```

Records gets the catalog/validation through imports and registers its own controller
and services. `exports: []` makes its DI providers private; the controller is still
part of the pack's HTTP composition.
The other parts and the concrete input fields are described in the
[DataManager walkthrough](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/docs/architecture/EXISTING_MODULES.md).

## 4. Connecting the atomic and composite modules in an application

A shortened separate host composition for the example; do not replace an existing
App.module.ts with this code and lose the application's other features.

```ts
// file: src/app/modules/TaskExampleApp.module.ts
import { Module } from "bazis/core/di";
import { TaskModule } from "./task/Task.module";
import { DataManagerModule } from "./datamanager_modules/DataManager.module";

@Module({ imports: [TaskModule, DataManagerModule] })
export class TaskExampleAppModule {}
```

```ts
// file: src/task-example.ts
import { runApp } from "bazis";
import { AppInfra } from "./app/infra/App.infra";
import { TaskExampleAppModule } from "./app/modules/TaskExampleApp.module";

await runApp(TaskExampleAppModule, {
  infra: AppInfra,
  http: { port: 3000, prefix: "api" },
});
```

This connects through the existing infrastructure; running it needs that
infrastructure's settings and a prepared schema. When moving the code into an
application, first connect it to the chosen entry point and target in
`bazis.config.json`, then run the regular `di:generate` with the pinned Bun.
Documenting these examples does not run the application, a server, external
connectors or migrations.

## 5. What to record next to the code

In `MODULE.md` for `TaskService.create` record the signature above, the two input
fields, the default `priority = 0`, the null ban, the `TaskResponse` result, the
`TaskInputError` error and the effect of saving one record. For HTTP state the
binding, Admin access, 201/400 and Location; for a DI call do not attribute HTTP
authorization. For the background job describe the interval, `AbortSignal`, a new
scope per tick and dispose.

For DataManager list the four atomic owners and their imports/exports.
Do not register `RecordManager` a second time in the pack root, and do not split Task
into separate modules by the `http`, `services` and `model` directories.

Checking the examples must distinguish TypeScript syntax, import resolution, types
and actual execution. A static check does not prove that codegen ran or that
authorization, HTTP, UI/Agent Runtime or a physical database work.

### Example check result

On 2026-09-13 TypeScript 5.9.3 checked 19 `ts` blocks from this appendix and the main
specification: 17 unique virtual files, 60 imports, **0 diagnostics** in the examples
and their dependencies. The settings of the `tsconfig.json` at that time were used;
the example sources were substituted in memory, without writing to `src/`.
The examples repeated in both documents match. The `diff` fragment shows the change
of the extra component registration and is not counted as a separate TS file.
Runtime, codegen, HTTP, UI, Agent Runtime, infrastructure and migrations were not run.
