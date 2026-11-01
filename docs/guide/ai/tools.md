# Инструменты

Инструмент — операция вашего приложения с контрактом: найти заказ,
посчитать цену, отменить бронь. Это класс с декоратором `@Tool` и методом
`execute`. Вызвать его может агент (его выбирает модель) или код, который
решает сам, — например движок бизнес-процессов. Исполнитель один: он
проверяет аргументы, создаёт экземпляр через DI и возвращает результат.

Как агенту дают инструменты — в главе [Агенты](agents.md). Здесь — как
написать сам инструмент.

Все примеры проверены на bazis 0.123.0. Модель в проверках — скрипт с
заданными шагами.

## Инструмент

```ts
// catalog/tools/Price.tool.ts
import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";

export class PriceInput {
  @Validator({ required: true, minLength: 2, maxLength: 32 }) sku!: string;
  @Validator({ min: 1, max: 100, integer: true }) quantity = 1;
}

export class PriceOutput {
  sku = "";
  total = 0;
}

@Tool({
  name: "catalog.price",
  description: "Цена товара с учётом количества.",
  input: PriceInput,
  output: PriceOutput,
  sideEffect: "read",
  callers: ["agent"],
})
export class PriceTool {
  constructor(private readonly prices: PriceService) {}

  async execute(input: PriceInput, context: AgentToolExecutionContext): Promise<PriceOutput> {
    const price = await this.prices.of(input.sku, context.signal);
    return Object.assign(new PriceOutput(), { sku: input.sku, total: price * input.quantity });
  }
}
```

```ts
@Module({
  providers: [scoped(PriceService)],
  tools: [PriceTool],
})
export class CatalogModule {}
```

Инструмент лежит в папке `tools/` модуля, которому принадлежит операция,
объявляется полем `tools` этого модуля и видит его сервисы. Как
контроллер, он тонкий: проверяет вход, вызывает сервис и собирает
результат, а правила остаются в сервисе.
Регистрировать его в `providers` не нужно: каждый вызов получает свою
область DI и новый экземпляр, как контроллер на запрос.

| Параметр `@Tool` | Что задаёт |
| --- | --- |
| `name` | Имя для модели и для `toolNames` агента; уникально в приложении |
| `description` | Что делает инструмент: по нему модель решает, когда его звать |
| `input` | Класс входа: из него строится JSON-схема для модели и проверка аргументов |
| `output` | Класс результата: проверяется так же, схема уходит модели |
| `sideEffect` | `none`, `read`, `write`, `external` — что инструмент меняет |
| `approval` | `never`, `policy`, `required` — нужно ли подтверждение, см. [Агенты](agents.md#настройки-аудит-и-подтверждение) |
| `timeoutMs` | Срок вызова, по умолчанию 30 секунд |
| `callers` | **Обязательно.** Кто может вызывать: `"agent"` — агенты, другой id (`"workflow"`) — код через [`ToolRunner`](#вызов-без-модели) |
| `tags` | Метки для каталога и поиска; на доступ не влияют |

Инструмент без `callers` останавливает запуск:

```text
[bazis] configuration error: Tool "catalog.price" (PriceTool) declares no callers: list who may call it, for example callers: ["agent"] for LLM agents or ["workflow"] for a process engine.
```

Вызов от того, кого нет в `callers`, получает отказ
`TOOL_CALLER_NOT_ALLOWED` ещё до проверки аргументов. Агенту инструмент,
кроме `callers: ["agent"]`, нужен и в его `toolNames`.

Пишите `description` для модели: коротко, что делает и когда звать. От
него зависит, выберет ли модель инструмент.

## Что видит модель

Модель получает имя, описание и схемы. Схему строит кодогенерация из
классов `input` и `output`, вместе с правилами `@Validator`:

```json
{"name":"catalog.price","description":"Цена товара с учётом количества.",
 "input":{"kind":"json-schema","name":"PriceInput","schema":{"type":"object",
   "properties":{"sku":{"type":"string","minLength":2,"maxLength":32},
                 "quantity":{"type":"integer","minimum":1,"maximum":100}},
   "required":["sku"],"additionalProperties":false}},
 "output":{"kind":"json-schema","name":"PriceOutput","schema":{"type":"object",
   "properties":{"sku":{"type":"string"},"total":{"type":"number"}},"additionalProperties":false}},
 "sideEffect":"read","approval":"policy"}
```

Поле со значением по умолчанию (`quantity = 1`) необязательно.

## Проверка аргументов

Модель может прислать что угодно. До вызова `execute` аргументы проходят
схему и правила `@Validator`, и `execute` получает экземпляр `PriceInput`.
Ошибка уходит модели, чтобы та могла исправить вызов:

```text
{"sku":"k","quantity":0}
→ TOOL_INPUT_VALIDATION_FAILED: Tool "catalog.price" input failed schema validation.
  issues: sku — Field "sku" must be at least 2 characters long
          quantity — Field "quantity" must be at least 1

{"sku":"kiwi","extra":true}
→ TOOL_INPUT_INVALID: Field "extra" is forbidden or not declared by the model.
```

В обоих случаях `execute` не вызывался, а экземпляр инструмента даже не
создавался.

## Контекст вызова

Второй аргумент `execute` — что известно о вызове:

| Поле | Что в нём |
| --- | --- |
| `agentName` | Какой агент вызвал |
| `invocationId` | Номер запуска агента |
| `metadata` | `metadata` из `run(…, { metadata })` — например, пользователь |
| `signal` | Отмена: срок вышел или запуск отменён |
| `idempotencyKey` | Ключ вызова для защиты от повторной записи |
| `attempt`, `maxAttempts` | Номер попытки при повторах |
| `call` | Вызов модели: `id`, `name`, `input` |
| `tool` | Определение инструмента: `metadata` из `@Tool` |

```text
run(agent, { input: "go", metadata: { userId: "u1" } })
→ context: {"agent":"lab","invocation":"inv-4673…","attempt":1,"maxAttempts":1,
            "key":"agent:40:inv-4673…:2:c1","approval":"not-required","metadata":{"userId":"u1"}}
```

Права проверяйте по `metadata`, а не по тексту запроса: модель не может
подменить `metadata`, оно приходит из вашего кода.

## Ошибки

Если инструмент не может выполнить запрос и модели нужно знать почему,
бросьте `ToolError` — его текст модель получит как есть:

```ts
import { ToolError } from "bazis/core/agent";

const product = await this.products.find(input.sku);
if (!product) throw new ToolError(`Товар ${input.sku} снят с продажи`);
```

Любое другое исключение модель видит без подробностей, а в журнал
приложения оно попадает целиком, со стеком:

```text
throw new Error("db host 10.0.0.5 is down, password=hunter2")

модели:  {"code":"TOOL_EXECUTION_FAILED","message":"Tool execution failed."}
журнал:  error: Agent tool failed {"agent":"support","tool":"catalog.price","callId":"c1",
           "code":"TOOL_EXECUTION_FAILED","error":{"name":"Error",
           "message":"db host 10.0.0.5 is down, password=***","stack":"Error: db host…"}}
```

Так адреса, SQL и прочие подробности не уходят провайдеру модели и не
попадают в её ответ пользователю.

Причину, по которой вызывающий может выбрать дальнейший путь, передайте в
`reason`: она придёт в `error.details.reason`. Процесс по ней не повторяет
вызов и выбирает [ветвь ошибки](../workflow/processes.md#ошибка-с-причиной):

```ts
throw new ToolError("Нет слотов доставки", { reason: "no_slots" });
```

| Что случилось | Код | Модель видит |
| --- | --- | --- |
| `throw new ToolError(text)` | `TOOL_EXECUTION_FAILED` | `text` |
| Любое другое исключение в `execute` | `TOOL_EXECUTION_FAILED` | `Tool execution failed.` |
| Конструктор инструмента упал | `TOOL_RESOLVE_FAILED` | `Tool could not be created.` |
| Аргументы не прошли проверку | `TOOL_INPUT_VALIDATION_FAILED`, `TOOL_INPUT_INVALID` | Список нарушений |
| Вышел `timeoutMs` | `TOOL_TIMEOUT` | `Tool execution timed out.` |

> [!NOTE]
> С версии 0.99.2. Раньше текст любого исключения уходил модели, а в
> журнал не попадало ничего.

## Срок и отмена

`timeoutMs` ограничивает весь вызов: проверку, создание и `execute`.
Передавайте `context.signal` в `fetch`, запросы к базе и другие долгие
операции — по сроку они прервутся:

```ts
@Tool({ name: "lab.slow", description: "Медленное чтение.", sideEffect: "read", timeoutMs: 100, callers: ["agent"] })
```

```text
→ TOOL_TIMEOUT: Tool execution timed out.   (через 102 мс; запуск агента продолжается)
```

Модель получает ошибку и может попробовать иначе.

## Инструменты с записью

С записью (`write`, `external`) срок и исключения опаснее: неизвестно,
успел ли инструмент что-то изменить. Рантайм не гадает — запуск
останавливается, модель больше не вызывается:

```text
@Tool({ name: "lab.slow-write", sideEffect: "write", timeoutMs: 100, callers: ["agent"] })

→ инструмент: TOOL_TIMEOUT_OUTCOME_UNKNOWN
→ запуск:     failed, AGENT_TOOL_OUTCOME_UNKNOWN
  "Tool \"lab.slow-write\" finished with an unknown retry-safe side-effect outcome;
   automatic model continuation is blocked."
→ журнал:     error: Agent tool outcome unknown {"agent":"lab","tool":"lab.slow-write",
                "callId":"c1","code":"TOOL_TIMEOUT_OUTCOME_UNKNOWN","phase":"execute"}
```

То же — если `execute` такого инструмента бросил обычное исключение. Что
делать дальше, решает приложение: проверить состояние по
`details.idempotencyKey` и, если нужно, повторить.

Если инструмент знает, что ещё ничего не записал, — платёжный шлюз занят,
внешний сервис отказал до начала операции, — пусть скажет это явно:

```ts
import { AgentToolPreCommitError } from "bazis/core/agent";

if (gateway.busy) throw new AgentToolPreCommitError("Платёжный шлюз занят");
```

Тогда исход известен: модель получит `Платёжный шлюз занят`, а запуск
продолжится.

Записи нужны журнал вызовов и политика подтверждения — без них инструмент
не выполнится; настройка — в главе [Агенты](agents.md#настройки-аудит-и-подтверждение).

## Повторы

По умолчанию упавший вызов не повторяется: ошибка уходит модели. Повторы
включает `retryPolicy` в настройках исполнения инструментов — они общие
для агентов и `ToolRunner`:

```ts
singletonValue(TOOL_EXECUTION_OPTIONS, {
  retryPolicy: { maxAttempts: 3, delayMs: 100, backoff: "exponential" },
})
```

```text
lab.flaky падает два раза:
  без retryPolicy  → TOOL_EXECUTION_FAILED, 1 попытка
  maxAttempts: 3   → success, {"attempt":3}
```

Каждая неудачная попытка попадает в журнал как `Agent tool failed`, даже
если следующая удалась: так видно, что сервис сбоит.

| Инструмент | Что повторяется |
| --- | --- |
| `none`, `read` | Исключение в `execute` и ошибка создания |
| `write`, `external` | Только `AgentToolPreCommitError` — с тем же `idempotencyKey` во всех попытках |

Ключ `idempotencyKey` одинаков во всех попытках одного вызова и разный у
разных вызовов. Сохраняйте его вместе с изменением: если такой ключ уже
есть, запись уже сделана.

```text
lab.flaky-write: AgentToolPreCommitError, затем успех
→ success, {"attempt":3,"key":"agent:40:inv-d52c…:2:c1"}
```

## Вызов без модели

Когда инструмент выбирает код, а не модель — [движок бизнес-процессов](../workflow/processes.md),
задача по расписанию, — его вызывает `ToolRunner`. Фреймворк регистрирует
его сам, если в приложении есть инструменты. Код привязывает его к своему
id вызывающего:

```ts
import { ToolRunner, type BoundToolRunner } from "bazis/core/agent";

export class ProcessSteps {
  private readonly tools: BoundToolRunner;

  constructor(runner: ToolRunner) {
    this.tools = runner.as("workflow");
  }

  run(step: { tool: string; input: unknown }, instanceId: string, userId: string) {
    return this.tools.run(step.tool, step.input, {
      actor: { kind: "user", id: userId },
      idempotencyKey: `${instanceId}:${step.tool}`,
    });
  }
}
```

- `as("workflow")` видит только инструменты, у которых в `callers` есть
  `"workflow"`: `listTools(tags)`, `getTool`, `describe` и `run`. Имя
  инструмента может прийти из данных (сохранённого процесса), но вызвать
  чужой инструмент не получится — `TOOL_CALLER_NOT_ALLOWED`.
- `actor` — от чьего имени вызов: `{ kind: "user" | "system", id }`. Для
  `write` и `external` он обязателен (`TOOL_ACTOR_REQUIRED`); политика
  подтверждения и аудит получают его вместе с `caller`.
- `run` не бросает исключение из-за ошибки инструмента: она приходит
  результатом со `status` и `error.code`.
- Проверка аргументов, подтверждение, аудит, хуки, повторы и срок — те же,
  что у агента; настраиваются один раз в `TOOL_EXECUTION_OPTIONS`.
- `as("agent")` запрещён: агенты вызывают инструменты через
  [`AgentRuntime`](agents.md).

> [!NOTE]
> `callers`, папка `tools/`, `ToolRunner` и `TOOL_EXECUTION_OPTIONS` — с
> версии 0.123.0 ([переход](../reference/upgrading.md#01230)).

## Дальше

- [Агенты](agents.md)
- [Хуки инструментов и аудит](hooks.md)
- [Проверка данных](../overview/validation.md)
