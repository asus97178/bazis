# Ошибки агентов

Агент не бросает исключение, когда что-то пошло не так во время запуска.
Ошибка приходит **кодом** в результате:

```text
result.status        → "failed"
result.error.code    → "AGENT_MAX_STEPS_EXCEEDED"
result.toolResults[] → { name, status: "error" | "denied", error: { code: "TOOL_TIMEOUT", message } }
```

- Код инструмента (`TOOL_*`) видит и модель — как ответ инструмента — и
  может решить, что делать дальше. Текст для модели короткий, без
  подробностей; полная ошибка со стеком — в журнале.
- Код запуска (`AGENT_*`) — итог всего запуска.
- Исключения бросаются только при неверной настройке: см.
  [Классы исключений](#классы-исключений).

Коды и тексты — из исходников 0.100.8; примеры, проверенные запуском, — в
главах [Агенты](../../ai/agents.md), [Инструменты](../../ai/tools.md) и
[Хуки](../../ai/hooks.md).

## Коды запуска

| Код | Текст | Когда |
| --- | --- | --- |
| `AGENT_NOT_REGISTERED` | `Agent "support" is not registered.` | Имени агента нет ни в одном модуле |
| `AGENT_INPUT_INVALID` | текст ошибки | Вход запуска неверный |
| `AGENT_RUNTIME_OPTIONS_INVALID` | текст ошибки | Неверные параметры запуска или `AGENT_RUNTIME_OPTIONS` |
| `AGENT_TOOL_OPTIONS_INVALID` | текст ошибки | Неверные настройки инструментов агента |
| `AGENT_CONTEXT_INVALID` | текст ошибки | Неверные метаданные или контекст вызова |
| `AGENT_MAX_STEPS_EXCEEDED` | `Agent "support" exceeded maxSteps (8).` | Модель не закончила за `maxSteps` шагов ([Пределы](../../ai/agents.md#пределы)) |
| `AGENT_TOOL_CALL_LIMIT_EXCEEDED` | `Model requested 12 tool calls; the per-step limit is 8.` | Модель запросила за шаг больше вызовов, чем разрешено |
| `AGENT_PROVIDER_FAILED` | — | Провайдер ответил ошибкой; в журнале — `Agent model call failed` |
| `AGENT_PROVIDER_TIMEOUT` | — | Провайдер не ответил в срок коннектора или рантайма |
| `AGENT_PROVIDER_STOPPED` | `Model provider stopped with finishReason "length".` | Модель остановилась не по своей воле: лимит токенов, фильтр |
| `AGENT_PROVIDER_RESPONSE_INVALID` | `Model provider returned a response for another invocation.` | Адаптер провайдера вернул неверный ответ (повтор id вызова, чужой запуск) |
| `AGENT_ABORTED` | — | Запуск отменён через `signal` |
| `AGENT_OUTPUT_INVALID` | `Agent output failed JSON Schema validation.` | Структурированный ответ не прошёл схему ([Структурированный ответ](../../ai/agents.md#структурированный-ответ)) |
| `AGENT_OUTPUT_SCHEMA_UNAVAILABLE` | `Output class "Triage" has no generated JSON schema.` | Для класса ответа нет схемы — запустите `bazis codegen` |
| `AGENT_TOOL_OUTCOME_UNKNOWN` | `Tool "orders.cancel" finished with an unknown retry-safe side-effect outcome; automatic model continuation is blocked.` | Инструмент с записью завершился с неизвестным исходом; агент останавливается, чтобы модель не повторила запись |
| `AGENT_EXECUTION_STATE_INVALID` | `Agent execution checkpoint is invalid.` | Внутренняя: повреждено состояние запуска |

Ошибки провайдера подробно — в главе
[LLM-коннекторы](../../ai/llm-connectors.md#ошибки).

## Коды инструментов

### Вызов и доступ

| Код | Текст | Когда |
| --- | --- | --- |
| `TOOL_NOT_REGISTERED` | `Tool "orders.find" is not registered.` | Модель назвала инструмент, которого нет |
| `TOOL_NOT_VISIBLE_TO_AGENT` | `Tool "orders.cancel" is not visible to agent "support".` | Инструмент есть, но не в списке агента |
| `TOOL_CALL_INVALID` | `Tool call is invalid.` | Неверная форма вызова от модели |
| `TOOL_AGENT_REQUIRED` | `Tool "orders.find" execution requires agentName.` | Инструмент вызван вне агента без `agentName` |
| `TOOL_METHOD_MISSING` | `Tool "orders.find" must expose execute(input, context).` | В классе инструмента нет `execute` |
| `TOOL_RESOLVE_FAILED` | `Tool could not be created.` | Не удалось создать инструмент из DI |

### Проверка входа и выхода

| Код | Текст | Когда |
| --- | --- | --- |
| `TOOL_INPUT_VALIDATION_FAILED` | `Tool "orders.find" input failed schema validation.` | Аргументы модели не прошли схему; подробности — в `details` |
| `TOOL_INPUT_INVALID` | текст ошибки | Аргументы не удалось разобрать |
| `TOOL_OUTPUT_VALIDATION_FAILED` | `Tool "orders.find" output failed schema validation.` | Результат инструмента не прошёл схему выхода |
| `TOOL_OUTPUT_INVALID` | `Tool output processing failed.` | Результат не удалось обработать |
| `TOOL_RESULT_INVALID` | `Tool result is invalid.` | `execute` вернул то, что нельзя передать модели |
| `TOOL_SCHEMA_VALIDATION_FAILED` | `Tool input schema validation failed.` | Сама схема не проверяется |
| `TOOL_SCHEMA_VALIDATOR_MISSING` | `Tool "orders.find" declares schema classes but no schema validator is configured.` | Нет валидатора схем в настройках рантайма |

### Подтверждение и аудит

| Код | Текст | Когда |
| --- | --- | --- |
| `TOOL_AUDIT_REQUIRED` | `Tool "orders.cancel" has side effects and requires an audit sink.` | Инструмент с записью без `auditSink` в `AGENT_RUNTIME_OPTIONS` ([Настройки](../../ai/agents.md#настройки-аудит-и-подтверждение)) |
| `TOOL_APPROVAL_REQUIRED` | `Tool "orders.cancel" requires explicit approval.` | Инструмент объявлен с `approval: "required"`, а политики подтверждения нет |
| `TOOL_APPROVAL_POLICY_MISSING` | `Tool "orders.cancel" requires an approval policy.` | `approval: "policy"` у инструмента с записью, а политики нет. Инструменты только для чтения без политики выполняются |
| `TOOL_APPROVAL_DENIED` | `Tool execution was denied by approval policy.` | Политика отказала; `status: "denied"` |
| `TOOL_APPROVAL_FAILED` | `Tool approval policy failed: …` | Политика подтверждения упала |
| `TOOL_AUDIT_FAILED` | `Tool audit failed.` | Журнал аудита не принял запись; инструмент не выполняется ([Если журнал недоступен](../../ai/hooks.md#если-журнал-недоступен)) |

### Выполнение

| Код | Текст | Когда |
| --- | --- | --- |
| `TOOL_EXECUTION_FAILED` | `Tool execution failed.` | `execute` бросил исключение. Модель видит только этот текст; `ToolError` передаёт модели свой текст ([Ошибки инструмента](../../ai/tools.md#ошибки)) |
| `TOOL_TIMEOUT` | `Tool execution timed out during approval.` | Не уложился в срок, а записи не было: инструмент только читает или срок вышел до неё |
| `TOOL_ABORTED` | `Tool execution was aborted during approval.` | Отменён через `signal`, записи не было |
| `TOOL_EXECUTION_OPTIONS_INVALID` | текст ошибки | Неверные параметры выполнения |
| `TOOL_RETRY_IDEMPOTENCY_REQUIRED` | `Tool "orders.cancel" has "write" side effects and requires idempotencyKey when retryPolicy.maxAttempts is greater than 1.` | Повторы записи без ключа идемпотентности ([Повторы](../../ai/tools.md#повторы)) |
| `TOOL_RETRY_POLICY_INVALID` | `Tool retry policy produced no execution attempts.` | Политика повторов не дала ни одной попытки |
| `TOOL_SCOPE_DISPOSE_FAILED` | — | Не закрылась DI-область инструмента |

### Исход неизвестен

Коды с `_OUTCOME_UNKNOWN`: инструмент с записью мог успеть выполнить
запись, но подтвердить это нельзя. Такой вызов **не повторяется
автоматически**, а запуск агента останавливается с
`AGENT_TOOL_OUTCOME_UNKNOWN`. Проверьте состояние данных, прежде чем
повторять.

| Код | Когда |
| --- | --- |
| `TOOL_TIMEOUT_OUTCOME_UNKNOWN` | Срок вышел во время записи ([Срок и отмена](../../ai/tools.md#срок-и-отмена)) |
| `TOOL_ABORTED_OUTCOME_UNKNOWN` | Отмена во время записи |
| `TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN` | `Tool "orders.cancel" threw after side-effect execution started; retry safety is unknown.` |
| `TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN` | Запись прошла, упала обработка после неё |
| `TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN` | Аудит не записался после записи с неизвестным исходом |
| `TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN` | Запись прошла, не закрылась DI-область |

### Хуки

Коды [хуков](../../ai/hooks.md) `enforcement` и `settlement`:

| Код | Текст |
| --- | --- |
| `TOOL_HOOK_DENIED` | `Tool execution was denied by an enforcement hook.` или текст хука; `status: "denied"` |
| `TOOL_HOOK_FAILED` | `Agent Tool enforcement hook failed.` |
| `TOOL_HOOK_TIMEOUT` | `Agent Tool enforcement deadline elapsed.` |
| `TOOL_HOOK_CANCELLED` | `Agent Tool enforcement hook was cancelled.` |
| `TOOL_HOOK_UNAVAILABLE` | `Agent Tool enforcement handler was unavailable.` |
| `TOOL_HOOK_DECISION_INVALID` | Хук вернул не `allow`/`deny` |
| `TOOL_HOOK_AUDIT_FAILED` | `Agent Tool terminal audit could not be recorded.` |
| `TOOL_HOOK_REDACTION_FAILED` | `Agent Tool hook projection could not be safely prepared.` |
| `TOOL_HOOK_SETTLEMENT_FAILED` | `Agent Tool settlement deadline elapsed.` / `Agent Tool settlement handler was unavailable.` |
| `TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN` | `Agent Tool settlement outcome is unknown.` |
| `TOOL_SETTLEMENT_FAILED` | Текст ошибки хука `settlement` |

Сбой хука `enforcement` не пропускает проверку: инструмент не
выполняется.

## Сессии

`AgentSessionError` — ошибки сохранённых сессий агента (контрольных точек
диалога):

| Код | Когда |
| --- | --- |
| `AGENT_SESSION_CHECKPOINT_UNAVAILABLE` | Нет ключа для шифрования контрольной точки или он настроен неверно |
| `AGENT_SESSION_CHECKPOINT_CORRUPT` | Сохранённая точка не читается или повреждена |
| `AGENT_SESSION_INVALID_REQUEST` | Неверный запрос к хранилищу сессий |
| `AGENT_SESSION_LIMIT_EXCEEDED` | Сессия больше допустимого размера |

## Классы исключений

Исключения бросаются при неверной настройке, а не во время запуска:

| Класс | Когда |
| --- | --- |
| `AgentSetupError` | Неверное объявление агента или инструмента — при запуске или в `agents.check()` для определения из базы ([Агенты в базе](../../ai/agents.md#агенты-в-базе)) |
| `AgentRuntimeError` | Неверная настройка рантайма агентов |
| `AgentToolExecutionError` | Неверная настройка исполнителя инструментов |
| `AgentSemanticError` | Неверные данные сообщения, вызова или ответа модели, например `temperature must be a number between 0 and 2.` |
| `AgentModelTimeoutError` | Адаптер провайдера бросает её, когда вышел его срок; запуск сообщает `AGENT_PROVIDER_TIMEOUT` |

Свои ошибки инструмента:

- `ToolError` — текст попадает модели как есть: `throw new
  ToolError("Order 7 is already shipped")`.
- `AgentToolPreCommitError` — то же, но говорит, что запись ещё не
  началась: такой вызов остаётся доступен для повтора с ключом
  идемпотентности.

## Модели и Codex

- Ошибки LLM-коннекторов (`OpenAiCompatibleProviderError`,
  `LlmModelRouterError`) — в главе
  [LLM-коннекторы](../../ai/llm-connectors.md#ошибки).
- `CodexError` — ошибки подключения ChatGPT через Codex App Server. Поле
  `code`, текст рассчитан на показ пользователю:

| Код | Текст |
| --- | --- |
| `NOT_CONFIGURED` | `The ChatGPT connection is not configured on the server.` |
| `UNAVAILABLE` | `Codex App Server is unavailable. Check its installation and settings.` |
| `SIGN_IN_REQUIRED` | `An administrator needs to connect a ChatGPT account.` |
| `BUSY` | `Wait until the current replies or the ChatGPT sign-in finish.` |
| `MODEL_UNAVAILABLE` | `The selected model is not available in the connected ChatGPT account.` |
| `REASONING_UNAVAILABLE` | `The selected reasoning level is not available for this model.` |
| `PROTOCOL_ERROR` | `Codex App Server returned an incompatible response.` |
| `RESPONSE_FAILED` | `ChatGPT did not finish the reply. Check the connection and the account limits.` |
| `TIMEOUT` | `Codex App Server timed out.` |
| `LOGIN_FAILED` | `ChatGPT sign-in failed. Try again; use device-code sign-in if needed.` |
| `LOGIN_EXPIRED` | `The sign-in window expired. Start signing in again.` |

Русские тексты — `CodexError.useMessages(RU_CODEX_MESSAGES)` при запуске;
опция `language` приложения их не переключает.

## Дальше

- [Агенты](../../ai/agents.md)
- [Инструменты](../../ai/tools.md)
- [Хуки](../../ai/hooks.md)
