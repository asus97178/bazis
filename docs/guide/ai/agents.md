# Агенты

Агент в bazis — это данные: имя, инструкции и список инструментов, которые
ему можно вызывать. Такое определение можно хранить в базе, править из
админки и менять без выпуска новой версии. Инструменты — код: классы с
`@Tool`, которые вызывают ваши сервисы. Запускает определение
`AgentRuntime`: отправляет его модели, выполняет вызовы инструментов и
возвращает ответ.

Все примеры проверены на bazis 0.111.1 и PostgreSQL 17. Модель в проверках —
скрипт, отвечающий заранее заданными шагами: так результаты
воспроизводимы и не зависят от сети. Подключение настоящей модели — в главе
[LLM-коннекторы](llm-connectors.md).

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
в главе [Инструменты](tools.md).

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
   "answer":"Заказ: {\"name\":\"orders.find\",\"status\":\"success\",\"output\":{\"id\":42,\"status\":\"paid\",\"total\":1500}}",
   "tools":[{"name":"orders.find","status":"success"}]}
```

Модель-скрипт в проверке просто повторяет то, что получила от инструмента:
имя, статус и результат вызова.

| Поле результата | Что в нём |
| --- | --- |
| `status` | `completed`, `failed` или `waiting` — [ждёт решения человека](#подтверждение-человеком) |
| `pendingApprovals` | При `waiting`: вызов инструмента, о котором надо спросить человека |
| `finalMessage` | Последний ответ модели |
| `output` | Проверенный JSON, если запрошен структурированный ответ |
| `toolResults` | Вызовы инструментов: `name`, `status`, `output`, `error` |
| `messages` | Весь диалог этого запуска: вопрос, вызовы, ответы инструментов |
| `steps` | Сколько раз модель ответила |
| `usage` | Сумма токенов по всем вызовам модели, если провайдер их сообщает: `inputTokens`, `outputTokens`, а также `cacheReadTokens`, `cacheWriteTokens` и `reasoningTokens` |
| `compactions` | Сколько раз за запуск старая часть диалога была заменена пересказом; `messages` тогда начинаются с него |
| `error` | Почему запуск не удался: `code` и `message` |

Текст ответа:

```ts
import { agentMessageText } from "bazis/core/agent";

const answer = agentMessageText(result.finalMessage);   // "" если ответа нет
```

| Опция `run` | Что задаёт |
| --- | --- |
| `input` | Вопрос: строка или JSON |
| `messages` | История диалога вместо `input` или вместе с ним |
| `output` | Структурированный ответ, см. ниже |
| `metadata` | Данные запуска для политики подтверждения и журнала |
| `maxSteps` | Предел ответов модели (по умолчанию 30) |
| `runTimeoutMs` | Срок всего запуска; по умолчанию срока нет |
| `compaction` | Настройки [сжатия диалога](#длинный-диалог-сжатие) для этого запуска; `false` оставляет диалог как есть |
| `approvals` | Решения человека для запуска, который [ждал подтверждения](#подтверждение-человеком) |
| `modelProfile` | Профиль модели вместо указанного в определении |
| `signal` | Отмена запуска |
| `onTextDelta` | Текст ответа по частям, пока модель его пишет: `({ step, text }) => …` |
| `onEvent` | Всё, что происходит в запуске: шаги, вызовы инструментов, повторы — см. [события](#ход-запуска-события) |

## Агенты в базе

Определение — обычные данные, поэтому его можно хранить в таблице и
редактировать без выпуска:

```ts
@Entity({ table: "agents" })
export class AgentRecord {
  @UUID({ version: "v7" }) id = "";
  @Index({ unique: true }) @Nullable() @Column({ type: "text" }) name = "";
  @Nullable() @Column({ type: "text" }) instructions = "";
  @Nullable() @Column({ type: "json" }) toolNames: string[] = [];
  @Nullable() @Column({ type: "text" }) modelProfile?: string;
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
  `TOOL_NOT_VISIBLE_TO_AGENT` (выдуманное имя — `TOOL_NOT_REGISTERED`),
  `execute` не выполнится, а модель увидит отказ и продолжит:

  ```text
  POST /agents/support/ask {"question":"…"}     ← модель просит orders.cancel
  → {"status":"completed","answer":"Инструмент ответил: TOOL_NOT_VISIBLE_TO_AGENT",
     "tools":[{"name":"orders.cancel","status":"denied","error":"TOOL_NOT_VISIBLE_TO_AGENT"}]}
  ```

  > [!NOTE]
  > С версии 0.111.1. Раньше такой вызов обрывал запуск с
  > `AGENT_PROVIDER_FAILED`: модель не видела отказ.
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

Ответ, который не прошёл схему или не является JSON, рантайм возвращает
модели с перечнем замечаний и просит исправить — до двух раз
(`maxOutputRepairs`). Если и после этого ответ не принят, запуск завершается
с `status: "failed"` и кодом `AGENT_OUTPUT_INVALID`; для невалидного JSON
текст ошибки — `JSON output is malformed.`. В `result.messages` остаётся
один ответ: отвергнутые черновики и просьбы рантайма в диалог не попадают.
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
`TOOL_EXECUTION_OPTIONS` — настройки исполнения инструментов, общие для
агентов и [`ToolRunner`](tools.md#вызов-без-модели). Настройки самого
агента (`maxSteps`, `timeoutMs`) — в `AGENT_RUNTIME_OPTIONS`. Оба токена
можно зарегистрировать в любом модуле:

```ts
import { AGENT_RUNTIME_OPTIONS, TOOL_EXECUTION_OPTIONS, type ToolExecutionOptions } from "bazis/core/agent";
import { Module, singleton, singletonValue } from "bazis/core/di";

/** Настройки исполнения — класс: им нужен журнал из DI. Поля задаются в конструкторе. */
export class AppToolOptions implements ToolExecutionOptions {
  readonly auditSink: ToolExecutionOptions["auditSink"];
  readonly approvalPolicy: ToolExecutionOptions["approvalPolicy"];

  constructor(audit: ToolAuditLog) {
    this.auditSink = (entry) => audit.write(entry);
    // Чтение разрешено всегда, изменение — только от имени администратора.
    this.approvalPolicy = (request) => request.tool.metadata.sideEffect === "read" || request.metadata.role === "admin";
  }
}

@Module({
  providers: [
    singleton(ToolAuditLog),
    singletonValue(AGENT_RUNTIME_OPTIONS, { maxSteps: 6 }),
    singleton(TOOL_EXECUTION_OPTIONS, AppToolOptions),
  ],
  exports: [ToolAuditLog],
})
export class AgentSettingsModule {}
```

Поля, а не методы: исполнитель копирует настройки (`{ ...options }`), а
методы класса при копировании теряются.

`metadata` передаётся при запуске — например, роль пользователя из запроса:

```ts
await this.agents.run(definition, { input: body.question, metadata: { role: user.role } });
```

```text
POST /agents/operator/ask             {"question":"отмени заказ 7"}
→ {"tools":[{"name":"orders.cancel","status":"denied","error":"TOOL_APPROVAL_DENIED"}]}

POST /agents/operator/ask?role=admin  {"question":"отмени заказ 7"}
→ {"answer":"Заказ: {\"name\":\"orders.cancel\",\"status\":\"success\",\"output\":{\"id\":7,\"status\":\"cancelled\",\"total\":300}}",
   "tools":[{"name":"orders.cancel","status":"success"}]}

POST /agents/support/ask              {"question":"Где заказ 42?"}
→ {"tools":[{"name":"orders.find","status":"success"}]}

журнал: result orders.cancel denied · attempt orders.cancel · result orders.cancel success ·
        attempt orders.find · result orders.find success
```

| Настройка | Что задаёт |
| --- | --- |
| `maxSteps` | Предел ответов модели за запуск (по умолчанию 30) |
| `timeoutMs` | Срок одного вызова модели (по умолчанию 60 с, `0` — без срока) |
| `TOOL_EXECUTION_OPTIONS.auditSink` | Куда писать журнал вызовов инструментов |
| `TOOL_EXECUTION_OPTIONS.approvalPolicy` | Разрешить ли вызов: `(request) => true`, `false`, `{ approved: false, message }` или `"ask"` — [спросить человека](#подтверждение-человеком); в `request` есть `caller` (`"agent"`) и `actor` |
| `TOOL_EXECUTION_OPTIONS.defaultTimeoutMs` | Срок вызова инструмента (по умолчанию 30 с) |
| `contextLimits` | Сколько истории отправлять модели |

Когда политика задана, она решает за **каждый** инструмент, кроме тех, у
кого в `@Tool` стоит `approval: "never"`, — в том числе за чтение. Поэтому
в примере чтение разрешено явно. Без политики:

| `approval` в `@Tool` | Без политики | С политикой |
| --- | --- | --- |
| `"never"` (только для `read` и `none`) | Выполняется | Не спрашивается |
| `"policy"` — по умолчанию для `read` и `none` | Чтение выполняется, запись — отказ | Спрашивается |
| `"required"` — по умолчанию для `write` и `external` | Отказ `TOOL_APPROVAL_REQUIRED` | Спрашивается |

### Подтверждение человеком

Правило не всегда может решить само: отменить заказ или вернуть деньги
должен разрешить человек. Тогда политика отвечает `"ask"`:

```ts
this.approvalPolicy = (request) => request.tool.metadata.sideEffect === "read" ? true : "ask";
```

Запуск останавливается, ничего не изменив, и возвращает `status: "waiting"`:

```ts
const first = await this.agents.run(operator, { id: runId, input: "Отмени заказ 7" });
first.status;            // "waiting"
first.pendingApprovals;  // [{ call: { id: "c1", name: "orders.cancel", input: { id: 7 } },
                         //    tool: { name: "orders.cancel", description: "…", sideEffect: "write" } }]
await this.runs.save(runId, first.messages);   // диалог хранит приложение
```

Покажите человеку, что именно агент хочет сделать (`call.name`, `call.input`),
и, получив ответ, продолжите запуск: тот же диалог и решение.

```ts
const second = await this.agents.run(operator, {
  id: runId,
  messages: await this.runs.load(runId),
  approvals: [{ callId: "c1", approved: true }],
});
second.status;   // "completed": инструмент выполнен, модель ответила
```

```text
approved: true                                   → orders.cancel выполнен, в контексте инструмента approval: "approved"
approved: false, message: "Заказ уже отгружен."  → модель получает: Tool "orders.cancel" was declined: Заказ уже отгружен.
```

Что важно знать:

- Между остановкой и продолжением может пройти сколько угодно времени и
  смениться процесс: всё состояние — в `result.messages`. Храните их на
  сервере: решение человека относится к вызову с этими аргументами.
- Продолжайте с тем же `id` запуска: по нему строится ключ идемпотентности
  инструмента.
- Продолжение без `approvals` снова вернёт `"waiting"`. Вместе с `input`
  такой диалог продолжить нельзя: сначала ответ на вызов.
- Если модель запросила несколько инструментов, запуск останавливается на
  первом, который требует решения. Сделанное до него остаётся в диалоге,
  остальное выполняется после ответа. Следующий такой вызов остановит
  запуск ещё раз.
- Агент, вызванный [как инструмент](#агент-как-инструмент), спросить
  человека не может: вызывающая модель получит ошибку
  `agent_needs_approval`.

Политика может и отказать с объяснением для модели:
`{ approved: false, message: "Отмена закрыта до понедельника." }`.

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

`maxTokens` считается по оценке: настоящий размер запроса знает только
провайдер. Оценка идёт по символам (латиница — около четырёх символов на
токен, кириллица — около двух), а после каждого ответа рантайм сверяет её
с `usage.inputTokens` провайдера и запоминает поправку для профиля модели.
Поправка видна в запросе: `metadata.agentContext.tokenScale`.

Один большой результат инструмента не должен занять всё окно модели.
Результат длиннее `contextLimits.maxToolResultChars` (по умолчанию
100 000 символов JSON) модель получает урезанным:
`{ "truncated": true, "totalChars": 250000, "text": "…начало…" }`.
В `result.toolResults` и `result.messages` результат остаётся целым.

## Изображения и файлы

Сообщение пользователя может состоять из нескольких частей: текста,
изображения, файла.

```ts
import { agentFile, agentImage, agentMessage, agentText } from "bazis/core/agent";

const question = agentMessage("user", [
  agentText("Что на фотографии и что сказано в договоре о сроках?"),
  agentImage("https://files.example/box.png"),
  agentFile(`data:application/pdf;base64,${pdf.toString("base64")}`, { name: "contract.pdf" }),
]);
const result = await this.agents.run(support, { messages: [question] });
```

Изображение и файл можно передать адресом или `data:`-строкой. Что именно
примет модель, зависит от [адаптера](llm-connectors.md): Claude принимает
изображения и PDF обоими способами, OpenAI-совместимый API — изображения
обоими, а файлы только `data:`-строкой. Файл, заданный адресом, такой API
получит как упоминание в тексте.

## Рассуждения модели

Модель, которая умеет рассуждать перед ответом, возвращает рассуждения
отдельными частями сообщения — `kind: "reasoning"`. Поэтому текст ответа
берите через `agentMessageText(result.finalMessage)`, а не из первой части
сообщения: первой может оказаться часть с рассуждениями.

Сохраняйте `result.messages` целиком и передавайте в следующий запуск как
есть: рассуждения возвращаются тому же провайдеру вместе с диалогом. Менять
их или переносить в другой диалог нельзя — провайдер проверяет, что диалог
тот же. Там, где рантайм сам переписывает диалог (сжатие, обрезка по
`contextLimits`), он убирает рассуждения из оставшихся сообщений; слова и
вызовы инструментов остаются.

## Длинный диалог: сжатие

`contextLimits` просто отбрасывает старые сообщения — вместе с ними модель
забывает, о чём шла речь. Сжатие сохраняет суть: когда диалог подходит к
окну модели, рантайм просит модель пересказать его старую часть и заменяет
её одним сообщением. Последние сообщения остаются как были, вызов
инструмента никогда не отделяется от своих результатов.

Сжатие включено всегда, но чтобы оно началось заранее, рантайм должен
знать окно модели. Укажите его в коннекторе:

```ts
@Infra({ llm: llmConnect(llmConfig, openAiCompatibleAdapter(), { contextTokens: 128_000 }) })
export class AppInfra {}
```

```text
диалог оценён в 110 000 токенов, окно 128 000 (порог — 80%, 102 400):
→ запрос модели: «перескажи», 34 старых сообщения текстом
→ запрос модели: инструкции, пересказ, 8 последних сообщений
→ status: "completed", steps: 1, compactions: 1
→ info: Agent context compacted {"reason":"size","messages":34,"tokensBefore":110000,"tokensSummarized":86000}
```

Без `contextTokens` сжатие срабатывает только после отказа: если
провайдер отвечает, что запрос длиннее окна, рантайм сжимает диалог и
повторяет шаг. Второй отказ подряд завершает запуск с
`AGENT_CONTEXT_OVERFLOW`.

Пересказ — не шаг агента: `steps` его не считает, а токены входят в
`result.usage`. Если пересказ не удался, запуск идёт дальше с целым
диалогом, а в журнале остаётся `Agent context was not compacted`.

| Настройка `compaction` | Что задаёт |
| --- | --- |
| `maxTokens` | Размер диалога, с которого начинается сжатие; по умолчанию 80% от `contextTokens` |
| `keepTokens` | Сколько последних сообщений остаётся как есть; по умолчанию четверть `maxTokens` |
| `modelProfile` | Профиль модели для пересказа, например дешёвый; по умолчанию профиль запуска |
| `instructions` | Свои инструкции для пересказа вместо встроенных |

Настройки задаются в `AGENT_RUNTIME_OPTIONS` (`compaction: { maxTokens: 60_000 }`)
или опцией запуска. `compaction: false` выключает сжатие совсем.

> [!IMPORTANT]
> После сжатия `result.messages` начинается с пересказа — сообщения
> пользователя с `metadata.runtime: "summary"`, — а не с исходного диалога.
> Сохраняя `result.messages` как память агента, вы сохраняете уже сжатый
> диалог, и следующий запуск его не пересказывает заново. Историю для
> показа человеку храните отдельно. О сжатии говорит `result.compactions`.

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
| `AGENT_RUN_TIMEOUT` | Запуск не уложился в `runTimeoutMs` |
| `AGENT_PROVIDER_TIMEOUT` | Модель не ответила за `timeoutMs` |
| `AGENT_PROVIDER_FAILED` | Модель вернула ошибку; ключи и токены в тексте замаскированы |
| `AGENT_PROVIDER_STOPPED` | Модель остановилась не сама: лимит ответа исчерпан и после продолжений, фильтр |
| `AGENT_CONTEXT_OVERFLOW` | Запрос не помещается в окно модели и после сжатия диалога |
| `AGENT_ABORTED` | Запуск отменён через `signal` |
| `AGENT_TOOL_OUTCOME_UNKNOWN` | Инструмент с записью прервался, и неизвестно, успел ли он что-то изменить; запуск остановлен, повторять вызов автоматически нельзя |

## Что рантайм исправляет сам

Сбой провайдера или ошибка модели не обязаны обрывать запуск. Рантайм
сначала пробует исправить положение и только потом возвращает `failed`:

| Что случилось | Что делает рантайм | Настройка в `AGENT_RUNTIME_OPTIONS` |
| --- | --- | --- |
| Провайдер занят: HTTP 429, 5xx, оборвалось соединение | Повторяет запрос: всего три попытки, пауза 0,5 с удваивается; `Retry-After` учитывается | `modelRetry: { maxAttempts, delayMs, maxDelayMs }` |
| Ответ обрезан лимитом (`finishReason: "length"`) | Просит модель продолжить с места обрыва, до трёх раз; `finalMessage` — весь текст одним сообщением | `maxOutputContinuations` |
| Структурированный ответ не прошёл схему | Возвращает замечания модели, до двух раз | `maxOutputRepairs` |
| Модель написала аргументы инструмента битым JSON | Инструмент не вызывается; модель получает `TOOL_ARGUMENTS_INVALID` и пишет вызов заново | — |

Повтор запроса — не новый шаг: `steps` считает ответы модели. Продолжение
и исправление — шаги, и за `maxSteps` они не выходят. Запрос не
повторяется, если модель уже начала выдавать текст через `onTextDelta`:
иначе пользователь увидел бы два начала ответа. `0` в
`maxOutputContinuations` или `maxOutputRepairs` и `maxAttempts: 1`
выключают соответствующее поведение.

```text
модель отвечает HTTP 503, затем HTTP 503, затем текстом:
→ status: "completed", steps: 1
→ warn: Agent model call failed, repeating {"attempt":1,"maxAttempts":3,"delayMs":500, …}
→ warn: Agent model call failed, repeating {"attempt":2,"maxAttempts":3,"delayMs":1000, …}
```

### Инструменты одного шага

Модель может запросить несколько инструментов сразу. Стоящие подряд
инструменты, которые ничего не меняют (`sideEffect: "none"` или `"read"`),
выполняются одновременно — до восьми (`maxParallelToolCalls`). Инструменты
с записью (`"write"`, `"external"`) всегда выполняются по одному, в том
порядке, в каком их написала модель. Результаты в диалоге стоят в порядке
вызовов, кто бы ни закончил первым. `maxParallelToolCalls: 1` возвращает
выполнение строго по одному.

## Ход запуска: события

Пока агент работает, пользователь смотрит на пустой экран. Опция `onEvent`
сообщает, что происходит, в том порядке, в каком это происходит:

```ts
await this.agents.run(support, {
  input: question,
  onEvent: (event) => {
    if (event.kind === "tool-started") progress(`Ищу: ${event.call.name}`);
  },
});
```

| Событие | Когда | Что в нём |
| --- | --- | --- |
| `step-started` | Модель спрошена | `step` |
| `text-delta` | Модель пишет ответ | `step`, `text` — очередной кусок |
| `model-retry` | Провайдер занят, запрос будет повторён | `attempt`, `maxAttempts`, `delayMs` |
| `model-answered` | Модель ответила | `message`, `toolCalls`, `finishReason`, `usage` |
| `tool-started` | Вызов инструмента начат | `call`: имя и аргументы |
| `tool-finished` | Вызов инструмента закончен | `result`: то, что получит модель |
| `compacted` | Старая часть диалога заменена пересказом | `reason`, `messages` |
| `finished` | Запуск закончен; всегда последнее | `result` — то же, что вернёт `run` |

В каждом событии есть `invocationId`. Обработчик синхронный; если он
бросит исключение, оно попадёт в журнал (`Agent event observer failed`),
а запуск продолжится. Текст из `text-delta` — черновой: ответ ещё не
проверен, а при структурированном ответе текст не приходит вовсе.

Чтобы отдавать события клиенту по мере появления, возьмите `stream`: те же
события, но итератором. Вместе с [потоковым ответом](../overview/responses.md#потоковые-ответы)
получается чат, в котором видно, как агент работает:

```ts
@Post("ask")
ask(body: AskRequest) {
  const events = this.agents.stream(support, { input: body.question });
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for await (const event of events) {
        if (event.kind === "text-delta") controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.text })}\n\n`));
        if (event.kind === "tool-started") controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool: event.call.name })}\n\n`));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
```

```text
data: {"tool":"orders.find"}
data: {"text":"Заказ 42 "}
data: {"text":"оплачен."}
```

Выход из цикла раньше события `finished` отменяет запуск. Определение,
которое нельзя запустить, отклоняет итератор той же ошибкой
`AgentSetupError`, что и `run`.

## Агент как инструмент

Один агент может поручить часть работы другому. `agentTool` делает из
определения агента инструмент: вызывающий агент передаёт задачу словами,
вложенный работает в собственном диалоге со своими инструментами, и назад
возвращается только его ответ.

```ts
import { agentTool, type AgentDataDefinition } from "bazis/core/agent";

const researcher: AgentDataDefinition = {
  name: "researcher",
  instructions: "Находи факты о заказах. Отвечай коротко и только фактами.",
  toolNames: ["orders.find", "orders.history"],
  modelProfile: "fast",
};

export const researchOrders = agentTool({
  name: "research.orders",
  description: "Находит факты о заказах. Передай полный вопрос: агент не видит этот разговор.",
  agent: researcher,
});

@Module({ tools: [FindOrderTool, OrderHistoryTool, researchOrders] })
export class SupportModule {}
```

```text
ведущий агент: вызов research.orders {"task":"Оплачен ли заказ 42?"}
  researcher: вызов orders.find {"id":42} → {"id":42,"status":"paid"}
  researcher: «Заказ 42 оплачен.»
ведущий агент получает: {"answer":"Заказ 42 оплачен."}
```

Зачем это нужно: диалог ведущего агента остаётся коротким — в нём нет
десятков результатов поиска, — а чтение можно отдать быстрой дешёвой
модели. Несколько таких инструментов в одном шаге выполняются
[одновременно](#инструменты-одного-шага).

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `agent` | — | Определение вложенного агента |
| `output` | — | [Структурированный ответ](#структурированный-ответ): тогда в результате есть `output` |
| `maxSteps`, `modelProfile` | как у агента | Пределы и модель вложенного запуска |
| `timeoutMs` | 5 минут | Срок одного вызова вместе со всем вложенным запуском |
| `maxDepth` | 3 | Насколько глубоко агенты могут вызывать агентов; дальше вызов отклоняется |
| `sideEffect` | `"none"` | Что меняет сам инструмент. Инструменты вложенного агента подтверждаются и попадают в аудит по отдельности |

Вложенный агент получает только задачу: ни диалога, ни инструкций
вызывающего. Поэтому описание инструмента должно просить полный вопрос.
Если вложенный запуск не удался, вызывающая модель получает ошибку
`Agent "researcher" did not finish: …` и сама решает, что делать дальше.
В `metadata` вложенного запуска есть `parentInvocationId` и `agentDepth`:
по ним политика подтверждения и журнал видят, кто кого вызвал.

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

- [Инструменты](tools.md)
- [Хуки инструментов и аудит](hooks.md)
- [LLM-коннекторы](llm-connectors.md)
- [Тестирование](../fundamentals/testing.md)
