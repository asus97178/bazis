# Agent Runtime: partial passport

Version: 9. Check date: 2026-10-04. Status: implemented in the described scope;
checks and limits are in the [fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md).
Type: an existing atomic core feature. Path: `src/osnv/core/agent`.
This subsystem has no `*.module.ts` of its own: it is connected by importing the
public Agent API and through application module contributions. No new DI module was created.
The scaffold existed before mandatory CLI generation; the creation command is unknown.

Passport scope: `AgentRuntime.invoke/invokeTask`, the Tool outcome on timeout/abort,
DTO binding, JSON output, context trimming and observing the model's text.
Session persistence and durable stream replay, the whole registry contract and all
hooks are not qualified by this partial passport.
The addition in this version: `@Module.tools` registration and the per-container catalog.

**Accepted direction:** [AGENT-ARCH-001](../../../../docs/architecture/AGENT_ARCHITECTURE.md)
separates agents from modules: an agent is assigned Tools whose implementations use
the existing services and DI. This passport version records the decision;
AgentRegistry.fromDefinition already accepts a definition as data. The old path
through classes stays compatible; the full CLI/codegen migration and long-running
framework sessions remain separate work.

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

`AgentRegistry.fromDefinition(input: AgentDataDefinition, allowedTools?: readonly ToolDefinition[]): AgentRegistry`
creates an independent immutable snapshot for the regular AgentRuntime. The agent
author needs no Class/@Module. The internal DataAgentTarget keeps the existing public
type AgentDefinition.target; DI does not create it, and it is never executed.

| Field | Type / default | Limits |
| --- | --- | --- |
| name | required string | Latin letters/digits, dot/hyphen/underscore, 1–128 |
| instructions | required string | 0–100000; an empty string means no instructions |
| description | optional string | up to 4000 |
| modelProfile | optional string | a non-empty identifier 1–128; infra chooses the model |
| toolNames | optional string[], default [] | up to 128 unique names from allowedTools |
| allowedTools | the second argument, default [] | real ToolDefinitions with unique names |

null is not accepted. An unknown/duplicate tool gives AgentSetupError before the model
is called. The host allows capabilities explicitly: a name does not grant access to
the global catalog. The regular owner-bound registrations and hooks stay mandatory for
Tools. The snapshot is fixed for one turn; a change of the agent affects the next one.
Checks: [agent.data-definition.test.ts](test/agent.data-definition.test.ts).

## 2. Components

| Component | File | Purpose |
|---|---|---|
| Public facade | [AgentRuntime.ts](AgentRuntime.ts) | Agent / Task calls |
| Executor | [internal/AgentExecutionDriver.ts](internal/AgentExecutionDriver.ts) | Phases, contracts and the terminal result |
| Tool executor | [AgentToolExecutor.ts](AgentToolExecutor.ts) | Policies, the call, timeout/abort, settlement and scope release |
| DTO binding | [internal/AgentModelBinding.ts](internal/AgentModelBinding.ts) | Strict binding through the existing `bindModel`, DTO projection into JSON |
| Tool contracts | [internal/ToolContract.validator.ts](internal/ToolContract.validator.ts) | DTO binding, calling the given schema validator and diagnostic code/message/details; does not decide the effect outcome |
| Audit projection | [internal/ToolAudit.projector.ts](internal/ToolAudit.projector.ts) | A snapshot of the call/result, masking and freezing; does not call the sink and does not choose a retry |
| JSON Schema | [internal/AgentJsonSchema.ts](internal/AgentJsonSchema.ts) | Checks a bounded set of rules; an unknown rule is a rejection |
| Context | [AgentContextBuilder.ts](AgentContextBuilder.ts) | Protects current messages and applies three budgets |

## 3. Connection and DI

The TypeScript entry is [index.ts](index.ts); new internal functions are not exported
through it. In the current API the application `@Module` declares `agents`, `tools`,
`prompts`, `agentToolHooks` and regular providers. Tool implementations are resolved
in a scope through the existing DI; class dependencies stay in constructors. The
`imports` and `exports` lists belong to the connecting module. The facade introduces
no separate DI exports. The model port is `AgentModelProvider`; model choice and
transport belong to Infra.

`AgentRegistry` also accepts a ready `AgentCatalog`, and
`fromModules/fromGeneratedModules` accept extra `extras` declarations.
This is the existing groundwork for standalone registration. The current definitions
still hold class references. The target transition must not create a second executor
or change the checks of DTOs, action outcomes and hooks depending on the agent source.

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
implicit inclusion of regular providers.

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

Existing calls are compatible; an optional onTextDelta was added to options.
The full options are in the facade and executor sources; the table describes the
fields affected by the fixes.

| Input | Type / required | Default and limits |
|---|---|---|
| `invoke(agentName, options)` / `invokeTask(agentName, taskName, input, options)` | Existing methods | The Agent/Task must be registered |
| `input` | JSON or an instance of the declared DTO | For classes: a no-argument constructor, a whitelist and validation |
| `output.mode` | `text`, `json`, `artifact`; required inside a passed output | The local structural check applies to `json` |
| `output.schema` | An optional JSON Schema or a class name | Without a schema, JSON is checked; a class is resolved by generated metadata |
| `schema.strict` | boolean; true by default | Passed to the adapter; false does not cancel the local schema check |
| `output.description` | An optional string | Passed to the provider's `json_schema.description` |
| `toolExecution.timeoutMs` | An optional non-negative integer, ms | Override → Tool metadata → default 30000; 0 turns off the timer |
| `signal` | An optional AbortSignal | Cancellation that keeps the knowledge of the effect outcome |
| `onTextDelta` | optional synchronous `(event: {step:number, text:string}) => void` | Partial text of one model step; without it the complete-only path is kept |
| `contextLimits.maxMessages/maxChars/maxTokens` | Optional positive integers | Applied in this order; the protected minimum cannot be removed |

Declared Agent/Task output classes take priority over the caller's output; the Agent
output is checked before the Task output. Without these declarations an explicit JSON
contract is checked in both `invoke` and `invokeTask`. Success holds the parsed
`result.output`; an invalid answer gives `failed / AGENT_OUTPUT_INVALID`. An
unresolved explicit class gives `AGENT_OUTPUT_SCHEMA_UNAVAILABLE`; the LLM adapter
also rejects an unresolved class before fetch.

DTO: generated nested-model shapes restore instances of nested classes and arrays.
Initialized nested fields are supported without shapes. Extra and forbidden fields
are rejected. Classes are projected recursively into plain JSON without calling
`toJSON`; unset optional class fields are skipped, undefined in plain JSON and arrays
is rejected. Cycles, depth over 64 and more than 100000 projection nodes are
rejected. Custom decorators not expressed in the generated schema need a connected
`taskSchemaValidator` / `schemaValidator`.

The public `describeTool(ToolDefinition): AgentToolContract` returns the same contract
projection the runtime uses: name, description, effect properties and the generated
input/output schemas. Expanding generated refs is shared with the driver.
If a class schema is unavailable, a class contract remains; the host must reject it
before publishing in an external protocol. The projection does not call the tool and
does not replace checking arguments, permissions or schemaValidator in AgentToolExecutor.

### DTO schema identity and the standalone package (R4/K1, 2026-10-04)

Tool, Agent and Task inputs and outputs resolve the generated schema by the exact
constructor through the existing OpenAPI registry. The same link applies to the list
of allowed fields of nested DTOs. An unrelated interface with the same name does not
change the class contract. The shared OpenAPI analyzer decides schema names; the Agent
collector passes the real class declarations to the generator. Codegen keeps root and
nested schemas and publishes the constructor → schema links in the existing
`GENERATED_OPENAPI_SCHEMA_MODELS`. No new registry is created.

For older manually registered metadata without such a link, lookup by class name is
kept. If an exact link exists but its schema is missing, another schema with the
short name is not used. As before, a missing schema ends up in a class contract, and
the host must reject it before external publication.
Linked class DTOs must be named exported top-level classes; otherwise codegen returns
`OSNV_AGENT_SCHEMA_MODEL_UNIMPORTABLE` before writing results.
The Agent collector's existing rejection of two class declarations with the same name
is kept; this change does not promise support for a previously forbidden composition.

AgentRuntime uses a relative import of Boundary Schema inside the package.
The checks [agent.schema-identity.test.ts](test/agent.schema-identity.test.ts) and
[agent.standalone.integration.test.ts](test/agent.standalone.integration.test.ts)
cover the exact choice, no fallback to another schema, Agent/Task input/output, Tool
and nested DTOs. The integration check creates an independent copy of the package,
checks the Agent API without `tsconfig.paths`, then runs real codegen with local paths
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
These results refer to the audit fixes. Separating agents from modules is so far
accepted as an architectural decision and not confirmed by separate implementation checks.
