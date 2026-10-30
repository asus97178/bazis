# Agent Runtime: partial passport

Version: 10. Check date: 2026-10-12. Status: implemented in the described scope;
checks and limits are in the [fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).
Type: an existing atomic core feature. Path: `src/bazis/core/agent`.
This subsystem has no `*.module.ts` of its own: it is connected by importing the
public Agent API and through application module contributions. No new DI module was created.
The scaffold existed before mandatory CLI generation; the creation command is unknown.

Passport scope: `AgentRuntime.run`, the Tool outcome on timeout/abort,
DTO binding, JSON output, context trimming and observing the model's text.
Session persistence and durable stream replay, the whole registry contract and all
hooks are not qualified by this partial passport.
The change in this version (0.99.0): agents are only data. `@Agent`, `@Task`,
`@Prompt`, `agentOutput()`, `@Module.agents/prompts`, the generated agent catalog
and invocation of registered agents by name were removed. `AgentRuntime` is
injected by type and runs an `AgentDataDefinition`.

**Implemented direction:** [AGENT-ARCH-001](../../../../docs/architecture/AGENT_ARCHITECTURE.md)
separates agents from modules: an agent is data that names Tools; Tool
implementations use the existing services and DI. Long-running framework sessions
remain separate work.

## 1. Responsibility and structure

The subsystem runs the Agent → model → Tool loop and owns its result, context and
error boundary. A Tool owns its domain effect. Infra owns the model transport; the
application owns the approval policy, audit and storage.
This is one technical feature; no separate per-layer submodules are created.

`AgentExecutionDriver` manages the phases; `AgentToolExecutor` is responsible for
execution and scopes. It keeps ownership of the attempt, timeout/settlement and the
mapping of errors after an effect to outcome unknown; internal components do not make
these decisions. The public validator/audit types are still available from
AgentToolExecutor and index. Pure internal functions bind DTOs and check the supported
schema. The existing DI, the HTTP model binder and the Boundary Schema formats are used.
No ORM, new container, third-party JSON Schema engine or new dependencies were added.

### Definition as data

`AgentRuntime.run(definition: AgentDataDefinition, options?): Promise<AgentRuntimeResult>`
checks the definition, takes the named Tools from the application catalog
(`@Module.tools`) and runs it. Internally `AgentRegistry.fromDefinition(definition,
catalog.listTools())` creates an independent immutable snapshot for one run.

| Field | Type / default | Limits |
| --- | --- | --- |
| name | required string | Latin letters/digits, dot/hyphen/underscore, 1–128 |
| instructions | required string | 0–100000; an empty string means no instructions |
| description | optional string | up to 4000 |
| modelProfile | optional string | a non-empty identifier 1–128; infra chooses the model |
| toolNames | optional string[], default [] | up to 128 unique names from allowedTools |
| allowedTools | the second argument, default [] | real ToolDefinitions with unique names |

null is not accepted. An unknown/duplicate tool gives AgentSetupError before the model
is called; the message lists the registered names. `run` rejects with it. The model
sees only the named Tools; a call of any other name is `TOOL_NOT_REGISTERED`.
`instructions` become the system message as written; `description` is not sent. The regular owner-bound registrations and hooks stay mandatory for
Tools. The snapshot is fixed for one turn; a change of the agent affects the next one.
Checks: [agent.data-definition.test.ts](test/agent.data-definition.test.ts).

## 2. Components

| Component | File | Purpose |
|---|---|---|
| Public facade | [AgentRuntime.ts](AgentRuntime.ts) | `run(definition)`, `listTools()`, `AGENT_RUNTIME_OPTIONS` |
| Registry | [AgentRegistry.ts](AgentRegistry.ts) | The Tool catalog of a container and the snapshot of one run; internal |
| Executor | [internal/AgentExecutionDriver.ts](internal/AgentExecutionDriver.ts) | Phases, contracts and the terminal result |
| Tool executor | [AgentToolExecutor.ts](AgentToolExecutor.ts) | Policies, the call, timeout/abort, settlement and scope release |
| DTO binding | [internal/AgentModelBinding.ts](internal/AgentModelBinding.ts) | Strict binding through the existing `bindModel`, DTO projection into JSON |
| Tool contracts | [internal/ToolContract.validator.ts](internal/ToolContract.validator.ts) | DTO binding, calling the given schema validator and diagnostic code/message/details; does not decide the effect outcome |
| Audit projection | [internal/ToolAudit.projector.ts](internal/ToolAudit.projector.ts) | A snapshot of the call/result, masking and freezing; does not call the sink and does not choose a retry |
| JSON Schema | [internal/AgentJsonSchema.ts](internal/AgentJsonSchema.ts) | Checks a bounded set of rules; an unknown rule is a rejection |
| Tool runner | [ToolRunner.ts](ToolRunner.ts) | Runs Tools without a model for one caller id (`as(caller)`): catalog filtered by `callers`, contracts, `run` through the Tool executor |
| Context | [AgentContextBuilder.ts](AgentContextBuilder.ts) | Protects current messages and applies three budgets |

## 3. Connection and DI

The TypeScript entry is [index.ts](index.ts); `AgentRegistry` and `AgentToolExecutor`
are internal. The application `@Module` declares `tools`, `agentToolHooks` and regular
providers. `llmConnect` and `llmRouter` register `AgentRuntime` (singleton, exported
by type) next to `AGENT_MODEL_PROVIDER`; the factory reads optional
`AGENT_RUNTIME_OPTIONS` from the root container, so any module may register it. Tool
execution settings (approval policy, audit sink, retries, deadline, hooks) come from
`TOOL_EXECUTION_OPTIONS`, shared with `ToolRunner` (TOOLS-001 §6); the default
`schemaValidator` is `modelValidatorAdapter`. Invalid options and hook setup fail on
the first resolve of `AgentRuntime`. Tool implementations are resolved
in a scope through the existing DI; class dependencies stay in constructors. The
`imports` and `exports` lists belong to the connecting module. The facade introduces
no separate DI exports. The model port is `AgentModelProvider`; model choice and
transport belong to Infra.

## 4. Data, configuration and lifecycle

### Tools registration and the container catalog

`@Module({ tools: [SomeTool] })` creates a regular scoped class provider through the
existing DI contribution extension. If the same owner already declared an exact
`scoped(SomeTool)`, it is used without a second registration. Singleton, transient,
factory, keyed-only and duplicate registrations are rejected. Declaring a name or
class in tools again, including by another owner, gives AgentSetupError at build time.
A conflict with an unrelated regular provider gives ModuleOwnedProviderConflictError.
Neither the Tool constructor nor execute is called for the check.

`AgentRegistry.fromContainer(services: ServiceProvider): AgentRegistry` accepts only
the framework DiContainer; a regular ServiceProvider is rejected with AgentSetupError.
It returns an immutable catalog of native Tools from the actual owner-bound
contributions, without agents and prompts. A repeated call for one container returns
the same registry; a WeakMap does not retain a finished container. Different
containers are isolated. There is no file scanning, no AppModule import and no
implicit inclusion of regular providers. `AgentRuntime.listTools()` returns it.

### Who may call a Tool and running Tools without a model (0.123.0)

Per [TOOLS-001](../../../docs/architecture/TOOLS.md) every `@Tool` lists its `callers`
(required, non-empty; checked when the module registers the Tool, so a missing list
is one configuration-error line). `AgentToolExecutor` derives the caller of a call:
`"agent"` when `agentName` is set, otherwise the explicit `caller`; none is
`TOOL_CALLER_REQUIRED`, one not in `callers` is `TOOL_CALLER_NOT_ALLOWED` (denied,
before input validation). The agent visibility check (`toolNames`) still applies to
agents. `caller` and `actor` (`{ kind: "user" | "system", id }`) reach the approval
request and the audit entry. There is no unbound bypass (`allowUnboundTools` removed).

`ToolRunner` is provided by a global module that the metadata expander imports for
every module that declares `tools`, so an application never registers it and two
modules cannot create two runners; a hosted check builds it at start.
`runner.as(caller)` returns `BoundToolRunner` (`as("agent")` is refused): its
`listTools(tags)`, `getTool`, `describe` and `run` see only Tools whose `callers`
include the id; tags only narrow the list. `run` refuses a `write`/`external` Tool
without `actor` (`TOOL_ACTOR_REQUIRED`) and otherwise returns the executor's result
without throwing. Check: [agent.tool-runner.test.ts](test/agent.tool-runner.test.ts).

`fromDefinition` picks the assigned names from `catalog.listTools()` and creates a
separate run snapshot. The registry does not cancel the permission, approval and input
checks in AgentToolExecutor. In the osnova application ToolsInitializer checks the
declared generated input/output schemas before HTTP; the output schema stays optional.

Checks: [agent.module-contributions.test.ts](test/agent.module-contributions.test.ts),
[catalog and HTTP](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/test/Tools.http.test.ts),
[run](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/test/Run.service.test.ts).

The described scope has no database of its own, migrations, HTTP routes, UI or
background jobs. The passed metadata/DTOs do not become process configuration. The
global HTTP validator is not picked implicitly: Agent uses the validator passed to it.

An exception from `execute`, the Tool constructor or output processing reaches
the model as a generic message (`Tool execution failed.`, `Tool could not be
created.`); the error with its stack goes to `AgentRuntimeOptions.logger`
(`Agent tool failed`). Only `ToolError` (and its subclass
`AgentToolPreCommitError`) carries its message to the model as written. Model
failures except an abort are logged as `Agent model call failed`; the LLM
connectors pass the application `LOGGER`.

An enforcement `deny` carries `message` to the model (`TOOL_HOOK_DENIED`,
`details.reasonCode`) and to the audit projection; without it the generic text
stays. Hook failures, timeouts and invalid answers are logged as `Agent tool hook
failed`. The LLM connectors resolve `AgentRuntime` in a hosted service at start
and turn a construction error into a `DiError` (`AgentRuntime: …`).

A failed or timed-out audit write is logged as `Agent tool audit failed` with
`phase`, `mode` (`fail-closed`, `best-effort`, `required` for hook evidence),
tool, call id and the error; the model gets `Tool audit failed.` without the
sink's text. Late failures (deferred scope disposal, settlement audit) use the
application logger too, falling back to stderr.

A started `write` / `external` that is interrupted before `execute` finishes gets
`TOOL_TIMEOUT_OUTCOME_UNKNOWN` or `TOOL_ABORTED_OUTCOME_UNKNOWN`. The code is kept
with hooks connected; settlement gets `outcomeKnown: false`.
The Runtime ends the call with `AGENT_TOOL_OUTCOME_UNKNOWN` without sending the next
model request. The scope is released after the Tool actually finishes; a late effect
is possible, and the AbortSignal itself does not confirm its cancellation.

Timeout/cancellation errors on the execution path keep `error.details.phase`
regardless of whether the shared timer or the limit of a specific stage fired first.
Before the Tool runs, in the input check, approval, attempt audit and dependency
resolution, the phase is `pre-execute`; in the shared execution handler and when the
retry wait is cancelled, the current state phase is used. Codes, messages, deadlines
and signatures did not change. This rule does not promise an extra `sideEffect` field.
Regressions with controlled clocks are in
[agent.tool-executor.test.ts](test/agent.tool-executor.test.ts).

Finished operations keep an independent bounded settlement and a best-effort
observer. Cancellation before the Tool starts does not mean an unknown effect.
Retries after `OUTCOME_UNKNOWN` are forbidden. `idempotencyKey` is passed to the tool
and takes part in the retry policy; there is no automatic persistent dedup storage here.

## 5. Entry points and fields of the changed scope

The full options are in the facade and executor sources; the table describes the
main fields.

| Input | Type / required | Default and limits |
|---|---|---|
| `run(definition, options)` | `AgentDataDefinition`, options | The definition is checked before the model call |
| `check(definition)` | `AgentDataDefinition` | The same check without the model; throws AgentSetupError |
| `input` | A string (a user message) or JSON (a data part) | `input` or `messages` is required |
| `output.mode` | `text`, `json`, `artifact`; required inside a passed output | The local structural check applies to `json` |
| `output.schema` | An optional JSON Schema or a class name | Without a schema, JSON is checked; a class is resolved by generated metadata |
| `schema.strict` | boolean; true by default | Passed to the adapter; false does not cancel the local schema check |
| `output.description` | An optional string | Passed to the provider's `json_schema.description` |
| `toolExecution.timeoutMs` | An optional non-negative integer, ms | Override → Tool metadata → default 30000; 0 turns off the timer |
| `signal` | An optional AbortSignal | Cancellation that keeps the knowledge of the effect outcome |
| `onTextDelta` | optional synchronous `(event: {step:number, text:string}) => void` | Partial text of one model step; without it the complete-only path is kept |
| `contextLimits.maxMessages/maxChars/maxTokens` | Optional positive integers | Applied in this order; the protected minimum cannot be removed |

Structured output is requested per run with `output: agentOutputContract({ mode: "json", schema })`.
The contract is sent to the provider and checked locally. Success holds the parsed
`result.output`; an invalid answer gives `failed / AGENT_OUTPUT_INVALID`. An
unresolved explicit class gives `AGENT_OUTPUT_SCHEMA_UNAVAILABLE`; the LLM adapter
also rejects an unresolved class before fetch.

DTO: generated nested-model shapes restore instances of nested classes and arrays.
Initialized nested fields are supported without shapes. Extra and forbidden fields
are rejected. Classes are projected recursively into plain JSON without calling
`toJSON`; unset optional class fields are skipped, undefined in plain JSON and arrays
is rejected. Cycles, depth over 64 and more than 100000 projection nodes are
rejected. Tool DTO rules not expressed in the generated schema are checked by the
`schemaValidator` (by default `modelValidatorAdapter`).

The public `describeTool(ToolDefinition): AgentToolContract` returns the same contract
projection the runtime uses: name, description, effect properties and the generated
input/output schemas. Expanding generated refs is shared with the driver.
If a class schema is unavailable, a class contract remains; the host must reject it
before publishing in an external protocol. The projection does not call the tool and
does not replace checking arguments, permissions or schemaValidator in AgentToolExecutor.

### DTO schema identity and the standalone package (R4/K1, 2026-10-04)

Tool inputs and outputs and class output contracts resolve the generated schema by the exact
constructor through the existing OpenAPI registry. The same link applies to the list
of allowed fields of nested DTOs. An unrelated interface with the same name does not
change the class contract. The shared OpenAPI analyzer decides schema names; the Tool
collector ([tool-codegen.ts](../scripts/tool-codegen.ts)) passes the real class
declarations of `@Tool({ input, output })` to the generator. Codegen keeps root and
nested schemas and publishes the constructor → schema links in the existing
`GENERATED_OPENAPI_SCHEMA_MODELS`. No new registry is created.

For older manually registered metadata without such a link, lookup by class name is
kept. If an exact link exists but its schema is missing, another schema with the
short name is not used. As before, a missing schema ends up in a class contract, and
the host must reject it before external publication.
Linked class DTOs must be named exported top-level classes; otherwise codegen returns
`BAZIS_TOOL_SCHEMA_MODEL_UNIMPORTABLE` before writing results.
The Tool collector's existing rejection of two class declarations with the same name
is kept; this change does not promise support for a previously forbidden composition.

AgentRuntime uses a relative import of Boundary Schema inside the package.
The checks [agent.schema-identity.test.ts](test/agent.schema-identity.test.ts) and
[agent.standalone.integration.test.ts](test/agent.standalone.integration.test.ts)
cover the exact choice, no fallback to another schema, the output contract, Tool
and nested DTOs. The integration check creates an independent copy of the package,
checks `AgentRuntime` without `tsconfig.paths`, then runs real codegen with local paths
only into the copied package; it runs the sources and two binaries outside the
checkout. This is not a qualification of npm publishing, an LLM, session persistence
or a full application run with external infrastructure.

JSON Schema subset: types and their unions, nullable, properties/required,
additionalProperties (boolean/schema), items, string/array/object sizes, numeric
bounds, enum/const, anyOf/oneOf/allOf, uniqueItems, pattern and the formats
email/uri/uuid/date/time/date-time/decimal/int64-string. `contentMediaType:
application/json` is supported. Annotation fields are listed in the validator.
Unknown keywords/formats, invalid rules and exceeding the traversal limits give a
rejection, including rules of optional fields. This is not a full JSON Schema draft:
external `$ref`, `not`, `if/then/else`, `multipleOf` and the like are not supported.
The existing resolver expands generated refs; user schemas are passed to the provider
without weakening the limits.

`AgentModelProviderContext.onTextDelta?: (text:string) => void` is an optional
observation port. A provider may not support it; complete still returns the single
canonical AgentModelResponse. The Runtime adds the step number (from 1) and stops
accepting text after settlement, abort or timeout. The callback is synchronous and
must not block or return background tasks; its exception aborts a provider that honors
the contract and gives failed. The text is preliminary: it has not passed final
validation and does not mean a Tool is allowed or executed successfully.
The callback is not part of a checkpoint and is not replayed after resume.
The concrete Infra adapter currently streams only text answers without Tools.
Stream and compatibility checks: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/client-chat-streaming-2026-09-20.md).

## 6. Checks and the readiness boundary

Scenarios and reproducible commands: [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).
The tests check errors, late effects, scopes, DTOs, the wire format and contract
priorities. Source/binary probes perform only synthetic operations.

Trimming with the regular integer estimates uses running sums and a one-directional
cursor: O(n) time and O(n) memory. For compatibility with fractional and overly large
user token estimates the former left-to-right sum recomputation is kept; this rare
fallback may be O(n²). It prevents extra removal and errors from rounding/Infinity.
The available limits did not change. The old and new behavior were compared separately
on 500 histories; the measurements are in the report.

The application/CLI build into a Bun binary; the control Agent probes run outside the
checkout. A full application run with PostgreSQL and a check against a real LLM are
outside the scope of these fixes. Codegen artifacts were not edited.
Separating agents from modules is implemented in 0.99.0 and checked by
[agent.data-definition.test.ts](test/agent.data-definition.test.ts) and
[agent.runtime.test.ts](test/agent.runtime.test.ts).
