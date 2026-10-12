# Агенты

Агент в bazis — это данные: имя, инструкции и список инструментов, которые
ему можно вызывать. Такое определение можно хранить в базе, править из
админки и менять без выпуска новой версии. Инструменты — код: классы с
`@Tool`, которые вызывают ваши сервисы. Запускает определение
`AgentRuntime`: отправляет его модели, выполняет вызовы инструментов и
возвращает ответ.

Все примеры проверены на bazis 0.99.1 и PostgreSQL 17. Модель в проверках —
скрипт, отвечающий заранее заданными шагами: так результаты
воспроизводимы и не зависят от сети. Подключение настоящей модели — в главе
LLM-коннекторы.

## Определение агента

```ts
import type { AgentDataDefinition } from "bazis/core/agent";

const support: AgentDataDefinition = {
  name: "support",
  instructions: "Ты отвечаешь на вопросы о заказах. Данные бери только из инструментов.",
  toolNames: ["orders.find"],
  modelProfile: "fast",
};
```

| Поле | Что задаёт | Ограничения |
| --- | --- | --- |
| `name` | Имя агента: попадает в журнал вызовов и в контекст инструмента | Латиница, цифры, `.`, `-`, `_`; до 128 символов |
| `instructions` | Системное сообщение модели, отправляется как есть | Строка до 100 000 символов, может быть пустой |
| `toolNames` | Инструменты, которые агенту можно вызывать | Имена из `@Module.tools`, до 128, без повторов |
| `modelProfile` | Профиль модели: какую модель взять, решает инфраструктура | Необязательно |
| `description` | Описание для людей и каталогов; модели не отправляется | Необязательно, до 4000 символов |

Классов агентов нет: ни декоратора, ни регистрации в модуле.

> [!NOTE]
> С версии 0.99.0 агенты — только данные. Декораторы `@Agent`, `@Task`,
> `@Prompt`, функция `agentOutput()`, поля `agents` и `prompts` в `@Module`
> и запуск зарегистрированного агента по имени удалены.

## Инструменты

Инструмент — класс с `@Tool` и методом `execute`. Он объявляется в своём
модуле полем `tools`, как контроллер — полем `controllers`, и получает
сервисы модуля через конструктор:

```ts
// orders/FindOrder.tool.ts
import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";

export class OrderIdInput {
  @Validator({ required: true, min: 1, integer: true }) id!: number;
}

@Tool({ name: "orders.find", description: "Находит заказ по номеру.", input: OrderIdInput, sideEffect: "read" })
export class FindOrderTool {
  constructor(private readonly orders: OrdersService) {}

  execute(input: OrderIdInput, context: AgentToolExecutionContext) {
    return this.orders.find(input.id);
  }
}

@Tool({ name: "orders.cancel", description: "Отменяет заказ.", input: OrderIdInput, sideEffect: "write" })
export class CancelOrderTool {
  constructor(private readonly orders: OrdersService) {}

  execute(input: OrderIdInput) {
    return this.orders.cancel(input.id);
  }
}
```

```ts
// orders/Orders.module.ts
@Module({
  providers: [singleton(OrdersService)],
  tools: [FindOrderTool, CancelOrderTool],
})
export class OrdersModule {}
```

Модель получает имя, описание и JSON-схему входа инструмента; схему
строит кодогенерация из класса `input`. Аргументы, которые прислала
модель, проверяются правилами `@Validator` до вызова `execute`. Подробно —
в главе Инструменты.

## Подключение

`AgentRuntime` регистрирует LLM-коннектор в `@Infra` — рядом с моделью:

```ts
// infra/App.infra.ts
import { Infra, llmConnect, openAiCompatibleAdapter } from "bazis/core/infra";

@Infra({
  db: ormBazisConnect(dbConfig),
  llm: llmConnect(llmConfig, openAiCompatibleAdapter()),
})
export class AppInfra {}
```

После этого любой сервис или контроллер получает его по типу:

```ts
import { AgentRuntime } from "bazis/core/agent";

export class SupportService {
  constructor(private readonly agents: AgentRuntime) {}

  ask(question: string) {
    return this.agents.run(support, { input: question });
  }
}
```

## Запуск

`run(definition, options)` отправляет модели инструкции, вопрос и описания
разрешённых инструментов. Если модель просит вызвать инструмент, рантайм
выполняет его и отправляет результат обратно — и так, пока модель не
ответит текстом.

```ts
const result = await this.agents.run(support, { input: "Где заказ 42?" });
```

```text
POST /agents/support/ask {"question":"Где заказ 42?"}
→ {"status":"completed",
   "answer":"Заказ: {\"id\":42,\"status\":\"paid\",\"total\":1500}",
   "tools":[{"name":"orders.find","status":"success"}]}
```

| Поле результата | Что в нём |
| --- | --- |
| `status` | `completed` или `failed` |
| `finalMessage` | Последний ответ модели |
| `output` | Проверенный JSON, если запрошен структурированный ответ |
| `toolResults` | Вызовы инструментов: `name`, `status`, `output`, `error` |
| `messages` | Весь диалог этого запуска: вопрос, вызовы, ответы инструментов |
| `steps` | Сколько раз вызвана модель |
| `error` | Почему запуск не удался: `code` и `message` |

Текст ответа:

```ts
const part = result.finalMessage?.content[0];
const answer = part?.kind === "text" ? part.text : null;
```

| Опция `run` | Что задаёт |
| --- | --- |
| `input` | Вопрос: строка или JSON |
| `messages` | История диалога вместо `input` или вместе с ним |
| `output` | Структурированный ответ, см. ниже |
| `metadata` | Данные запуска для политики подтверждения и журнала |
| `maxSteps` | Предел вызовов модели (по умолчанию 8) |
| `modelProfile` | Профиль модели вместо указанного в определении |
| `signal` | Отмена запуска |
| `onTextDelta` | Текст ответа по частям, пока модель его пишет |

## Агенты в базе

Определение — обычные данные, поэтому его можно хранить в таблице и
редактировать без выпуска:

```ts
@Entity({ table: "agents" })
export class AgentRecord {
  @UUID({ version: "v7" }) id = "";
  @Index({ unique: true }) @Column({ type: "text" }) name = "";
  @Column({ type: "text" }) instructions = "";
  @Column({ type: "json" }) toolNames: string[] = [];
  @Column({ type: "text", nullable: true }) modelProfile?: string;
}
```

Перед сохранением проверьте определение методом `check` — это та же
проверка, что делает `run`, но без вызова модели:

```ts
@Controller("agents")
export class AgentsController {
  constructor(private readonly service: AgentsService, private readonly agents: AgentRuntime) {}

  @Get("tools")
  tools() {
    return Ok(this.agents.listTools().map(({ metadata }) => ({
      name: metadata.name, description: metadata.description, sideEffect: metadata.sideEffect,
    })));
  }

  @Put(":name")
  async save(name: string, body: SaveAgentRequest) {
    try {
      this.agents.check({ name, ...body });
    } catch (error) {
      if (error instanceof AgentSetupError) return BadRequest({ error: error.message });
      throw error;
    }
    return Ok(await this.service.save(name, body));
  }

  @Post(":name/ask")
  async ask(name: string, body: AskRequest) {
    const definition = await this.service.definitionOf(name);
    if (!definition) return NotFound({ error: `agent ${name} not found` });
    const result = await this.agents.run(definition, { input: body.question });
    …
  }
}
```

```text
GET /agents/tools
→ [{"name":"orders.find","description":"Находит заказ по номеру.","sideEffect":"read"},
   {"name":"orders.cancel","description":"Отменяет заказ.","sideEffect":"write"}]

PUT /agents/broken {"instructions":"x","toolNames":["orders.delete"]}
→ 400 {"error":"Agent \"broken\": tool \"orders.delete\" is not registered in the application (registered: orders.cancel, orders.find)."}
```

`listTools()` отдаёт весь каталог инструментов приложения — из него
редактор агентов предлагает выбор.

Если инструмент удалили из кода уже после сохранения агента, `run` бросит
ту же `AgentSetupError` до вызова модели. Запуск не начнётся, и ответ
будет `500` — это ошибка конфигурации, её видно в журнале.

> [!NOTE]
> `check` — с версии 0.99.1. В 0.99.0 неверное имя инструмента
> обнаруживалось только при первом запуске.

## Что видит модель

- **Инструкции** — системным сообщением, ровно как записаны.
  `description` модели не отправляется.
- **Только инструменты из `toolNames`.** Остальной каталог модель не видит.
  Если она всё же попросит чужой инструмент, вызов получит отказ
  `TOOL_NOT_VISIBLE_TO_AGENT`, а `execute` не выполнится.
- **Ответы инструментов.** Ошибка проверки входа тоже уходит модели, чтобы
  она могла исправиться:

```text
POST /agents/support/ask {"question":"Где заказ 0?"}
→ {"status":"completed","answer":"Инструмент ответил: TOOL_INPUT_VALIDATION_FAILED",
   "tools":[{"name":"orders.find","status":"error","error":"TOOL_INPUT_VALIDATION_FAILED"}]}
```

Агент без инструмента не выполнит действие, даже если его попросят:

```text
POST /agents/support/ask {"question":"отмени заказ 7"}     ← у support только orders.find
→ {"status":"completed","answer":"Без инструментов: отмени заказ 7","tools":[]}
```

## Структурированный ответ

Когда ответ нужен программе, а не человеку, задайте JSON-схему опцией
`output`. Схема уходит модели, а ответ проверяется локально:

```ts
import { agentJsonSchema, agentOutputContract } from "bazis/core/agent";

const triage = agentOutputContract({
  mode: "json",
  schema: agentJsonSchema("Triage", {
    type: "object",
    properties: { status: { type: "string" }, urgent: { type: "boolean" } },
    required: ["status", "urgent"],
    additionalProperties: false,
  }),
});

const result = await this.agents.run(support, { input: question, output: triage });
result.output;     // {"status":"paid","urgent":false}
```

Ответ, не прошедший схему, даёт `status: "failed"` и код
`AGENT_OUTPUT_INVALID`; невалидный JSON — `JSON output is malformed.`.
Вместо схемы можно сослаться на класс: `agentClassSchema("Triage")` — его
схему строит кодогенерация, если класс используется в OpenAPI или в
инструменте.

## Настройки: аудит и подтверждение

Инструмент с записью (`sideEffect: "write"` или `"external"`) без
настройки не выполнится:

```text
POST /agents/operator/ask {"question":"отмени заказ 7"}
→ {"tools":[{"name":"orders.cancel","status":"error","error":"TOOL_AUDIT_REQUIRED"}]}
```

Изменения, сделанные агентом, должны оставлять след, и решать, разрешено
ли действие, должно приложение. Обе вещи задаёт токен
`AGENT_RUNTIME_OPTIONS` — его можно зарегистрировать в любом модуле:

```ts
import { AGENT_RUNTIME_OPTIONS, type AgentRuntimeOptions } from "bazis/core/agent";
import { DI, Module, singleton } from "bazis/core/di";

@Module({
  providers: [
    singleton(ToolAuditLog),
    DI.singleton(DI.factoryProvider(AGENT_RUNTIME_OPTIONS, [ToolAuditLog], (audit: ToolAuditLog): AgentRuntimeOptions => ({
      maxSteps: 6,
      toolExecutorOptions: {
        auditSink: (entry) => audit.write(entry),
        // Чтение разрешено всегда, изменение — только от имени администратора.
        approvalPolicy: (request) => request.tool.metadata.sideEffect === "read" || request.metadata.role === "admin",
      },
    }))),
  ],
  exports: [ToolAuditLog],
})
export class AgentSettingsModule {}
```

`metadata` передаётся при запуске — например, роль пользователя из запроса:

```ts
await this.agents.run(definition, { input: body.question, metadata: { role: user.role } });
```

```text
POST /agents/operator/ask             {"question":"отмени заказ 7"}
→ {"tools":[{"name":"orders.cancel","status":"denied","error":"TOOL_APPROVAL_DENIED"}]}

POST /agents/operator/ask?role=admin  {"question":"отмени заказ 7"}
→ {"answer":"Заказ: {\"id\":7,\"status\":\"cancelled\",\"total\":300}",
   "tools":[{"name":"orders.cancel","status":"success"}]}

POST /agents/support/ask              {"question":"Где заказ 42?"}
→ {"tools":[{"name":"orders.find","status":"success"}]}

журнал: result orders.cancel denied · attempt orders.cancel · result orders.cancel success ·
        attempt orders.find · result orders.find success
```

| Настройка | Что задаёт |
| --- | --- |
| `maxSteps` | Предел вызовов модели за запуск (по умолчанию 8) |
| `timeoutMs` | Срок одного вызова модели (по умолчанию 60 с, `0` — без срока) |
| `toolExecutorOptions.auditSink` | Куда писать журнал вызовов инструментов |
| `toolExecutorOptions.approvalPolicy` | Разрешить ли вызов: `(request) => boolean` |
| `toolExecutorOptions.defaultTimeoutMs` | Срок вызова инструмента (по умолчанию 30 с) |
| `contextLimits` | Сколько истории отправлять модели |

Когда политика задана, она решает за **каждый** инструмент, кроме тех, у
кого в `@Tool` стоит `approval: "never"`, — в том числе за чтение. Поэтому
в примере чтение разрешено явно. Без политики:

| `approval` в `@Tool` | Без политики | С политикой |
| --- | --- | --- |
| `"never"` (только для `read` и `none`) | Выполняется | Не спрашивается |
| `"policy"` — по умолчанию для `read` и `none` | Чтение выполняется, запись — отказ | Спрашивается |
| `"required"` — по умолчанию для `write` и `external` | Отказ `TOOL_APPROVAL_REQUIRED` | Спрашивается |

Журнал по умолчанию маскирует пароли, токены и ключи во входе и результате.

## Диалог

Чтобы агент помнил разговор, передавайте историю в `messages`:

```ts
import { agentMessage } from "bazis/core/agent";

const history = [agentMessage("user", "Где заказ 42?"), agentMessage("assistant", "Заказ 42 оплачен.")];
const reply = await this.agents.run(support, { messages: [...history, agentMessage("user", "Точно оплачен?")] });
```

Модель получит `system, user, assistant, user`: инструкции и всю историю.
Хранить историю — забота приложения; `reply.messages` содержит её вместе с
новым ответом. Длинную историю ограничивает `contextLimits`:
`{ maxMessages: 12, maxTokens: 4000 }` — старые сообщения отбрасываются,
инструкции и последнее сообщение остаются всегда.

## Пределы

Модель может зациклиться на вызовах инструментов. Запуск останавливается
после `maxSteps` вызовов модели:

```text
run(support, { input: "42?", maxSteps: 3 })
→ status: "failed", steps: 3
  error: {"code":"AGENT_MAX_STEPS_EXCEEDED","message":"Agent \"support\" exceeded maxSteps (3)."}
```

| Код ошибки | Когда |
| --- | --- |
| `AGENT_MAX_STEPS_EXCEEDED` | Модель не ответила за `maxSteps` шагов |
| `AGENT_PROVIDER_TIMEOUT` | Модель не ответила за `timeoutMs` |
| `AGENT_PROVIDER_FAILED` | Модель вернула ошибку; ключи и токены в тексте замаскированы |
| `AGENT_ABORTED` | Запуск отменён через `signal` |
| `AGENT_TOOL_OUTCOME_UNKNOWN` | Инструмент с записью прервался, и неизвестно, успел ли он что-то изменить; запуск остановлен, повторять вызов автоматически нельзя |

## Тестирование

В тесте модель заменяется скриптом, а рантайм создаётся напрямую над
контейнером модуля с инструментами:

```ts
import {
  AgentRuntime, agentMessage, agentModelResponse, agentToolCall,
  type AgentModelProvider, type AgentModelRequest, type AgentModelResponse,
} from "bazis/core/agent";
import { createTestContainer } from "bazis/core/testing";

test("support agent looks the order up and answers", async () => {
  const container = await createTestContainer(OrdersModule);
  const steps: ((request: AgentModelRequest) => AgentModelResponse)[] = [
    (r) => agentModelResponse({ invocationId: r.invocationId, finishReason: "tool-calls",
      toolCalls: [agentToolCall({ id: "c1", name: "orders.find", input: { id: 42 } })] }),
    (r) => agentModelResponse({ invocationId: r.invocationId, finishReason: "stop",
      message: agentMessage("assistant", "Заказ 42 оплачен.") }),
  ];
  let step = 0;
  const model: AgentModelProvider = { complete: (request) => steps[step++]!(request) };
  try {
    const result = await new AgentRuntime(container, model).run(
      { name: "support", instructions: "Отвечай о заказах.", toolNames: ["orders.find"] },
      { input: "Где заказ 42?" },
    );
    expect(result.status).toBe("completed");
    expect(result.toolResults[0]?.output).toEqual({ id: 42, status: "paid", total: 1500 });
  } finally {
    await container.dispose();
  }
});
```

Такой тест проверяет то, что в агенте ваше: что инструменты зарегистрированы,
вход проверяется, а сервисы отвечают правильно. Настоящую модель тестом не
проверить — её ответы меняются от запуска к запуску.

## Дальше

- Инструменты
- Хуки инструментов и аудит
- LLM-коннекторы
- [Тестирование](../fundamentals/testing.md)
