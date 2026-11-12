# `bazis/core/agent`

Агенты: инструменты, запуск, аудит и подтверждение, хуки, контракты для
своих адаптеров моделей. Список — по пакету 0.140.0.

## Для приложения

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Tool(options)` | Класс-инструмент: `name`, `description`, `callers`, `input`, `output`, `sideEffect`, `approval`, `timeoutMs`, `tags` | [Инструменты](../../ai/tools.md) |
| `ToolRunner` | Вызов инструментов без модели: `as(caller)` возвращает `BoundToolRunner`; внедряется по типу | [Вызов без модели](../../ai/tools.md#вызов-без-модели) |
| `BoundToolRunner` | Инструменты одного вызывающего: `listTools(tags?)`, `getTool`, `describe`, `run(name, input, options)` | [Вызов без модели](../../ai/tools.md#вызов-без-модели) |
| `TOOL_EXECUTION_OPTIONS` | Настройки исполнения инструментов для агентов и `ToolRunner`: подтверждение, журнал аудита, хуки, сроки, повторы | [Настройки](../../ai/agents.md#настройки-аудит-и-подтверждение) |
| `AgentRuntime` | Запуск агента: `run(definition, options)`, проверка определения `check(definition)`, `listTools()`; внедряется по типу | [Запуск](../../ai/agents.md#запуск) |
| `AGENT_RUNTIME_OPTIONS` | Настройки рантайма агента: пределы шагов и времени, сборка контекста | [Настройки](../../ai/agents.md#настройки-аудит-и-подтверждение) |
| `ToolError` | Ошибка, текст которой модель видит как есть | [Ошибки](../../ai/tools.md#ошибки) |
| `AgentToolPreCommitError` | Ошибка «запись не началась»: вызов можно повторить с ключом идемпотентности | [Повторы](../../ai/tools.md#повторы) |
| `AgentSetupError`, `AgentRuntimeError`, `AgentToolExecutionError`, `AgentSemanticError`, `AgentModelTimeoutError`, `AgentModelUnavailableError`, `AgentModelContextOverflowError` | Ошибки настройки и адаптеров | [Ошибки агентов](../errors/agents.md#классы-исключений) |
| `defineTool({ name, description, callers, inputSchema?, outputSchema?, sideEffect?, …, execute(input, context, services) })` | Инструмент без класса — для инструментов, которые делает функция. С версии 0.138.0 | [Инструменты, созданные функцией](../../ai/tools.md#инструменты-созданные-функцией) |
| `DefinedTool<Input, Output>`, `ToolSet<Names>`, `DefinedToolOptions` | Типы: инструмент `defineTool` (с `toolName`), набор «имя → инструмент», опции | там же |
| `isDefinedTool(value)`, `toolNameOf(tool)` | Сделан ли инструмент `defineTool`; имя класса с `@Tool` или инструмента `defineTool` | — |
| `describeTool(Tool)`, `toolMetadataOf(Tool)` | Контракт и метаданные инструмента | — |

## Для своих адаптеров моделей

Построители объектов, которыми рантайм обменивается с моделью, и токен
провайдера ([Свой адаптер](../../ai/llm-connectors.md#свой-адаптер)):

`AGENT_MODEL_PROVIDER`, `agentModelRequest`, `agentModelResponse`,
`agentModelCapabilities`, `agentMessage`, `agentMessageText`, `agentText`, `agentData`,
`agentFile`, `agentImage`, `agentReasoning`, `agentToolCall`, `agentToolCallPart`,
`agentToolResult`, `agentToolResultPart`, `agentToolContract`,
`agentOutputContract`, `agentJsonSchema`, `agentClassSchema`,
`agentInvocation`, `normalizeJsonValue`.

Сборка контекста: `DefaultAgentContextBuilder`,
`ApproximateAgentContextTokenEstimator`, `normalizeAgentContextLimits`,
`mergeAgentContextLimits`.

## Типы

- **Агент и запуск:** `AgentDataDefinition`, `AgentRuntimeOptions`, `AgentModelRetryPolicy`, `AgentCompactionOptions`,
  `AgentRuntimeInvokeOptions`, `AgentRuntimeResult`, `AgentRuntimeStatus`,
  `AgentRuntimeToolCallContext`, `AgentRuntimeToolExecutionOptions`,
  `AgentInvocation`, `AgentInvocationOptions`, `AgentUsage`,
  `AgentFinishReason`, `AgentStreamEvent`.
- **Инструменты:** `ToolOptions`, `ToolActor`, `ToolExecutionOptions`, `ToolRunOptions`, `ToolDefinition`, `ToolMetadata`,
  `ToolSideEffect`, `ToolApproval`, `ToolDryRun`, `AgentExecutableTool`,
  `AgentToolContract`, `AgentToolCall`, `AgentToolResult`,
  `AgentToolResultStatus`, `AgentToolError`, `AgentToolExecutionContext`,
  `AgentToolExecutionOptions`, `AgentToolExecutorOptions`,
  `AgentToolRetryPolicy`, `AgentToolRetryBackoff`,
  `AgentToolSchemaValidator`, `AgentToolValidationIssue`,
  `AgentToolValidationResult`.
- **Подтверждение и аудит:** `AgentToolApprovalPolicy`,
  `AgentToolApprovalPolicyObject`, `AgentToolApprovalFunction`,
  `AgentToolApprovalRequest`, `AgentToolApprovalDecision`,
  `AgentToolApprovalReason`, `AgentToolExecutionApproval`,
  `AgentToolAuditSink`, `AgentToolAuditSinkObject`, `AgentToolAuditFunction`,
  `AgentToolAuditEntry`, `AgentToolAuditPhase`, `AgentToolAuditFailureMode`,
  `AgentToolAuditToolInfo`, `AgentToolAuditHookProjectionV1`.
- **Хуки** ([Хуки](../../ai/hooks.md)): `AgentToolHookRegistrationV1`,
  `AgentToolHookRegistrationBaseV1`, `AgentToolHookKindV1`,
  `AgentToolHookRefV1`, `AgentToolRequiredHookRefV1`,
  `AgentToolHookContextV1`, `AgentToolEnforcementHookV1`,
  `AgentToolEnforcementDecisionV1`, `AgentToolSettlementHookV1`,
  `AgentToolSettlementEventV1`, `AgentToolSettlementResultV1`,
  `AgentToolObserverHookV1`, `AgentToolObserverEventV1`,
  `AgentToolBeforeEffectEventV1`, `AgentToolCallProjectionV1`,
  `AgentToolDescriptorProjectionV1`, `AgentToolTerminalProjectionV1`.
- **Модель и сообщения:** `AgentModelProvider`, `AgentModelProviderContext`,
  `AgentModelRequest`, `AgentModelResponse`, `AgentModelCapabilities`,
  `AgentMessage`, `AgentMessageOptions`, `AgentMessageRole`,
  `AgentContentInput`, `AgentContentPart`, `AgentTextPart`, `AgentDataPart`,
  `AgentFilePart`, `AgentImagePart`, `AgentReasoningPart`, `AgentToolCallPart`,
  `AgentToolResultPart`, `AgentOutputContract`, `AgentOutputMode`,
  `AgentSchemaContract`, `AgentJsonSchemaContract`,
  `AgentClassSchemaContract`.
- **Контекст:** `AgentContext`, `AgentContextBuilder`,
  `AgentContextBuildInput`, `AgentContextLimits`,
  `AgentContextTokenEstimator`, `AgentContextTraceEntry`,
  `DefaultAgentContextBuilderOptions`.
- **JSON:** `JsonValue`, `JsonObject`, `JsonPrimitive`.
