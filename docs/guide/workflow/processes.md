# Бизнес-процессы

Процесс — это граф шагов, который описан данными и исполняется сам: «принять
заказ → списать оплату → если не прошла, поручить сотруднику позвонить
клиенту». Шаги, которые действуют, — это [инструменты](../ai/tools.md)
модулей. Шаги, которые ждут человека, — задачи сотрудникам.

`WorkflowModule` даёт каталог процессов, публикацию версий, исполнение в
базе, фоновый воркер, события и HTTP. Интерфейса нет: дизайнер процессов,
входящие задачи и формы строит приложение поверх сервисов и HTTP модуля.

Все примеры проверены на bazis 0.124.0–0.126.0 с PostgreSQL 17 в приложении
«Заказы» из этой главы.

## Подключение

```ts
import { DI, Module } from "bazis/core/di";
import { TOOL_EXECUTION_OPTIONS } from "bazis/core/agent";
import { WorkflowAccess, WorkflowModule } from "bazis/core/workflow";

@Module({
  imports: [AppInfra, WorkflowModule, PaymentsModule],
  providers: [
    DI.singleton(DI.classProvider(WorkflowAccess, AppWorkflowAccess, [])),
    DI.singleton(DI.valueProvider(TOOL_EXECUTION_OPTIONS, {
      auditSink: (entry) => console.log(`audit ${entry.phase} ${entry.tool?.name} caller=${entry.caller} actor=${entry.actor?.id}`),
      // Опубликованный процесс и есть одобрение его шагов.
      approvalPolicy: (request) => request.caller === "workflow",
    })),
  ],
})
export class AppModule {}
```

- **Таблицы модуль создаёт сам** при первом старте и проверяет при каждом
  следующем: это [owned stores](../database/owned-stores.md) с префиксами
  `bazis_wf_def_` и `bazis_wf_run_`. Нужно только подключение к PostgreSQL
  в `@Infra` (`ormBazisConnect`), миграции не нужны.
- **`WorkflowAccess`** говорит HTTP модуля, кто делает запрос и что ему
  можно ([Права](#права-workflowaccess)). Без него все маршруты
  `/workflow/...` отвечают 403.
- **`TOOL_EXECUTION_OPTIONS`** — те же настройки, что у агентов: журнал
  вызовов и политика подтверждения. Без журнала инструмент с записью не
  выполнится (`TOOL_AUDIT_REQUIRED`), без политики — тоже
  (`TOOL_APPROVAL_REQUIRED`, пример ниже).

`WorkflowModule` состоит из двух частей, их можно подключать по
отдельности: `WorkflowDefinitionsModule` — каталог и версии,
`WorkflowRuntimeModule` — исполнение (он сам импортирует первую часть).

## Шаг — это инструмент

Шаг «Действие» вызывает инструмент модуля, которому принадлежит операция.
Процессу инструмент доступен, если в его `callers` есть `"workflow"`:

```ts
// payments/tools/Charge.tool.ts
@Tool({
  name: "payments.charge",
  description: "Charges an order.",
  input: ChargeInput,
  output: ChargeOutput,
  sideEffect: "write",
  callers: ["workflow"],
})
export class ChargeTool {
  constructor(private readonly payments: PaymentsService) {}

  execute(input: ChargeInput, context: AgentToolExecutionContext): ChargeOutput {
    return Object.assign(new ChargeOutput(), this.payments.charge(input.orderId, input.amount, context.idempotencyKey!));
  }
}

@Module({ providers: [singleton(PaymentsService)], tools: [ChargeTool] })
export class PaymentsModule {}
```

Процесс вызывает инструмент от имени того, кто запустил экземпляр, с ключом
идемпотентности — id шага. Если приложение упадёт между вызовом и записью
результата, вызов повторится с тем же ключом: инструмент с записью должен
по нему узнать повтор и не списывать деньги дважды
([Инструменты с записью](../ai/tools.md#инструменты-с-записью)).

## Документ процесса

Процесс описывается JSON-документом `bazis.workflow/v1`: вход, узлы и
переходы.

```json
{
  "schemaVersion": "bazis.workflow/v1",
  "input": { "fields": [
    { "code": "orderId", "type": "string", "required": true },
    { "code": "amount", "type": "number", "required": true }
  ] },
  "nodes": {
    "Start": { "kind": "manualStart", "title": "Заказ создан" },
    "Pay": { "kind": "serviceTask", "title": "Оплата", "config": {
      "tool": "payments.charge",
      "input": { "orderId": "$input.orderId", "amount": "$input.amount" },
      "saveTo": "payment"
    } },
    "Paid": { "kind": "exclusiveGateway", "title": "Оплачено?" },
    "Call": { "kind": "userTask", "title": "Позвонить клиенту", "config": {
      "assignee": { "role": "support" },
      "form": { "fields": [{ "code": "comment", "type": "string", "required": true }] },
      "dueIn": "P1D"
    } },
    "End": { "kind": "end", "title": "Готово" }
  },
  "flows": {
    "f1": { "source": "Start", "target": "Pay" },
    "f2": { "source": "Pay", "target": "Paid" },
    "f3": { "source": "Paid", "target": "End", "condition": { "path": "$vars.payment.status", "op": "eq", "value": "paid" } },
    "f4": { "source": "Paid", "target": "Call", "isDefault": true },
    "f5": { "source": "Call", "target": "End" }
  }
}
```

- **Данные экземпляра** читаются путями: `$input.amount` — вход,
  `$vars.payment` — переменная, которую записал `saveTo`,
  `$nodes.Pay.paymentId` — результат шага.
- **Условия** — без кода: `all`, `any`, `not` и сравнения `eq`, `ne`,
  `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `empty`, `notEmpty`. Из
  шлюза «Выбор по условию» идёт первый переход, чьё условие верно, иначе
  переход `isDefault`.
- **Поля входа и форм:** `string`, `text`, `number`, `integer`, `boolean`,
  `date`, `datetime`, `enum` (с `values`), `required`.

| Узел | Что делает | Работает |
| --- | --- | --- |
| `manualStart` | Запуск человеком или кодом | 0.124.0 |
| `serviceTask` | Вызывает инструмент | 0.124.0 |
| `userTask` | Ждёт, пока сотрудник выполнит задачу | 0.124.0 |
| `exclusiveGateway` | Выбор по условию | 0.124.0 |
| `parallelGateway` | Параллельные ветви и их слияние | 0.124.0 |
| `end` | Конец ветви | 0.124.0 |
| `retry` в `serviceTask` | Повторяет упавший вызов | 0.125.0 |
| `boundaryError` | Ветвь на случай ошибки шага | 0.125.0 |
| `timerCatch` | Ждёт время или дату | 0.125.0 |
| `boundaryTimer` | Срок шага: прерывает его или запускает ветвь рядом | 0.125.0 |
| `eventWait` | Ждёт событие | 0.126.0 |
| `boundaryEvent` | Событие во время шага: прерывает его или запускает ветвь рядом | 0.126.0 |
| `eventStart` | Запуск по событию | 0.126.0 |
| `scheduleStart` | Запуск по расписанию cron | 0.126.0 |

## Каталог и публикация

Процесс создаётся по ключу, документ сохраняется черновиком, а запускается
опубликованная версия. Версия не меняется: новая публикация не трогает уже
запущенные экземпляры.

```text
POST /workflow/processes  {"key":"order","title":"Заказ","retentionDays":90}
→ 201 {"key":"order","title":"Заказ","latestVersion":null,"retentionDays":90,"archived":false,
       "draft":{"schemaVersion":"bazis.workflow/v1","nodes":{"Start":…,"End":…},…},…}

PUT /workflow/processes/order/draft  {"document": {…документ выше…}}
→ 200 {"issues":[]}

POST /workflow/processes/order/publish
→ 201 {"id":"01a18f24-92c3-…","key":"order","version":1,"publishedBy":{"kind":"user","id":"anna"},"document":{…}}
```

- Черновик сохраняется и с ошибками: ответ перечисляет все замечания с
  узлом или переходом, чтобы дизайнер их подсветил. Опубликовать черновик с
  ошибкой нельзя — `422` с теми же замечаниями.
- Инструмент, которого нет или у которого в `callers` нет `workflow`, —
  ошибка `unknown_tool` на узле.
- Повторная публикация того же документа возвращает ту же версию, а не
  создаёт новую.
- `retentionDays` — сколько дней хранить завершённые и отменённые
  экземпляры; упавшие не удаляются никогда.

Для дизайнера есть `GET /workflow/tools`: инструменты, доступные процессам,
со схемами входа и выхода, по которым строится форма настройки шага.

```text
GET /workflow/tools
→ {"data":[{"name":"payments.charge","description":"Charges an order.",
            "input":{"kind":"json-schema","name":"ChargeInput","schema":{"type":"object",
              "properties":{"orderId":{"type":"string","minLength":1},"amount":{"type":"number","minimum":1}},
              "required":["amount","orderId"],"additionalProperties":false},"strict":true},
            "output":{…},"sideEffect":"write","approval":"required"}]}
```

## Запуск

```text
POST /workflow/instances
     {"processKey":"order","input":{"orderId":"42","amount":500},"partition":"shop-1","businessKey":"order:42"}
→ 201 {"id":"01a18f24-9309-…","processKey":"order","version":1,"partition":"shop-1","status":"running",
       "businessKey":"order:42","startedBy":{"kind":"user","id":"anna"},"input":{"amount":500,"orderId":"42"},
       "tokens":[…],…}
```

- `partition` — область приложения: магазин, пространство, организация.
  Модуль её не толкует, только хранит и фильтрует по ней, а `WorkflowAccess`
  получает её для проверки прав.
- `businessKey` — свой ключ того, о чём экземпляр: по нему ищут экземпляры
  заказа.
- Вход проверяется по полям документа:

  ```text
  POST /workflow/instances  {"processKey":"order","input":{"orderId":"42"}}
  → 422 {"error":"The process input is invalid","details":{"code":"invalid_input",
         "issues":[{"field":"amount","code":"required","message":"field amount is required"}]}}
  ```

Ответ приходит сразу: шаги с инструментами выполняет фоновый воркер, как
правило в течение секунды. Экземпляр можно запустить и из своего кода — через
`IWorkflowRuntime` ([Из кода](#из-кода)).

## Ошибка шага и повтор

Первый запуск в приложении без `approvalPolicy` упал на оплате:

```text
GET /workflow/instances/01a18f24-9309-…
→ {"status":"failed","error":{"code":"TOOL_APPROVAL_REQUIRED","node":"Pay",
     "message":"Tool \"payments.charge\" requires explicit approval."},…}
```

Инструмент с записью по умолчанию требует подтверждения, а политики не
было. Упавший экземпляр ждёт человека: после исправления (политика из
[Подключения](#подключение)) его повторяют:

```text
POST /workflow/instances/01a18f24-9309-…/retry
→ 200 {"status":"running",…}

GET /workflow/instances/01a18f24-9309-…
→ {"status":"completed","vars":{"payment":{"status":"paid","paymentId":"pay-42"}},"error":null,…}
```

История экземпляра показывает каждый шаг:

```text
GET /workflow/instances/01a18f24-9309-…/history
started   —     {"via":"manual"}                                              anna
entered   Start
left      Start {"flow":"f1"}
entered   Pay   {"flow":"f1"}
tool      Pay   {"tool":"payments.charge","status":"denied","error":{"code":"TOOL_APPROVAL_REQUIRED",…}}
error     Pay   {"code":"TOOL_APPROVAL_REQUIRED",…}
retried   Pay                                                                 anna
tool      Pay   {"tool":"payments.charge","status":"success","durationMs":9}
left      Pay   {"flow":"f2"}
entered   Paid  {"flow":"f2"}
left      Paid  {"flow":"f3"}
entered   End   {"flow":"f3"}
completed —
```

(Записи — `type`, `nodeId`, `data`, `actor.id` из ответа `{"data":[…]}`.)

Журнал вызовов инструмента получает того, кто вызвал, и того, от чьего
имени:

```text
audit attempt payments.charge caller=workflow actor=anna
charge 42: 500 -> paid
audit result payments.charge caller=workflow actor=anna
```

## Задача сотруднику

Заказ на 5000 не прошёл оплату, процесс ушёл в «Позвонить клиенту» и ждёт:

```text
status: running   vars: {"payment":{"status":"declined","paymentId":"pay-43"}}
Start done · Pay done · Paid done · Call waiting (token 01a18f25-f649-777c-…)
```

Модуль не ведёт список задач сам: он публикует событие, а приложение
показывает задачу исполнителю, как ему удобно.

```ts
import { OnEvent } from "bazis/core/kernel";
import { WORKFLOW_TASK_REQUESTED, type WorkflowTaskRequested } from "bazis/core/workflow";

export class TaskInbox {
  @OnEvent(WORKFLOW_TASK_REQUESTED)
  requested(task: WorkflowTaskRequested) {
    console.log(`task "${task.title}" for ${JSON.stringify(task.assignee)}, token ${task.tokenId}`);
  }
}

// AppModule: imports: [..., eventsModule({ subscribers: [TaskInbox] })]
```

```text
task "Позвонить клиенту" for {"role":"support"}, token 01a18f25-f649-777c-…
```

В событии — экземпляр, токен, узел, `partition`, название, исполнитель
(`{ role }` или `{ user }`), форма и срок `dueAt` из `dueIn` узла. События
уходят после того, как шаг записан в базу: обработчик никогда не увидит шаг,
который откатился.

Когда сотрудник заполнил форму, приложение передаёт её модулю:

```ts
@Controller("tasks")
export class TasksController {
  constructor(private readonly runtime: IWorkflowRuntime) {}

  @Post(":token/complete")
  complete(token: FromRoute<string>, body: FromBody<CompleteTaskRequest>, ctx: HttpContext) {
    return this.runtime.completeToken(token, body, currentActor(ctx));   // кто вошёл: ваша проверка входа
  }
}
```

```text
POST /tasks/01a18f25-f649-777c-…/complete  {}
→ 422 {"error":"The task form is invalid","details":{"code":"invalid_input",
       "issues":[{"field":"comment","code":"required","message":"field comment is required"}]}}

POST /tasks/01a18f25-f649-777c-…/complete  {"comment":"Клиент оплатит картой"}
→ 200 {"status":"completed","nodes":{…,"Call":{"comment":"Клиент оплатит картой"}},…}

POST /tasks/01a18f25-f649-777c-…/complete  {"comment":"x"}
→ 409 {"error":"The token does not wait for a task","details":{"code":"wrong_status"}}
```

Ответ формы попадает в `$nodes.Call` — следующие условия могут его
читать. Готовые HTTP задач и их таблица во фреймворке — в плане.

## Повторы, ошибки и таймеры

Процесс «Доставка» бронирует курьера, ждёт сборку заказа и, если слотов
нет, поручает логисту договориться вручную — но не дольше трёх секунд
(в жизни — суток), потом передаёт заказ менеджеру:

```json
"Book": { "kind": "serviceTask", "title": "Забронировать доставку", "config": {
  "tool": "delivery.book",
  "input": { "orderId": "$input.orderId", "city": "$input.city" },
  "saveTo": "delivery",
  "retry": { "maxAttempts": 3, "backoff": "PT1S" }
} },
"NoSlots": { "kind": "boundaryError", "title": "Нет слотов", "attachedTo": "Book", "config": { "errorCode": "no_slots" } },
"Pause": { "kind": "timerCatch", "title": "Ждём сборку", "config": { "duration": "PT2S" } },
"Arrange": { "kind": "userTask", "title": "Договориться о доставке", "config": { "assignee": { "role": "logistics" } } },
"Late": { "kind": "boundaryTimer", "title": "Не успели", "attachedTo": "Arrange", "config": { "duration": "PT3S" } },
"Escalate": { "kind": "serviceTask", "title": "Сообщить менеджеру", "config": {
  "tool": "notify.manager", "input": { "text": "Доставка не согласована" }
} }
```

Переходы: `Start → Book → Pause → Shipped`, `NoSlots → Arrange → Shipped`,
`Late → Escalate → Escalated`. У граничного узла нет входящих переходов:
он прикреплён к шагу через `attachedTo` и ведёт своим исходящим.

### Повторы

Служба доставки дважды не ответила, на третий раз бронь прошла:

```text
tool  Book  {"status":"error","attempt":1,"retryAt":"…:39:07.437Z","error":{"code":"TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN",…}}
tool  Book  {"status":"error","attempt":2,"retryAt":"…:39:09.508Z",…}
tool  Book  {"status":"success","attempt":3}
timer Pause {"firedAt":"…:39:11.630Z"}
```

- `maxAttempts` — сколько попыток всего, вместе с первой. Пауза перед
  следующей удваивается от `backoff` (по умолчанию 10 секунд), но не
  больше суток.
- Все попытки идут с одним ключом идемпотентности: инструмент с записью
  должен узнать повтор по `context.idempotencyKey`.
- Повторяются только непредвиденные сбои. Отказ подтверждения и ошибка с
  деловой причиной (ниже) не повторяются.

### Ошибка с причиной

Инструмент, который знает, почему не может выполнить операцию, сообщает
причину:

```ts
import { ToolError } from "bazis/core/agent";

if (input.city === "Тикси") throw new ToolError("Нет слотов доставки", { reason: "no_slots" });
```

Процесс не повторяет такой вызов, а отдаёт токен граничному узлу
`boundaryError` с подходящим `errorCode`:

```text
tool  Book {"status":"error","attempt":1,"error":{"code":"TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN","reason":"no_slots","message":"Нет слотов доставки"}}
error Book {"code":"TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN","reason":"no_slots","message":"Нет слотов доставки","boundary":"NoSlots"}

nodes: {"NoSlots":{"code":"TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN","reason":"no_slots","message":"Нет слотов доставки"},…}
```

- `errorCode` сравнивается с `reason`, а если причины нет — с кодом
  ошибки (`TOOL_TIMEOUT`, `TOOL_EXECUTION_FAILED`…). Граничный узел без
  `errorCode` ловит любую ошибку шага; узел с подходящим кодом важнее.
- Ошибка ложится в `$nodes.<граничный узел>` — её можно показать логисту
  или проверить условием.
- Без подходящего граничного узла экземпляр `failed`, как в
  [Ошибке шага](#ошибка-шага-и-повтор).
- В ответе агенту причина тоже приходит — в `error.details.reason`.

### Таймеры

`timerCatch` ждёт `duration` (ISO 8601 без месяцев и лет: `PT2S`, `P1D`,
`P1DT12H`) или дату из данных: `"at": "$input.deliverAt"`. Дата в прошлом
срабатывает сразу; неверная дата — экземпляр `failed` с `bad_timer`.

`boundaryTimer` следит за шагом, пока тот ждёт: задачей, вызовом
инструмента или другим таймером. У «Тикси» логист не успел за три
секунды:

```text
task "Договориться о доставке" for {"role":"logistics"}, token 01a18f65-59e0-…
manager: Доставка не согласована

tokens: Start done · Book done · NoSlots done · Arrange cancelled · Late done · Escalate done · Escalated done
history: timer Late {"firedAt":"…:39:09.571Z","interrupting":true}
```

- Прерывающий таймер (по умолчанию) закрывает шаг. Если это задача
  сотруднику, приходит `WORKFLOW_TOKEN_CLOSED` с `reason: "interrupted"` —
  задачу пора убрать из входящих.
- С `"interrupting": false` таймер один раз запускает свою ветвь —
  напоминание, письмо, — а шаг продолжает ждать. Экземпляр завершится,
  когда закончатся обе ветви.
- Шаг завершился раньше — его таймеры снимаются.

## События

Процесс ждёт событие извне — оплату, отмену, письмо — узлом `eventWait`.
Процесс «Ожидание оплаты» ждёт оплату своего заказа, а если клиент отменил
заказ раньше, уходит в `Dropped`:

```json
"WaitPay": { "kind": "eventWait", "title": "Ждём оплату", "config": {
  "event": "payments.received", "correlation": "$input.orderId", "saveTo": "payment"
} },
"Cancelled": { "kind": "boundaryEvent", "title": "Клиент отменил", "attachedTo": "WaitPay", "config": {
  "event": "orders.cancelled", "correlation": "$input.orderId"
} }
```

Событие приходит по HTTP — от платёжного шлюза, другого сервиса — или из
кода:

```text
POST /workflow/events/payments.received  {"payload":{"amount":500,"method":"card"},"correlation":"50"}
→ 202 {"started":[],"continued":["01a18f8a-07e2-…"],"rejected":[]}

POST /workflow/events/orders.cancelled   {"payload":{"by":"client"},"correlation":"51"}
→ 202 {"started":[],"continued":["01a18f8a-0835-…"],"rejected":[]}

POST /workflow/events/payments.received  {"payload":{"amount":1},"correlation":"999"}
→ 202 {"started":[],"continued":[],"rejected":[]}
```

```text
заказ 50: vars {"payment":{"amount":500,"method":"card"}}   Start done · WaitPay done · Cancelled cancelled · Book …
заказ 51: nodes {"Cancelled":{"by":"client"}}                 Start done · WaitPay cancelled · Cancelled done · Dropped done
```

- **Корреляция** — какое именно событие ждёт экземпляр. `correlation` узла
  — путь к значению в данных экземпляра (здесь номер заказа); событие с
  `"correlation":"50"` берёт только ожидания заказа 50. Ожидание без
  `correlation` берёт любое событие своего ключа.
- **Данные события** — результат шага: `$nodes.WaitPay` и переменная
  `saveTo`.
- `boundaryEvent` работает как [граничный таймер](#таймеры): по умолчанию
  прерывает шаг, с `"interrupting": false` запускает ветвь рядом.
- `partition` в запросе ограничивает ожидания своей областью.
- Право — `events.emit` в `WorkflowAccess`; без него `403`.

Из кода — тот же вызов. Удобно связать событие приложения с процессами:

```ts
export class PaymentsBridge {
  constructor(private readonly workflow: IWorkflowRuntime) {}

  @OnEvent(PAYMENT_RECEIVED)
  async received(payment: PaymentReceived) {
    await this.workflow.emit("payments.received", { amount: payment.amount }, { correlation: payment.orderId });
  }
}
```

### Запуск по событию

Узел `eventStart` запускает новый экземпляр на каждое событие своего ключа:

```json
"Start": { "kind": "eventStart", "title": "Клиент зарегистрировался", "config": { "event": "customers.registered" } }
```

```text
POST /workflow/events/customers.registered  {"payload":{"name":"Иван","phone":"+7900"},"partition":"shop-1"}
→ 202 {"started":["01a18f8a-08d7-…"],"continued":[],"rejected":[]}
manager: Иван

POST /workflow/events/customers.registered  {"payload":{"phone":"+7900"}}
→ 202 {"started":[],"continued":[],"rejected":[{"processKey":"welcome",
       "issues":[{"field":"name","code":"required","message":"field name is required"}]}]}
```

Данные события проверяются по `input` процесса; поля, которых там нет
(`phone`), отбрасываются. Экземпляр получает `partition` события,
`businessKey` — его корреляцию, а выполняется от имени того, кто прислал
событие, или `{"kind":"system","id":"event:customers.registered"}` при
вызове из кода без `actor`.

## Расписание

`scheduleStart` запускает процесс по cron — пять полей, время UTC:

```json
"Start": { "kind": "scheduleStart", "title": "Каждую минуту", "config": { "cron": "* * * * *" } }
```

```text
GET /workflow/instances?processKey=report
→ {"data":[{"status":"completed","startedVia":"schedule","startedBy":{"kind":"system","id":"schedule"},
            "createdAt":"2026-10-31T01:21:00.028Z",…}],"meta":{"total":1}}
manager: Отчёт за минуту
```

- Поля: минута, час, день месяца, месяц, день недели (0 и 7 — воскресенье);
  `*`, числа, диапазоны `9-17`, шаг `*/15`, списки `1,15`: `0 9 * * 1-5` —
  по будням в 9:00 UTC.
- Экземпляр стартует без входа, от имени `system` `schedule`.
- Воркер сверяет расписания с каталогом при старте и раз в минуту: новая
  версия или архивный процесс вступают в силу в течение минуты.
- Запуски, пропущенные, пока приложение не работало, не догоняются:
  следующий — по расписанию от текущего момента.
- На нескольких экземплярах приложения срабатывание одно.

## Отмена

```text
POST /workflow/instances/01a18f26-283b-…/cancel  {"reason":"Клиент передумал"}
→ 200 {"status":"cancelled","endedAt":"…",…}
```

Отмена закрывает все шаги экземпляра. Если он ждал сотрудника, приходит
`WORKFLOW_TOKEN_CLOSED` с `reason: "cancelled"` — задачу пора убрать из
входящих. Завершённый или
отменённый экземпляр — `WORKFLOW_INSTANCE_FINISHED`:

```text
instance 01a18f26-283b-77e3-85a2-642845bb66ac cancelled
```

Отменить можно работающий или упавший экземпляр; завершённый — `409`
`wrong_status`.

## Права: `WorkflowAccess`

HTTP модуля не знает, как приложение узнаёт пользователя. Он спрашивает
порт `WorkflowAccess`, который реализует приложение:

```ts
import type { HttpContext } from "bazis/core/http";
import { WorkflowAccess, type WorkflowAccessTarget, type WorkflowAction, type WorkflowActor } from "bazis/core/workflow";

export class AppWorkflowAccess extends WorkflowAccess {
  actor(ctx: HttpContext): WorkflowActor | undefined {
    const user = userOf(ctx);                         // ваша проверка входа, например JWT
    return user && { kind: "user", id: user.id };
  }

  can(ctx: HttpContext, action: WorkflowAction, target: WorkflowAccessTarget): boolean {
    const roles = userOf(ctx)?.roles ?? [];
    if (roles.includes("manager")) return true;
    return action === "instances.read" || action === "tasks.work";
  }

  override assignees(ctx: HttpContext, actor: WorkflowActor): readonly string[] {
    return [`user:${actor.id}`, ...(userOf(ctx)?.roles ?? []).map((role) => `role:${role}`)];
  }
}
```

```text
GET /workflow/processes                                 (без токена)  → 401
POST /workflow/processes            (Bearer t-oleg, роль support)    → 403 {"error":"Forbidden"}
POST /workflow/instances/…/cancel   (Bearer t-oleg)                  → 403 {"error":"Forbidden"}
```

| Действие | Где |
| --- | --- |
| `processes.read` | список и карточка процесса, версии, `/workflow/tools` |
| `processes.manage` | создание, изменение, черновик |
| `processes.publish` | публикация |
| `instances.start` | запуск |
| `instances.read` | список экземпляров, карточка, история |
| `instances.manage` | отмена, повтор |
| `events.emit` | `POST /workflow/events/:eventKey` |
| `tasks.work` | для задач — в плане |

`target` — то, что известно о цели: `processKey`, `partition`,
`instanceId`. Для карточки экземпляра это его `partition`, для списка — из
строки запроса: так приложение ограничивает пользователя его магазином.
Сервисы `IWorkflowDefinitions` и `IWorkflowRuntime` порт не спрашивают: их
вызывает ваш код, который сам решает, что можно.

## Из кода

Те же операции — в сервисах, они внедряются по типу:

```ts
import { IWorkflowRuntime } from "bazis/core/workflow";

export class OrdersService {
  constructor(private readonly workflow: IWorkflowRuntime) {}

  async place(order: Order, userId: string) {
    // …сохранили заказ
    await this.workflow.start("order", {
      input: { orderId: order.id, amount: order.amount },
      partition: order.shopId,
      businessKey: `order:${order.id}`,
      actor: { kind: "user", id: userId },
    });
  }
}
```

| Сервис | Методы |
| --- | --- |
| `IWorkflowDefinitions` | `list`, `get`, `create`, `update`, `saveDraft`, `publish`, `versions`, `version`, `latest`, `published`, `tools` |
| `IWorkflowRuntime` | `start`, `emit`, `cancel`, `retry`, `completeToken`, `instances`, `instance`, `history` |

Ошибки — `WorkflowError` с `code` и HTTP-статусом: `not_found` (404),
`conflict`, `wrong_status`, `archived` (409), `invalid_document`,
`invalid_input` (422, с `issues`). Контроллер может просто пробросить её.

## Несколько экземпляров приложения

Состояния в памяти нет: каждый шаг — одна транзакция с блокировкой строки
экземпляра, а задания воркер берёт через `FOR UPDATE SKIP LOCKED` с арендой
на 5 минут. Несколько экземпляров приложения не возьмут одно задание
дважды, а задание упавшего экземпляра через 5 минут возьмёт другой.
Задание, которое падает не в инструменте, а, например, из-за недоступной
базы, повторяется через минуту × номер попытки; после пятой шаг падает с
`job_failed` и ждёт [повтора](#ошибка-шага-и-повтор).

| Настройка | По умолчанию | Переменная |
| --- | --- | --- |
| `worker.enabled` | `true` | `BAZIS_WORKFLOW__WORKER__ENABLED` |
| `worker.intervalMs` | `1000` | `BAZIS_WORKFLOW__WORKER__INTERVALMS` |
| `worker.batchSize` | `10` | `BAZIS_WORKFLOW__WORKER__BATCHSIZE` |
| `retention.enabled` | `true` | `BAZIS_WORKFLOW__RETENTION__ENABLED` |
| `retention.intervalMs` | `3600000` | `BAZIS_WORKFLOW__RETENTION__INTERVALMS` |
| `retention.batchSize` | `500` | `BAZIS_WORKFLOW__RETENTION__BATCHSIZE` |

Воркер раз в `intervalMs` берёт до `batchSize` заданий; если пачка полная,
сразу берёт следующую. `BAZIS_WORKFLOW__WORKER__ENABLED=false` — экземпляр
только отвечает на HTTP, а шаги исполняют другие.

> [!NOTE]
> Модуль бизнес-процессов — с версии 0.124.0. До 0.124.1 приложение,
> запущенное с устаревшей кодогенерацией, не стартовало с сообщением
> `ProcessesController.list has parameters but no generated argument
> bindings` — обновитесь или выполните `bunx bazis codegen`.

## Дальше

- [Инструменты](../ai/tools.md) — как писать шаги
- [События](../fundamentals/events.md) — подписка на события модуля
- [Owned stores](../database/owned-stores.md) — как устроены таблицы модуля
- [API `bazis/core/workflow`](../reference/api/core-workflow.md)
