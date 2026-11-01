# Инструмент агента, вызывающий сервис

Ассистент для проекта Planner: пользователь пишет «что у меня на
сегодня?» или «добавь…», модель вызывает инструменты, а они — обычный
`TasksService` из [рецепта CRUD](crud-module.md). Каждый видит и меняет
только свои задачи, каждый вызов инструмента остаётся в журнале.

Проверено на bazis 0.123.0. Модель в проверке — сервер с
OpenAI-совместимым API, который отвечает по сценарию.

## 1. Подключение модели

```ts
// src/app/config/llm.config.ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface LlmConfig { provider: string; model: string; baseUrl: string; apiKey: Secret }

export const llmConfig = defineConfig<LlmConfig>("llm", {
  default: { provider: "openai", model: "gpt-5-mini", baseUrl: "https://api.openai.com/v1", apiKey: secret("dev-key") },
  production: { apiKey: secret() },
});
```

```ts
// src/app/infra/App.infra.ts
@Infra({
  db: ormBazisConnect(dbConfig),
  cache: redisConnect(redisConfig, { cache: "distributed" }),
  llm: llmConnect(llmConfig, openAiCompatibleAdapter()),
})
export class AppInfra {}
```

При запуске коннектор проверяет ключ и адрес (`GET /models`), в тестах —
нет ([LLM-коннекторы](../ai/llm-connectors.md#проверка-при-старте)).

## 2. От чьего имени работает инструмент

Инструмент выполняется в своей области DI: пользователя запроса там нет,
и `CurrentUser` пуст. Кто спрашивает, контроллер кладёт в `metadata`
запуска — модель не может его подменить. Инструмент переносит
пользователя в `CurrentUser` своей области, и сервисы этой области
работают от его имени:

```ts
// tasks/tools/actAs.ts
import type { AgentToolExecutionContext } from "bazis/core/agent";
import type { CurrentUser } from "../../auth/CurrentUser";
import type { TokenKind } from "../../auth/tokenKinds";

/**
 * A tool runs in its own DI scope, where nobody has signed in. The user comes
 * from the run's metadata, which the controller fills and the model cannot
 * change; services of the tool's scope then work on that user's behalf.
 */
export function actAs(current: CurrentUser, context: AgentToolExecutionContext): void {
  const { userId, kind } = context.metadata;
  current.set({ id: String(userId), kind: kind as TokenKind });
}
```

## 3. Инструменты

Сервису задач — метод для ассистента: открытые задачи текущего
пользователя.

```ts
// tasks/services/Tasks.service.ts
  /** Open tasks of the current user, most important first. */
  async open(limit: number): Promise<TaskResponse[]> {
    const me = this.current.get();
    const tasks = await this.db.tasks.asNoTracking()
      .where((t) => t.ownerId.eq(me.id).and(t.done.eq(false)))
      .orderByDescending((t) => t.priority)
      .take(limit)
      .toList();
    return tasks.map(toTaskResponse);
  }
```

Инструменты получают сервис через контракт, поэтому метод нужен и в нём:

```ts
// tasks/services/ITasks.service.ts — новый метод
  abstract open(limit: number): Promise<TaskResponse[]>;
```

```ts
// tasks/tools/ListTasks.tool.ts
import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";
import { CurrentUser } from "../../auth/CurrentUser";
import { ITasksService } from "../services/ITasks.service";
import { actAs } from "./actAs";

export class ListTasksInput {
  @Validator({ min: 1, max: 20, integer: true })
  limit = 10;
}

export class TaskItem {
  id = "";
  title = "";
  done = false;
  priority = 3;
  dueAt: string | null = null;
}

export class ListTasksOutput {
  total = 0;
  items: TaskItem[] = [];
}

@Tool({
  name: "tasks.list",
  description: "Open tasks of the current user, most important first.",
  input: ListTasksInput,
  output: ListTasksOutput,
  sideEffect: "read",
  callers: ["agent"],
})
export class ListTasksTool {
  constructor(private readonly tasks: ITasksService, private readonly current: CurrentUser) {}

  async execute(input: ListTasksInput, context: AgentToolExecutionContext): Promise<ListTasksOutput> {
    actAs(this.current, context);
    const tasks = await this.tasks.open(input.limit);
    return Object.assign(new ListTasksOutput(), {
      total: tasks.length,
      items: tasks.map((task) => Object.assign(new TaskItem(), { id: task.id, title: task.title, done: task.done, priority: task.priority, dueAt: task.dueAt?.toISOString() ?? null })),
    });
  }
}
```

```ts
// tasks/tools/CreateTask.tool.ts
import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";
import { CurrentUser } from "../../auth/CurrentUser";
import { ITasksService } from "../services/ITasks.service";
import { actAs } from "./actAs";

export class CreateTaskInput {
  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;

  @Validator({ min: 1, max: 5, integer: true })
  priority = 3;

  @Validator({ type: "date" })
  dueAt?: string;
}

export class CreatedTask {
  id = "";
  title = "";
}

@Tool({
  name: "tasks.create",
  description: "Creates a task for the current user. dueAt is an ISO date-time.",
  input: CreateTaskInput,
  output: CreatedTask,
  sideEffect: "write",
  callers: ["agent"],
})
export class CreateTaskTool {
  constructor(private readonly tasks: ITasksService, private readonly current: CurrentUser) {}

  async execute(input: CreateTaskInput, context: AgentToolExecutionContext): Promise<CreatedTask> {
    actAs(this.current, context);
    const task = await this.tasks.create({ title: input.title, priority: input.priority, ...(input.dueAt ? { dueAt: input.dueAt } : {}) });
    return Object.assign(new CreatedTask(), { id: task.id, title: task.title });
  }
}
```

- Инструменты вызывают те же методы сервиса, что и контроллер: проверки
  владельца, сброс кэша, уведомления работают одинаково.
- Вход и результат — классы: из них строится схема для модели, а
  аргументы модели проверяются `@Validator` до вызова `execute`
  ([Инструменты](../ai/tools.md)).

## 4. Журнал и разрешения

Инструмент с записью без журнала аудита не выполнится — модель получит
`TOOL_AUDIT_REQUIRED`. Журнал пишет каждый вызов в журнал приложения, а
политика пропускает вызовы только от вошедшего пользователя:

```ts
// tasks/agentOptions.ts
import type { ToolExecutionOptions } from "bazis/core/agent";
import type { Logger } from "bazis/core/kernel";

/**
 * Every tool call leaves a line in the application log, and a tool runs only
 * for a signed-in user: the controller puts the user into the run's metadata.
 * Fields, not methods: the executor copies the options with `{ ...options }`.
 */
export class AgentOptions implements ToolExecutionOptions {
  readonly auditSink: ToolExecutionOptions["auditSink"];
  readonly approvalPolicy: ToolExecutionOptions["approvalPolicy"];

  constructor(logger: Logger) {
    this.auditSink = (entry) => logger.info("agent tool", {
      phase: entry.phase,
      tool: entry.toolName,
      user: entry.metadata.userId,
      status: entry.result?.status,
      durationMs: entry.durationMs,
    });
    this.approvalPolicy = (request) => typeof request.metadata.userId === "string";
  }
}
```

## 5. Агент и контроллер

```ts
// tasks/ai/assistant.agent.ts
import type { AgentDataDefinition } from "bazis/core/agent";

export const assistant: AgentDataDefinition = {
  name: "planner-assistant",
  instructions: "You help the user plan their day. Use the tools to read and create tasks. Answer briefly.",
  toolNames: ["tasks.list", "tasks.create"],
};
```

```ts
// tasks/http/Assistant.controller.ts
import { AgentRuntime } from "bazis/core/agent";
import { Authorize, Controller, Post, RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";
import { CurrentUser } from "../../auth/CurrentUser";
import { requireTokenKind } from "../../auth/jwtAuth";
import { TokenKind } from "../../auth/tokenKinds";
import { assistant } from "../ai/assistant.agent";

@RequestModel()
export class AskRequest {
  @Validator({ required: true, minLength: 1, maxLength: 2000 })
  question!: string;
}

@Controller("assistant")
@Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))
export class AssistantController {
  constructor(private readonly agents: AgentRuntime, private readonly current: CurrentUser) {}

  @Post("ask")
  async ask(body: AskRequest) {
    const me = this.current.get();
    // Who asks goes in metadata: tools act on behalf of this user only.
    const result = await this.agents.run(assistant, { input: body.question, metadata: { userId: me.id, kind: me.kind } });
    const part = result.finalMessage?.content[0];
    return {
      status: result.status,
      answer: part?.kind === "text" ? part.text : null,
      tools: result.toolResults.map((call) => ({ name: call.name, status: call.status })),
    };
  }
}
```

```ts
// tasks/Tasks.module.ts
@Module({
  imports: [AuthModule],
  ormBazis: { context: TasksDbContext, entities: [Task, Notification], ensureCreated: true },
  controllers: [TasksController, NotificationsController, AssistantController],
  gateways: [NotificationsGateway],
  tools: [ListTasksTool, CreateTaskTool],
  providers: [
    scoped(ITasksService, TasksService),
    scoped(RemindersService),
    singleton(TOOL_EXECUTION_OPTIONS, AgentOptions),
  ],
  background: [TaskReminders],
  exports: [ITasksService],
})
export class TasksModule {}
```

## 6. Проверка

У Ann две задачи, у Bob одна:

```text
POST /assistant/ask  (Ann)  {"question":"What should I do today?"}
→ {"status":"completed","answer":"You have 2 open tasks: Call the bank (priority 5), Buy milk (priority 2).",
   "tools":[{"name":"tasks.list","status":"success"}]}

POST /assistant/ask  (Ann)  {"question":"add Book a dentist"}
→ {"status":"completed","answer":"Added \"Book a dentist\".","tools":[{"name":"tasks.create","status":"success"}]}

GET /tasks  (Ann)  → Book a dentist, Buy milk, Call the bank

POST /assistant/ask  (Bob)  {"question":"What should I do today?"}
→ {"answer":"You have 1 open tasks: Bob secret task (priority 5).","tools":[{"name":"tasks.list","status":"success"}]}

POST /assistant/ask  без токена  → 401
```

Журнал приложения:

```text
info: agent tool {"phase":"attempt","tool":"tasks.list","user":"c8fa199c-…"}
info: agent tool {"phase":"result","tool":"tasks.list","user":"c8fa199c-…","status":"success","durationMs":9}
info: agent tool {"phase":"attempt","tool":"tasks.create","user":"c8fa199c-…"}
info: agent tool {"phase":"result","tool":"tasks.create","user":"c8fa199c-…","status":"success","durationMs":5}
info: agent tool {"phase":"attempt","tool":"tasks.list","user":"2479e2fb-…"}
info: agent tool {"phase":"result","tool":"tasks.list","user":"2479e2fb-…","status":"success","durationMs":4}
```

Без журнала аудита запись не проходит:

```text
→ {"tools":[{"name":"tasks.create","status":"error"}]}
   модели: {"code":"TOOL_AUDIT_REQUIRED","message":"Tool \"tasks.create\" has side effects and requires an audit sink."}
```

## 7. Тест

Тест поднимает на свободном порту сервер с OpenAI-совместимым API: он
вызывает заданный инструмент, а потом отвечает текстом. Адрес модели
подставляется переменной окружения до запуска приложения.

```ts
// tasks/test/assistant.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DATABASE_PROVIDER } from "bazis/core/orm";
import type { TestApp } from "bazis/core/testing";
import { startPlanner } from "../../../test/testApp";

/** An OpenAI-compatible model that calls the tool it is told to, then answers. */
let nextCall: { tool: string; args: object } = { tool: "", args: {} };
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [] });
    const body = await request.json() as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    const last = body.messages.at(-1)!;
    const message = last.role === "tool"
      ? { role: "assistant", content: `done: ${last.content}` }
      : { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: body.tools.find((t) => t.function.name.startsWith(nextCall.tool))!.function.name, arguments: JSON.stringify(nextCall.args) } }] };
    return Response.json({ id: "r", object: "chat.completion", choices: [{ index: 0, finish_reason: last.role === "tool" ? "stop" : "tool_calls", message }] });
  },
});

let app: TestApp;
const tokens: Record<string, string> = {};

async function call(path: string, user: string, body?: unknown) {
  return app.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens[user]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  process.env.BAZIS_LLM__BASEURL = `http://127.0.0.1:${model.port}/v1`;
  app = await startPlanner();
  for (const user of ["ann", "bob"]) {
    const credentials = { email: `${user}@example.com`, password: "correct-horse" };
    await app.fetch("/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    const login = await app.fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
    tokens[user] = ((await login.json()) as { accessToken: string }).accessToken;
  }
});
afterAll(async () => {
  await app.stop();
  model.stop(true);
  delete process.env.BAZIS_LLM__BASEURL;
});
beforeEach(async () => {
  await app.container.resolve(DATABASE_PROVIDER).execute("DELETE FROM tasks", []);
});

test("the assistant creates a task for the user who asks, and lists only theirs", async () => {
  await call("/tasks", "bob", { title: "Bob's task" });

  nextCall = { tool: "tasks_create", args: { title: "Book a dentist", priority: 4 } };
  const created = await (await call("/assistant/ask", "ann", { question: "add Book a dentist" })).json() as { status: string; tools: { name: string; status: string }[] };
  expect(created).toMatchObject({ status: "completed", tools: [{ name: "tasks.create", status: "success" }] });

  nextCall = { tool: "tasks_list", args: { limit: 5 } };
  const listed = await (await call("/assistant/ask", "ann", { question: "What should I do?" })).json() as { answer: string };
  expect(listed.answer).toContain("Book a dentist");
  expect(listed.answer).not.toContain("Bob's task");

  const anns = await (await call("/tasks", "ann")).json() as { data: { title: string }[] };
  expect(anns.data.map((task) => task.title)).toEqual(["Book a dentist"]);
});
```

- Адаптер передаёт модели имена инструментов в форме, которую принимает
  OpenAI API: `tasks.create` становится `tasks_create`, а ответ модели
  переводится обратно.
- В среде `test` коннектор не проверяет провайдера ни при старте, ни в
  `/health`, поэтому остальным тестам проекта сервер модели не нужен.

```text
$ bunx bazis test
 9 pass
 0 fail
```

## Дальше

- [Агенты](../ai/agents.md) — определение, запуск, структурированный ответ, диалог
- [Инструменты](../ai/tools.md) — ошибки, сроки, повторы, инструменты с записью
- [Хуки](../ai/hooks.md) — проверка вызовов до и после инструмента
