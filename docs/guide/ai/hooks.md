# Хуки инструментов и аудит

Хуки — правила, которые срабатывают вокруг **каждого** вызова инструмента
в приложении, какой бы агент его ни сделал. Они нужны для того, что нельзя
доверить ни модели, ни отдельному инструменту: бизнес-лимиты, учёт
действий, метрики. Аудит — журнал вызовов: кто, что, с какими аргументами
и чем закончилось.

Все примеры проверены на bazis 0.99.4. Модель в проверках — скрипт с
заданными шагами.

## Три вида хуков

| Вид | Когда | Что может | Если упал |
| --- | --- | --- | --- |
| `enforcement` | Перед вызовом | Разрешить или запретить вызов | Вызов не выполняется |
| `settlement` | После вызова, при любом исходе | Записать исход: в учёт, в книгу операций | У чтения — ошибка; у записи — исход неизвестен, запуск остановлен |
| `observer` | После `settlement` | Наблюдать: метрики, уведомления | Ничего: результат не меняется |

Хуки объявляются полем `agentToolHooks` модуля. Хук — класс: он получает
сервисы своего модуля через конструктор и создаётся заново на каждый вызов.

```ts
@Module({
  providers: [singleton(OrdersService), singleton(CancellationLedger)],
  tools: [FindOrderTool, CancelOrderTool],
  agentToolHooks: [
    { kind: "enforcement", id: "orders.limit", version: 1, handler: OrderLimitHook },
    { kind: "settlement", id: "orders.ledger", version: 1, handler: CancellationSettlement },
    { kind: "observer", id: "tool.metrics", version: 1, handler: ToolMetrics },
  ],
})
export class OrdersModule {}
```

| Поле | Что задаёт |
| --- | --- |
| `kind` | `enforcement`, `settlement` или `observer` |
| `id`, `version` | Имя хука в журнале и в обязательных хуках, см. ниже |
| `handler` | Класс хука |
| `order` | Порядок среди хуков одного вида, по возрастанию (по умолчанию 0) |
| `timeoutMs` | Срок хука, по умолчанию 5 секунд |

Хук срабатывает на все инструменты приложения, а не только своего модуля.
Нужный инструмент он выбирает сам по `event.tool.name`.

## `enforcement`: разрешить или запретить

```ts
import type { AgentToolBeforeEffectEventV1, AgentToolEnforcementDecisionV1, AgentToolEnforcementHookV1 } from "bazis/core/agent";

/** Дорогие заказы отменяет менеджер, а не агент. */
export class OrderLimitHook implements AgentToolEnforcementHookV1 {
  constructor(private readonly orders: OrdersService) {}

  enforce(event: AgentToolBeforeEffectEventV1): AgentToolEnforcementDecisionV1 {
    if (event.tool.name !== "orders.cancel") return { decision: "allow" };
    const id = (event.call.input as { id?: number }).id ?? 0;
    const order = this.orders.find(id);
    if (order && order.total > 1000) {
      return {
        decision: "deny",
        reasonCode: "ORDER_LIMIT",
        message: "Заказы дороже 1000 отменяет менеджер",
        evidence: { orderId: id, total: order.total },
      };
    }
    return { decision: "allow", evidence: { orderId: id } };
  }
}
```

```text
агент operator: отменить заказ 42 (1500)
→ модели: {"code":"TOOL_HOOK_DENIED","message":"Заказы дороже 1000 отменяет менеджер",
           "details":{"reasonCode":"ORDER_LIMIT"}}

агент operator: отменить заказ 7 (300)
→ success
```

| Поле решения | Кому |
| --- | --- |
| `decision` | `allow` или `deny` |
| `message` | Модели — как есть, чтобы агент объяснил отказ; и в журнал |
| `reasonCode` | Модели в `details` и в журнал — код для ветвления |
| `evidence` | Только в журнал: на чём основано решение |

Без `message` модель получит общее
`Tool execution was denied by an enforcement hook.`.

Хук видит вызов (`event.call`: имя, аргументы, `metadata` запуска),
описание инструмента (`event.tool`), агента, номер попытки и ключ
идемпотентности. Секреты в аргументах уже замаскированы.

`enforcement` срабатывает после [проверки аргументов и политики
подтверждения](agents.md#настройки-аудит-и-подтверждение) — до
`execute`, на каждую попытку, если включены [повторы](tools.md#повторы).
Хуки одного вида идут по порядку; первый `deny` останавливает вызов.

> [!NOTE]
> `message` и `reasonCode` доходят до модели с версии 0.99.3. Раньше
> модель видела только общий отказ.

## `settlement`: записать исход

```ts
import type { AgentToolSettlementEventV1, AgentToolSettlementHookV1 } from "bazis/core/agent";

export class CancellationSettlement implements AgentToolSettlementHookV1 {
  constructor(private readonly ledger: CancellationLedger) {}

  settle(event: AgentToolSettlementEventV1) {
    if (event.toolName === "orders.cancel") {
      this.ledger.add(`${event.agentName} ${event.terminal.status} known=${event.terminal.outcomeKnown}`);
    }
    return { status: "recorded" as const };
  }
}
```

```text
учёт: ["operator denied known=true", "operator success known=true"]
```

`settlement` срабатывает при любом исходе: успех, ошибка, отказ, срок.
`event.terminal` говорит, чем кончилось:

| Поле | Что в нём |
| --- | --- |
| `status` | `success`, `error` или `denied` |
| `executeStarted` | Успел ли начаться `execute` |
| `outcomeKnown` | Известно ли, что изменилось; `false` — запись прервалась посередине |
| `errorCode`, `output` | Код ошибки или результат |

Хук обязан вернуть `{ status: "recorded" }` — подтверждение, что исход
записан. Если он упал, у инструмента с записью исход становится
неизвестным, и запуск останавливается:

```text
settlement упал у инструмента pay.charge (sideEffect: "external")
→ инструмент: TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN
→ запуск:     failed, AGENT_TOOL_OUTCOME_UNKNOWN
→ журнал:     error: Agent tool hook failed {"hook":"settlement:ledger@1","outcome":"failed",
                "agent":"cashier","tool":"pay.charge","callId":"c1",
                "error":{"name":"Error","message":"ledger db down","stack":"…"}}
```

## `observer`: наблюдать

```ts
import type { AgentToolObserverEventV1, AgentToolObserverHookV1 } from "bazis/core/agent";

export class ToolMetrics implements AgentToolObserverHookV1 {
  constructor(private readonly metrics: Metrics) {}

  observe(event: AgentToolObserverEventV1): void {
    this.metrics.increment(`${event.settlement.toolName}:${event.settlement.terminal.status}`);
  }
}
```

```text
метрики: {"orders.cancel:denied":1,"orders.cancel:success":1,"orders.find:success":1}
```

Наблюдатель получает то же событие, что `settlement`. Его сбой результат
не меняет — вызов уже завершён, — но попадает в журнал приложения:

```text
error: Agent tool hook failed {"hook":"observer:tool.metrics@1","outcome":"failed",
  "agent":"operator","tool":"orders.find","callId":"c1","error":{"message":"metrics backend down",…}}
```

> [!NOTE]
> Запись сбоев хуков в журнал приложения — с версии 0.99.3. Раньше ошибка
> хука терялась.

## Аудит

Журнал вызовов задаётся в [настройках рантайма](agents.md#настройки-аудит-и-подтверждение)
функцией `auditSink`. Хуки `enforcement` и `settlement` без журнала не
работают — их решения должны оставлять след. Приложение с такими хуками и
без `auditSink` не запустится:

```text
[bazis] configuration error: AgentRuntime: Agent Tool enforcement and settlement hooks require constructor auditSink.
```

На один вызов приходит несколько записей — по этапам:

```text
attempt      orders.cancel
enforcement  orders.cancel  {"id":"orders.limit","outcome":"denied","reasonCode":"ORDER_LIMIT",
                             "message":"Заказы дороже 1000 отменяет менеджер","evidence":{"orderId":42,"total":1500}}
settlement   orders.cancel  {"id":"orders.ledger","outcome":"recorded"}
result       orders.cancel  denied
observer     orders.cancel  {"id":"tool.metrics","outcome":"recorded"}
```

| Поле записи | Что в нём |
| --- | --- |
| `phase` | `attempt`, `enforcement`, `result`, `settlement`, `observer` |
| `toolName`, `callId` | Инструмент и вызов |
| `agentName`, `invocationId` | Агент и запуск |
| `input` | Аргументы, секреты замаскированы |
| `result` | Результат вызова — в записи `result` |
| `hook` | Решение хука: `id`, `outcome`, `reasonCode`, `message`, `evidence` |
| `attempt`, `idempotencyKey` | Попытка и ключ вызова |
| `startedAtUnixMs`, `durationMs` | Время |

### Маскировка

По умолчанию в аргументах, результате и `metadata` маскируются значения
ключей вроде `password`, `secret`, `token`, `apiKey`, `authorization`,
`cookie`. Номер карты под ключом `card` к ним не относится — добавьте свои
ключи:

```ts
toolExecutorOptions: {
  auditSink: (entry) => audit.write(entry),
  auditRedaction: { sensitiveKeys: ["card"] },
}
```

```text
без настройки:  {"amount":10,"card":"4111111111111111","token":"***"}
с настройкой:   {"amount":10,"card":"***","token":"***"}
```

Хуки видят аргументы с той же маскировкой; свои ключи для них —
`hookRedaction: { sensitiveKeys: [...] }`.

### Если журнал недоступен

| `auditFailureMode` | Что будет с вызовом |
| --- | --- |
| `"fail-closed"` — по умолчанию | Не выполняется: `TOOL_AUDIT_FAILED`, модели — `Tool audit failed.` |
| `"best-effort"` | Выполняется, запись теряется |

В обоих режимах отказ журнала попадает в журнал приложения:

```text
error: Agent tool audit failed {"phase":"attempt","mode":"best-effort","agent":"cashier",
  "tool":"pay.charge","callId":"c1","error":{"message":"audit db down",…}}
```

Решения хуков `enforcement` и `settlement` записываются всегда, даже в
режиме `best-effort`: если их не удалось записать, вызов не выполняется
(`TOOL_HOOK_AUDIT_FAILED`).

> [!NOTE]
> С версии 0.99.4. Раньше модель получала текст ошибки журнала, а в режиме
> `best-effort` потеря записи не была видна нигде.

## Обязательные хуки

Хук легко потерять: модуль убрали из `imports`, переименовали `id`. Если
хук обязателен — например, проверка требований регулятора, — перечислите
его в `requiredPlatformHooks`:

```ts
toolExecutorOptions: {
  auditSink: (entry) => audit.write(entry),
  requiredPlatformHooks: [{ owner: ComplianceModule, kind: "enforcement", id: "compliance", version: 1 }],
}
```

Хук ищется точно: модуль-владелец, вид, `id` и `version`. Если его нет,
приложение не запустится:

```text
Required Agent Tool hook "enforcement:compliance@1" is not contributed by its exact owner.
```

Обязательные хуки срабатывают раньше остальных и помечены в журнале
`"tier":"platform"`, прочие — `"tier":"application"`.

## Дальше

- [Агенты](agents.md)
- [Инструменты](tools.md)
- [Логирование](../fundamentals/logging.md)
