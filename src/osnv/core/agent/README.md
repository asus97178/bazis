# osnv Agent

`core/agent` is the first executable foundation for osnv AI. It contains
provider-neutral metadata, discovery and DI-backed tool execution:

- `@Agent`
- `@Task`
- `@Tool`
- `@Prompt`
- `collectAgentCatalog`
- `AgentRegistry`
- generated metadata via `bun run di:generate`
- provider-neutral semantic model (`agentMessage`, `agentToolCall`,
  `agentModelRequest`, `agentModelResponse`)
- prompt/context rendering via `DefaultAgentContextBuilder`
- DI-backed `AgentToolExecutor`

Model providers live behind infra connectors. Long-term memory and streaming are
still separate layers on top of this runtime boundary.

```ts
import { Agent, Module, Task, Tool, agentOutput } from "osnv";

class CreateRequirementsRequest {
  feature!: string;
}

class ProductRequirementsDocument {
  goal!: string;
  acceptanceCriteria!: string[];
}

@Tool({
  name: "catalog.search",
  description: "Ищет товары в каталоге.",
  sideEffect: "read",
})
class SearchCatalogTool {}

@Agent({
  name: "system-analyst",
  role: "Системный аналитик",
  sections: [
    {
      kind: "developer",
      content: "Верни конкретные проверяемые требования.",
    },
    {
      kind: "tool-policy",
      content: "Используй read-инструменты перед предложением write-действий.",
    },
  ],
  tools: [SearchCatalogTool],
  modelProfile: "reasoning",
})
class SystemAnalystAgent {
  @Task({
    name: "prepare-requirements",
    description: "Подготовить документ требований к продуктовой функции.",
  })
  prepareRequirements(input: CreateRequirementsRequest): ProductRequirementsDocument {
    return agentOutput();
  }
}

@Module({
  agents: [SystemAnalystAgent],
  tools: [SearchCatalogTool],
})
class ProductModule {}
```

The DI core does not know about agent metadata. Importing `@/core/agent` or
the root `osnv` API extends `@Module` with `agents`, `tools` and `prompts`.
Each entry in `tools` creates one ordinary scoped provider owned by that module.
An existing exact scoped self-class provider is reused; incompatible lifetimes,
duplicates, and conflicting owners are rejected before activation.
`AgentRegistry.fromContainer(container)` returns the immutable host Tool catalog
from these registrations without constructing Tools. Metadata-defined agents
select their own subset through `AgentRegistry.fromDefinition(definition, catalog.listTools())`.
Internal contribution readers use an Agent-owned view of these optional fields.
This also allows an isolated HTTP host to type-check when `generatedRuntime`
references `AgentRegistry` only as a type, without loading the public Agent barrel
and its DI augmentation. Runtime validation and provider ownership are unchanged.
For simple cases, put role/instructions/sections directly on `@Agent`. Use a
separate `@Prompt` class when the prompt is reused, versioned, or owned outside
one agent.

For startup-friendly discovery, `bun run di:generate` writes
`src/generated/osnv/agentCatalog.ts`. Use
`AgentRegistry.fromGeneratedModules([AppModule])` when the runtime should prefer
the generated metadata index and still respect module ownership.

The semantic model is the provider-neutral language for future runtime/provider
adapters:

```ts
const request = agentModelRequest({
  invocationId: "inv-1",
  messages: [agentMessage("user", "Подготовь критерии приемки")],
  tools: [agentToolContract({
    name: "catalog.search",
    description: "Ищет товары.",
    sideEffect: "read",
  })],
});
```

Tool execution stays behind osnv DI, agent visibility and approval policy:

```ts
import { modelValidatorAdapter } from "@/library/validation";

const container = createContainer(AppModule);
const registry = AgentRegistry.fromModules([AppModule]);
const executor = new AgentToolExecutor(container, registry, {
  schemaValidator: modelValidatorAdapter,
  auditSink: (entry) => auditStore.write(entry),
});

const result = await executor.execute(agentToolCall({
  id: "call-1",
  name: "catalog.search",
  input: { query: "keyboard" },
}), {
  agentName: "product-designer",
});
```

Audit entries redact `input`, `result` and execution `metadata` by default
using `osnv/library/redaction` (`password`, `secret`, `token`, `apiKey`,
`authorization`, `cookie`, etc.). Raw audit traces are an explicit local-debug
escape hatch: pass `auditRedaction: false` on the executor or one execution.

Retries are opt-in. `write` and `external` tools require an idempotency key
before the executor will repeat them:

```ts
await executor.execute(agentToolCall({
  id: "call-2",
  name: "catalog.reindex",
}), {
  agentName: "product-designer",
  idempotencyKey: "catalog-reindex-1",
  retryPolicy: { maxAttempts: 3, delayMs: 100, backoff: "exponential" },
});
```

Runtime-generated idempotency keys include both the invocation id and the
unique model call id. Use `idempotencyKeyForCall` for a domain-specific stable
key. Tool scopes have a bounded disposal wait (`scopeDisposeTimeoutMs`, five
seconds by default). When execution settles after a timeout/abort, audit sinks
receive a terminal `settlement` entry; an unknown write outcome stops runtime
continuation.

Every tool call also has one 30-second deadline covering input validation,
approval, audit, DI resolution, execution, output processing and result audit.
Model provider calls default to 60 seconds. Set the corresponding `timeoutMs`
to `0` only when an explicit compatibility opt-out is required.

The first runtime slice invokes a model provider from infra, then routes tool
calls through the executor:

```ts
const runtime = new AgentRuntime(
  container,
  AgentRegistry.fromModules([AppModule]),
  container.resolve(AGENT_MODEL_PROVIDER),
);

const result = await runtime.invoke("product-designer", {
  input: "Подготовь критерии приемки",
  maxSteps: 4,
});
```

For controller-style DX, prefer task methods on an agent. The task method is a
business operation contract; the method body is not called by user code:

```ts
const result = await runtime.invokeTask("system-analyst", "prepare-requirements", {
  feature: "Оформление заказа с промокодом",
});
```

`@Task` can declare `input` and `output` explicitly. With `bun run di:generate`,
simple method signatures are also read from code and written to generated
metadata for faster startup-friendly discovery.

Prompt metadata is rendered into provider request context, not stored in the
conversation history returned by the runtime:

```ts
const runtime = new AgentRuntime(container, registry, provider, {
  contextLimits: { maxMessages: 24, maxTokens: 8_000, maxChars: 32_000 },
});

const result = await runtime.invoke("product-designer", {
  input: "Подготовь критерии приемки",
  contextLimits: { maxMessages: 12, maxTokens: 4_000 },
});
```

`DefaultAgentContextBuilder` preserves the system prompt and newest conversation
message when trimming old history. `maxTokens` uses a deterministic built-in
estimator, and provider requests include `metadata.agentContext.trace` so context
assembly is inspectable.

LLM clients are registered by infra connectors, not inside agent modules. Agents
name a model profile; infra owns provider URLs, model ids, limits and fallback:

```ts
@Infra({
  llm: llmRouter({
    fast: llmProfile(llmConfig, openAiCompatibleAdapter(), {
      model: "gpt-4.1-mini",
      temperature: 0.1,
      maxOutputTokens: 1000,
    }),
    reasoning: llmProfile(llmConfig, openAiCompatibleAdapter(), {
      model: "gpt-4.1",
      temperature: 0.2,
      maxOutputTokens: 4000,
      fallback: "fast",
    }),
  }, { defaultProfile: "fast" }),
})
class AppInfra {}
```
