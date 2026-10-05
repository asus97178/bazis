# Примеры кода модулей Osnova

Приложение к [MOD-ARCH-001](MODULE_ARCHITECTURE.md), версия 1.3.
Примеры используют публичные API текущего репозитория. Task — учебная функция
создания и чтения задач. Здесь приведён код для указанных файлов; сам модуль
в `src/app/modules` этой документационной задачей не создаётся и не подключается.
DataManager ниже воспроизводит существующую композицию.

При реализации нового модуля сначала создать его командой Osnova CLI по
§8.1 спецификации. Например, для Task подходит `g module Task --empty`;
после генерации заполнить `MODULE.md` и доработать исходники по примерам ниже.
Копирование этих примеров не заменяет обязательную генерацию каркаса через CLI.

## 1. Атомарный Task: файлы и поток вызова

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

Поток создания: `POST /api/tasks` → `CreateTaskRequest` →
`TaskController.create` → `ITaskService.create` → `TaskService` →
`TaskDbContext` → `TaskResponse`. Все эти компоненты принадлежат одному
атомарному модулю. Фон, UI и tool в §2 добавляются к нему только при необходимости.

### 1.1. Входная модель: поля и правила

Общая модель входа не зависит от HTTP: ею пользуется сервис и любой его адаптер.

```ts
// file: src/app/modules/task/contracts/CreateTaskInput.ts
import { Validator } from "@osnova/library/validation";

export class CreateTaskInput {
  @Validator({ required: true, type: "string", minLength: 2, maxLength: 200 })
  title!: string;

  @Validator({ required: true, type: "number", integer: true, min: 0, max: 5 })
  priority = 0;
}
```

HTTP-модель наследует эти поля. `@RequestModel()` явно регистрирует класс для
привязки по имени; metadata маршрутов и DI формируется штатным codegen.

```ts
// file: src/app/modules/task/http/contracts/TaskRequests.ts
import { RequestModel } from "@osnova/core/http";
import { CreateTaskInput } from "../../contracts/CreateTaskInput";

@RequestModel()
export class CreateTaskRequest extends CreateTaskInput {}
```

| Поле | Тип | Источник | Присутствие в HTTP body | null | Default | Проверка |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | `string` | body → аргумент сервиса | Обязательно | Нет | Нет | Длина 2–200 |
| `priority` | `number`, целое | body → аргумент сервиса | Можно опустить | Нет | `0`, initializer модели | Целое 0–5 |

`required` у priority проверяет полученное значение: отсутствие поля сохраняет
initializer `0`, а явно переданный `null` не должен превращаться в default.
Неизвестные поля HTTP binder удаляет. Пример корректного тела запроса:

```json
{
  "title": "Подготовить спецификацию",
  "priority": 2
}
```

### 1.2. ORM-модель и контекст

Модель хранения отделена от входа. `id` и `createdAt` задаются ORM, а не клиентом.

```ts
// file: src/app/modules/task/model/Task.model.ts
import { Column, Entity, Key } from "@osnova/core/orm";

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
import { DbContext } from "@osnova/core/orm";
import { Task } from "./Task.model";

export class TaskDbContext extends DbContext {
  readonly tasks = this.set(Task);
}
```

### 1.3. Выходная модель и преобразование

Для HTTP дата публикуется строкой ISO 8601 UTC. Внутренняя ORM-сущность наружу
не возвращается; mapper явно перечисляет разрешённые поля.

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

### 1.4. Публичный интерфейс, DI-токен и ошибка входа

```ts
// file: src/app/modules/task/services/ITask.service.ts
import { createToken } from "@osnova/core/di";
import type { CreateTaskInput } from "../contracts/CreateTaskInput";
import type { TaskResponse } from "../contracts/TaskResponse";

export interface ITaskService {
  create(input: CreateTaskInput): Promise<TaskResponse>;
  getById(id: number): Promise<TaskResponse | null>;
  count(): Promise<number>;
}

export const ITaskService = createToken<ITaskService>("ITaskService");
```

```ts
// file: src/app/modules/task/errors/TaskInputError.ts
import type { ValidationError } from "@osnova/library/validation";

export class TaskInputError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super("Некорректные поля задачи.");
    this.name = "TaskInputError";
  }
}
```

### 1.5. Сервис: валидация и ORM

Сервис получает scoped-контекст TaskDbContext. Он проверяет вход сам, поэтому прямой
DI-вызов не зависит от того, прошёл ли запрос через HTTP-validator.

```ts
// file: src/app/modules/task/services/Task.service.ts
import { TaskDbContext } from "../model/TaskDbContext";
import { Validator } from "@osnova/library/validation";
import { CreateTaskInput } from "../contracts/CreateTaskInput";
import { toTaskResponse, type TaskResponse } from "../contracts/TaskResponse";
import { TaskInputError } from "../errors/TaskInputError";
import { Task } from "../model/Task.model";
import type { ITaskService } from "./ITask.service";

export class TaskService implements ITaskService {
  constructor(private readonly db: TaskDbContext) {}

  async create(input: CreateTaskInput): Promise<TaskResponse> {
    // Создаём экземпляр с правилами и копируем только разрешённые поля.
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

`create` добавляет одну задачу и сохраняет все накопленные изменения TaskDbContext. Автоматический повтор создания и ключ
идемпотентности этим примером не реализуются. `getById` возвращает `null`,
если запись не найдена. `count` не имеет входных полей.

### 1.6. HTTP-контроллер

Контроллер определяет маршруты, права и преобразование ошибок; сохранением
занимается сервис. Здесь используется существующая авторизация приложения.

```ts
// file: src/app/modules/task/http/TaskController.ts
import {
  Authorize, Controller, Created, Get, HttpContext,
  ModelValidationError, NotFound, Ok, Post,
} from "@osnova/core/http";
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

Входы: `POST /api/tasks` принимает body; `GET /api/tasks/:id` принимает целый
`id` из path. Создание возвращает 201 и Location; чтение — 200 либо 404.
Ошибки полей преобразуются в 400. `/api` задаётся настройками host, а
`ctx.path` сохраняет фактический префикс в Location.

### 1.7. Регистрация атомарного модуля

```ts
// file: src/app/modules/task/Task.module.ts
import { Module, scoped } from "@osnova/core/di";
import { AuthModule } from "../auth/Auth.module";
import { Task } from "./model/Task.model";
import { TaskDbContext } from "./model/TaskDbContext";
import { ITaskService } from "./services/ITask.service";
import { TaskService } from "./services/Task.service";
import { TaskController } from "./http/TaskController";

@Module({
  imports: [AuthModule],
  ormOsnova: { context: TaskDbContext, entities: [Task] },
  providers: [scoped(ITaskService, TaskService)],
  controllers: [TaskController],
  exports: [ITaskService],
})
export class TaskModule {}
```

Зависимость сервиса уже объявлена в его конструкторе:
`constructor(private readonly db: TaskDbContext) {}`.
Codegen извлекает `TaskDbContext` и связывает его с контекстом этого модуля;
дублировать эту зависимость третьим аргументом `scoped` не нужно.
Контроллер регистрируется через `controllers`; его зависимости также связывает codegen.
ORM-контекст получает общий `DATABASE_PROVIDER`. Схема должна быть подготовлена
выбранным для приложения способом; пример не включает startup-изменение схемы.

## 2. Дополнительные компоненты той же атомарной функции

### 2.1. Фоновый обработчик

Этот файл добавляется только при необходимости фоновой статистики.
Входы: constructor `ServiceProvider` и `Logger`, метод `tick(AbortSignal)`.
Интервал — 60 секунд; первый запуск после интервала.

```ts
// file: src/app/modules/task/background/TaskStatsReporter.ts
import { Background, PeriodicBackgroundService } from "@osnova/core/background";
import type { ServiceProvider } from "@osnova/core/di";
import type { Logger } from "@osnova/core/kernel";
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
      if (!signal.aborted) this.logger.info("Число задач", { count });
    } finally {
      await scope.dispose();
    }
  }
}
```

Singleton-фон не держит scoped `ITaskService` в конструкторе: scope создаётся
на одну итерацию. Проверка сигнала не означает отмену уже отправленного SQL.

### 2.2. UI-профиль

```ts
// file: src/app/modules/task/ui/TasksAdminUiProfile.ts
import { UiProfile } from "@osnova";
import { TaskResponse } from "../contracts/TaskResponse";
import { TaskController } from "../http/TaskController";

@UiProfile({
  surface: "admin",
  controller: TaskController,
  response: TaskResponse,
  title: "Задачи",
  singularTitle: "Задача",
})
export class TasksAdminUiProfile {}
```

Профиль ссылается на существующие controller/response, не объявляет второй
набор HTTP-операций. Surface `admin` должна быть опубликована host-приложением.

### 2.3. Tool с типизированным входом

Tool читает задачу через тот же публичный сервис. Вход — положительное целое
`id`; выход — `TaskResponse` либо `null` в поле `task`.

```ts
// file: src/app/modules/task/ai/tools/TaskLookupTool.ts
import { Tool, type AgentToolExecutionContext } from "@osnova/core/agent";
import { Validator } from "@osnova/library/validation";
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
  description: "Читает задачу по идентификатору.",
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

Вход проверяется штатным выполнением Tool в Agent Runtime. Прямой `new` и вызов
`execute` не получают эту проверку автоматически. Доступ агента к инструменту
задаётся отдельно; HTTP-декоратор `@Authorize` на него не распространяется.

### 2.4. Как зарегистрировать дополнительные компоненты

Изменения в существующем Task.module.ts при включении всех трёх возможностей:

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

`background` автоматически регистрирует singleton; `tools` связывает tool
с явно объявленным scoped provider. Конструкторную зависимость tool от
`ITaskService` извлекает codegen, отдельный массив `deps` не нужен.
Они остаются внутри TaskModule.

Этот пример показывает DI-регистрацию адаптера сервиса, а не включение агента
в модуль. По [AGENT-ARCH-001](AGENT_ARCHITECTURE.md) агент и его набор Tools
объявляются отдельно. Поле `tools` выше отражает действующий способ публикации
адаптера; новая самостоятельная регистрация агентов дорабатывается отдельно.

## 3. Составной DataManager и его атомарная часть

### 3.1. Корень пакета

Источник: [DataManager.module.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/datamanager_modules/DataManager.module.ts).

```ts
// file: src/app/modules/datamanager_modules/DataManager.module.ts
import { Module } from "@osnova/core/di";
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

### 3.2. Records владеет реализацией

Источник: [DataManagerRecords.module.ts](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/datamanager_modules/records_module/DataManagerRecords.module.ts).

```ts
// file: src/app/modules/datamanager_modules/records_module/DataManagerRecords.module.ts
import { Module, scoped } from "@osnova/core/di";
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

Records получает каталог/валидацию через imports, сам регистрирует свой
контроллер и сервисы. `exports: []` делает его DI-провайдеры приватными;
контроллер по-прежнему входит в HTTP-композицию пакета.
Остальные части и конкретные входные поля описаны в
[разборе DataManager](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/docs/architecture/EXISTING_MODULES.md).

## 4. Подключение атомарного и составного модулей в приложении

Сокращённая отдельная host-композиция для примера; существующий App.module.ts
не следует заменять этим кодом, теряя остальные функции приложения.

```ts
// file: src/app/modules/TaskExampleApp.module.ts
import { Module } from "@osnova/core/di";
import { TaskModule } from "./task/Task.module";
import { DataManagerModule } from "./datamanager_modules/DataManager.module";

@Module({ imports: [TaskModule, DataManagerModule] })
export class TaskExampleAppModule {}
```

```ts
// file: src/task-example.ts
import { runApp } from "@osnova";
import { AppInfra } from "./app/infra/App.infra";
import { TaskExampleAppModule } from "./app/modules/TaskExampleApp.module";

await runApp(TaskExampleAppModule, {
  infra: AppInfra,
  http: { port: 3000, prefix: "api" },
});
```

Это пример подключения через существующую инфраструктуру; для его запуска
нужны её настройки и подготовленная схема. При переносе кода в приложение
сначала подключить его к выбранной точке входа и target в `osnv.config.json`,
затем выполнить штатный `di:generate` с закреплённым Bun. Документирование
этих примеров не запускает приложение, сервер, внешние коннекторы или миграции.

## 5. Что фиксировать рядом с кодом

В `MODULE.md` для `TaskService.create` записать сигнатуру выше, два входных поля,
default `priority = 0`, запрет null, результат `TaskResponse`, ошибку
`TaskInputError` и эффект сохранения одной записи. Для HTTP указать привязку,
Admin-доступ, 201/400 и Location; для DI-вызова не приписывать HTTP-авторизацию.
Для фона описать interval, `AbortSignal`, новый scope на tick и dispose.

Для DataManager перечислить четыре атомарных владельца и их imports/exports.
Не регистрировать `RecordManager` второй раз в корне пакета и не делить Task
на отдельные модули по каталогам `http`, `services` и `model`.

Проверка примеров должна различать синтаксис TypeScript, разрешение импортов,
типы и фактическое выполнение. Статическая проверка не доказывает запуск
codegen, работу авторизации, HTTP, UI/Agent Runtime или физической БД.

### Результат проверки примеров

На 2026-09-13 TypeScript 5.9.3 проверил 19 блоков `ts` из этого приложения и
основной спецификации: 17 уникальных виртуальных файлов, 60 импортов,
**0 диагностик** в примерах и их зависимостях. Использованы настройки текущего
`tsconfig.json`; исходники примеров подставлялись в памяти, без записи в `src/`.
Повторяющиеся примеры в двух документах совпадают. Фрагмент `diff` показывает
правку регистрации дополнительных компонентов и не считается отдельным TS-файлом.
Runtime, codegen, HTTP, UI, Agent Runtime, инфраструктура и миграции не запускались.
