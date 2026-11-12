# bazis Agent

`core/agent` runs meta-agents. An agent is data — a name, instructions and
the names of the Tools it may call — so it can live in a database, be edited
by an operator and change without a deploy. Tools are code: classes with
`@Tool`, registered in `@Module.tools` and executed through bazis DI with
approval, audit, retries and deadlines.

- `@Tool` and `@Module.tools` — what agents may do
- `AgentRuntime` — runs an agent definition; injected by type
- `AGENT_RUNTIME_OPTIONS` — optional runtime settings
- `agentToolHooks` — enforcement, settlement and observer hooks around Tools
- provider-neutral semantic model (`agentMessage`, `agentToolCall`,
  `agentModelRequest`, `agentModelResponse`, `agentOutputContract`)
- context assembly via `DefaultAgentContextBuilder`

Model providers live behind infra connectors (`llmConnect`, `llmRouter`); they
also register `AgentRuntime`.

```ts
import { Module, Tool, scoped, type AgentToolExecutionContext } from "bazis";

class FindOrderInput {
  @Validator({ required: true, min: 1 }) id!: number;
}

@Tool({ name: "orders.find", description: "Finds an order by id.", input: FindOrderInput, sideEffect: "read" })
export class FindOrderTool {
  constructor(private readonly orders: IOrdersService) {}

  execute(input: FindOrderInput, context: AgentToolExecutionContext) {
    return this.orders.find(input.id);
  }
}

@Module({ tools: [FindOrderTool], providers: [scoped(OrdersService)] })
export class OrdersModule {}
```

```ts
import { AgentRuntime, type AgentDataDefinition } from "bazis/core/agent";

export class SupportService {
  constructor(private readonly agents: AgentRuntime) {}

  answer(question: string) {
    const support: AgentDataDefinition = {
      name: "support",
      instructions: "Answer questions about orders. Use tools for data.",
      toolNames: ["orders.find"],
      modelProfile: "fast",
    };
    return this.agents.run(support, { input: question });
  }
}
```

`run` checks the definition before the model is called: a malformed field or a
tool name that is not registered in `@Module.tools` rejects with
`AgentSetupError` that lists the registered names. The model sees only the
Tools the definition names. `runtime.listTools()` returns the whole catalog,
for example for an agent editor, and `runtime.check(definition)` runs the same
check without the model — call it before saving a definition an operator edited.

The definition's `instructions` are the system message, sent as written.
`description` is for people and catalogs and is not sent to the model.

Structured output is requested per run:

```ts
const result = await this.agents.run(analyst, {
  input: { feature: "Checkout with a promo code" },
  output: agentOutputContract({ mode: "json", schema: agentClassSchema("RequirementsDocument") }),
});
result.output; // validated JSON
```

A class schema comes from codegen (the class must be reachable for OpenAPI or
be a Tool contract); `agentJsonSchema(name, schema)` takes a JSON Schema
directly.

Runtime settings (limits, context builder) and Tool execution settings
(approval policy, audit sink, retries) are registered once; the Tool settings
are shared by agents and `ToolRunner`:

```ts
@Module({
  providers: [
    singletonValue(AGENT_RUNTIME_OPTIONS, { maxSteps: 6 }),
    singletonValue(TOOL_EXECUTION_OPTIONS, {
      approvalPolicy: (request) => request.tool.metadata.sideEffect === "read",
      auditSink: (entry) => auditStore.write(entry),
    }),
  ],
})
export class AgentSettingsModule {}
```

Tool input and output are validated by the model validator
(`modelValidatorAdapter`) unless `TOOL_EXECUTION_OPTIONS.schemaValidator` says
otherwise. Audit entries redact `input`, `result` and execution `metadata`
by default using `bazis/library/redaction`.

A tool reports a failure to the model with `throw new ToolError("Product
kiwi is no longer sold")`: the message reaches the model as written. Any other
exception from `execute` reaches the model as `Tool execution failed.` — internal
details stay out of the LLM — and goes to the application log with its stack
(`Agent tool failed`). Failures of the model itself are logged as `Agent model
call failed`. The LLM connectors pass the application logger; a runtime created
by hand takes `options.logger`.

An enforcement hook that denies a call explains why with `message` — it reaches
the model as written, with `reasonCode` in `error.details`, and both go to the
audit. A hook that throws, times out or returns an invalid answer is logged as
`Agent tool hook failed` with the error. `llmConnect` and `llmRouter` build
`AgentRuntime` at start, so wrong runtime options or enforcement hooks without
an audit sink stop the application with a configuration error.

An audit sink that fails is logged as `Agent tool audit failed` with the
phase and mode, in `best-effort` too, where the call goes on; the model sees
only `Tool audit failed.`.

Retries are opt-in. `write` and `external` tools need an idempotency key before
the executor repeats them. Runtime-generated keys include both the invocation id
and the unique model call id; `toolExecution.idempotencyKeyForCall` gives a
domain-specific stable key. When execution settles after a timeout or abort,
audit sinks receive a terminal `settlement` entry; an unknown write outcome stops
the run.

Every tool call has one 30-second deadline covering input validation, approval,
audit, DI resolution, execution, output processing and result audit. Model
provider calls default to 60 seconds. `timeoutMs: 0` disables either deadline.

Context limits keep long conversations within the model's window:

```ts
await this.agents.run(support, {
  messages: history,
  contextLimits: { maxMessages: 12, maxTokens: 4_000 },
});
```

`DefaultAgentContextBuilder` preserves the system prompt and the newest
conversation message when trimming old history. Provider requests include
`metadata.agentContext.trace` so context assembly is inspectable.

The runtime recovers before it fails a run. A model request the provider
cannot serve right now (`AgentModelUnavailableError`: HTTP 429, 5xx, a broken
connection) is repeated, three attempts by default (`modelRetry`). A text
answer cut by the output limit is continued (`maxOutputContinuations`, 3), a
structured answer that is not valid is sent back to the model with the issues
(`maxOutputRepairs`, 2); the finished dialog keeps one answer. Tool arguments
the provider could not read (`AgentToolCall.inputError`) give the model
`TOOL_ARGUMENTS_INVALID` instead of failing the run. Tools of one step that
change nothing (`none`, `read`) and stand next to each other run together
(`maxParallelToolCalls`, 8); `write` and `external` run one by one.
`runTimeoutMs` bounds a whole run (`AGENT_RUN_TIMEOUT`), `result.usage` sums
the tokens of every model call, and a Tool output longer than
`contextLimits.maxToolResultChars` (100 000) reaches the model cut.

A long dialog is compacted: its older part is replaced by a summary the
model writes (a user message with `metadata.runtime: "summary"`), the newest
messages stay as written and a Tool call is never separated from its results.
It starts at 80% of the model's window when the LLM connector states
`contextTokens`, at `compaction.maxTokens`, or after the provider refuses a
request as too long (`AgentModelContextOverflowError`); `result.compactions`
says it happened and `compaction: false` turns it off. Token estimates are
corrected by the usage a provider reports (`metadata.agentContext.tokenScale`).

A model's reasoning is a `reasoning` content part of its assistant message
(`agentReasoning(text, { data })`): `data` is the provider's own record of the
block and goes back to it unchanged with the dialog. The runtime drops
reasoning wherever it rewrites a dialog (compaction, trimming by
`contextLimits`, dropped drafts). `AgentUsage` also reports `cacheReadTokens`,
`cacheWriteTokens` and `reasoningTokens`; `inputTokens` is the whole request,
cached tokens included. Claude is served by `anthropicAdapter` from
`bazis/core/infra/anthropic`, on the official SDK.

A run tells what happens in it: `onEvent` gets `AgentRunEvent`s (step, text,
Tool call and result, repeat, compaction, the end) and `runtime.stream(...)`
gives the same as an async iterator; leaving it early cancels the run.
`agentTool({ name, description, agent })` makes an agent a Tool of another
agent: the nested agent gets only the task, works in its own dialog, and its
answer comes back; `maxDepth` (3) stops agents that call each other.

An approval policy may answer `"ask"`: the run stops with `status:
"waiting"` and `pendingApprovals`, nothing is changed, and `run` called again
with that run's `messages` and `approvals: [{ callId, approved, message? }]`
goes on from the unanswered call. The whole state is the dialog, so the pause
survives a restart. A policy may also refuse with words for the model:
`{ approved: false, message }`.

With `llmRouter`, `check` and `run` reject a `modelProfile` the router does
not serve; a fallback to another profile is logged as `LLM model profile
failed, using fallback`. A model provider that gives up after its own deadline
throws `AgentModelTimeoutError`, and the run reports `AGENT_PROVIDER_TIMEOUT`.

LLM clients are registered by infra connectors. Agents name a model profile;
infra owns provider URLs, model ids, limits and fallback:

```ts
@Infra({
  llm: llmRouter({
    fast: llmProfile(llmConfig, openAiCompatibleAdapter(), { model: "gpt-4.1-mini" }),
    reasoning: llmProfile(llmConfig, openAiCompatibleAdapter(), { model: "gpt-4.1", fallback: "fast" }),
  }, { defaultProfile: "fast" }),
})
class AppInfra {}
```
