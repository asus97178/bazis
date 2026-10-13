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

Runtime settings — limits, approval policy, audit sink, context builder —
are registered once:

```ts
@Module({
  providers: [DI.singleton(DI.valueProvider(AGENT_RUNTIME_OPTIONS, {
    maxSteps: 6,
    toolExecutorOptions: {
      approvalPolicy: (request) => request.tool.sideEffect === "read",
      auditSink: (entry) => auditStore.write(entry),
    },
  }))],
})
export class AgentSettingsModule {}
```

Tool input and output are validated by the model validator
(`modelValidatorAdapter`) unless `toolExecutorOptions.schemaValidator` says
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
