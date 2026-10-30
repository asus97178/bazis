# Tools: one contract for agents and processes

Identifier: **TOOLS-001**. Version: **1.0**. Date: **2026-10-31**.
Status: **accepted by the user; implementation planned for bazis 0.123.0**.
Basis: `ToolRunner` (0.122.0) let a business-process engine call Tools without a
model. The user asked where and how Tools should live now that an LLM agent and a
process engine call the same operations, and accepted the recommendations below.

This document replaces the `ai/tools/` placement of
[MOD-ARCH-001](MODULE_ARCHITECTURE.md) and the shared-folder placement of
[AGENT-TOOLS-001](AGENT_TOOL_REGISTRATION.md) §1. Agents stay data per
[AGENT-ARCH-001](AGENT_ARCHITECTURE.md).

## 1. What a Tool is

A Tool is **an application operation with a contract**: a name, an input and an
output DTO, the side effect (`read`, `write`, `external`), the approval rule and a
timeout. It is not an AI artefact. Its callers are consumers of the same operation:

| Caller | Who chooses the Tool | How it calls |
| --- | --- | --- |
| `agent` | The model, among the Tools assigned to the agent definition | `AgentRuntime` |
| Any other caller id, for example `workflow` | Application code: a process engine, a scheduled job | `ToolRunner.as(caller)` |

Every call goes through the one `AgentToolExecutor`: input and output validation,
the DI scope, approval, audit, hooks, retries and the deadline. There is no second
execution path per caller.

A Tool is a thin adapter over the module's services, like an HTTP controller: it
checks the input, calls a service and shapes the output. Business rules live in the
service, so HTTP, agents and processes share them.

## 2. Placement and registration

The module that owns the operation owns the Tool. Tools live in `tools/` at the
module root, next to `http/`:

```text
orders/
  Orders.module.ts
  http/       Orders.controller.ts
  tools/      OrdersFind.tool.ts, OrdersCancel.tool.ts
              contracts/OrdersFind.input.ts, OrdersFind.output.ts
  services/   IOrders.service.ts, Orders.service.ts
```

Registration stays declarative in the owner: `@Module({ tools: [OrdersFindTool] })`.
The framework builds one catalog from all modules. Consumers (agent definitions, the
process engine) do not register Tools: they refer to them by name. There is no
central `tools/` folder of the application and no registration in the consumer's
module, because a Tool depends on the owner's scoped services and encapsulation.

`ai/tools/` and `ai/contracts/` are removed from the module layout; a module has no
`ai/` folder for Tools.

## 3. Who may call a Tool: `callers`

```ts
@Tool({
  name: "orders.find",
  description: "Find an order by id.",
  input: OrdersFindInput,
  output: OrdersFindOutput,
  sideEffect: "read",
  callers: ["agent", "workflow"],
})
export class OrdersFindTool { … }
```

- `callers` is required and non-empty: every Tool states who may call it. A Tool
  without it stops the start (`AgentSetupError`). There is no default audience.
- `agent` means LLM agents. An agent additionally needs the Tool in its
  definition's `toolNames`; both are checked.
- Other ids are free-form application identifiers (`workflow`, `scheduler`).
- `tags` stay for grouping and search; they never decide access.

A call by a caller not listed in `callers` is refused before input validation with
`TOOL_CALLER_NOT_ALLOWED`. The name of a Tool may come from data (a stored process
definition); the caller id always comes from code.

## 4. Calling without a model: `ToolRunner`

`ToolRunner` is registered by the framework whenever the application has Tools; an
application does not spread providers for it. Code binds it to its caller id:

```ts
export class ProcessEngine {
  private readonly tools: BoundToolRunner;

  constructor(runner: ToolRunner) {
    this.tools = runner.as("workflow");
  }

  async step(step: ProcessStep, instance: ProcessInstance) {
    return this.tools.run(step.toolName, step.input, {
      actor: instance.startedBy,
      idempotencyKey: `${instance.id}:${step.id}`,
    });
  }
}
```

- `as(caller)` returns a view limited to that caller: `listTools(tags)`,
  `describe(name)` and `run` see only Tools whose `callers` include it.
- `as("agent")` is refused: agents run through `AgentRuntime`.
- `run` returns `AgentToolResult` and does not throw for a Tool failure.

## 5. On whose behalf: `actor`

A call carries the caller id and the actor:

```ts
type ToolActor = { readonly kind: "user"; readonly id: string } | { readonly kind: "system"; readonly id: string };
```

`AgentToolApprovalRequest` and `AgentToolAuditEntry` get `caller` and `actor`, so an
approval policy can decide by who started a process and the audit shows it. Agents
pass the actor of their run; the runner requires `actor` for `write` and `external`
Tools.

## 6. One execution configuration

Approval policy, audit sink, retries, deadlines and hooks are configured once for
all callers through `TOOL_EXECUTION_OPTIONS`. `AgentRuntimeOptions.toolExecutorOptions`
and `TOOL_RUNNER_OPTIONS` are removed; per-call options (`idempotencyKey`,
`timeoutMs`, `signal`) stay on the call.

## 7. Names are a public API

A stored process definition or agent definition refers to a Tool by name, so:

- the name is `module.action` and does not change; a breaking change of the input
  or output is a new name (`orders.find.v2`) while the old one is kept until no
  stored definition uses it;
- at start, the application can check its stored definitions with
  `ToolRunner.as(caller).getTool(name)` (and `AgentRuntime.check` for agents);
- `write` and `external` Tools used by processes accept `idempotencyKey`: an engine
  retries steps, and the key (instance and step) makes a retry safe.

## 8. The module layout table

In [MOD-ARCH-001](MODULE_ARCHITECTURE.md) the row «Module Tool adapter» becomes:

| Role | Placement | Input | Output |
| --- | --- | --- | --- |
| Tool | `tools/`, `tools/contracts/` | The input DTO, `callers`, DI of the module's services | Calls the module's services and returns a checkable output; who may call it is declared in `callers` |

## 9. Implementation plan (bazis 0.123.0)

1. `ToolOptions.callers` (required), the check in `AgentToolExecutor`
   (`TOOL_CALLER_NOT_ALLOWED`), `caller`/`actor` in approval requests and audit.
2. `ToolRunner` registered by the framework; `as(caller)`; `toolRunnerProviders` and
   `TOOL_RUNNER_OPTIONS` removed.
3. `TOOL_EXECUTION_OPTIONS` replaces `toolExecutorOptions` and
   `TOOL_RUNNER_OPTIONS`.
4. CLI: `g module --full` generates `tools/` with `callers: ["agent"]`.
5. Specs: MOD-ARCH-001 (layout, table), AGENT-TOOLS-001 §1, agent MODULE.md; the
   guide and `upgrading.md` (breaking: `callers` required, options moved, folder).
6. Tests: a caller not in `callers` is refused for agents and for the runner, a Tool
   without `callers` stops the start, the actor reaches approval and audit, `as("agent")`
   is refused.

## 10. Decisions not taken here

- Durable delivery of process steps (outbox, queues) belongs to the process engine.
- Versioning beyond a new name (`version` field, migrations of stored definitions)
  is left until a real case needs it.
