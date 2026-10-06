# bazis agents, modules and tools

Identifier: **AGENT-ARCH-001**. Version: **1.2**. Date: **2026-09-21**.
Status: **the catalog, Admin UI, shared runs from chat/CLI and the first allowed tool are implemented; long-running execution is the next stage**.
Basis: the user set the order: first put the existing Agent Runtime and Tools in
order and separate agents from modules, then build on that base.

This document extends [MOD-ARCH-001](MODULE_ARCHITECTURE.md). By the user's next
request, an atomic [AgentsModule](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/MODULE.md)
was created in the osnova application to manage definitions from the admin panel.
Then a path to run a definition as data and a separate user-facing Vue chat were
added. The earlier declarations are not fully migrated.

## 1. The accepted separation

**An application has modules and, separately, agents. Agents have tools.**

| Entity | Responsibility | Relation to the others |
| --- | --- | --- |
| Module | Application services, data, invariants and DI contracts | Provides operations a Tool implementation may use |
| Agent | Instructions, input and output contracts, model profile, limits and the assigned set of Tools | Declared and created independently of the module composition |
| Tool | A verifiable action contract and its binding to an implementation | Assigned to an agent; one tool may be used by several agents |
| Agent Runtime | Executes the definition: context, limits, work state and error boundary | Runs all agents through one shared Tool call mechanism |

In the target model an agent is not part of `@Module.agents`, a submodule or a new
DI container. Creating a concrete agent does not require creating an bazis module or
adding it to `imports`.

A Tool implementation may use a module's services through the existing DI and stay
next to their owner. That does not make the agent part of the module.
The set of Tools assigned to an agent does not transfer ownership of data or services.
Publishing a tool and granting an agent access to it are different actions.

The agent catalog service or the runtime itself may be connected as technical
framework features. This way of registering services does not define the set of
concrete application agents.

## 2. Declaring and creating agents

Standalone declarations in the sources go into `src/app/agents/`, separate from
`src/app/modules/`. This is the target path for new declarations when agents ship in
the sources; there is no need to create the directory empty. Definitions from the
database need no separate source files per agent.
Do not copy a shared Tool implementation into the directory of every agent that uses it.

Target direction: an agent definition is serializable metadata. A developer
declaration and a definition from storage go through the same check and reference
resolution, then run in one runtime. The existing decorators may stay as an authoring
method; a class must not be mandatory for a definition from the database.

A basic definition records identity, version, name, instructions and state; the list
of Tools and the model profile may stay empty. A separate input/output schema is
needed for structured operations, while a general dialog does not require the agent
author to set one. Execution limits and general model settings belong to the runtime
and Infra; the allowed overrides will be defined by the execution contract.
The full fields, defaults and errors are described before implementation per the
[input contract rules](MODULE_ARCHITECTURE.md#7-input-and-output-contracts).
The current CRUD API is described in the AgentsModule passport. There is no separate
CLI command to create a definition yet; creating one through the Admin UI needs no
source generation.

An agent definition, its version, a session and a single run have different
lifecycles. Creating a permanent agent in the catalog is separate from running a
temporary helper. Work state is not kept in the shared metadata.

An application may know only the starting Main definition or a reference to it.
Main is a regular agent with allowed catalog management Tools. When it creates another
agent, the same service, check and authorization apply as for creation through the
application API. Main has no special powers to bypass platform rules.
A single Main is not a mandatory setup for every application.

## 3. Executing Tools and hooks

Assigning a Tool to an agent does not replace checking the caller's permission for
the concrete action. Real permissions are limited by the platform and domain service
policies. Agent metadata cannot grant new rights on its own, inject secrets or turn
off mandatory checks.

Execution uses the existing DI, DTO/schema contracts and the
[AgentToolExecutor](../../src/bazis/core/agent/AgentToolExecutor.ts).
No parallel ORM, container or second runtime is created for dynamic agents.
Working with a service directly outside the executor is not a protected Tool call.

The [Tool hooks](../../src/bazis/core/agent/AgentToolHooks.ts) split is kept:
enforcement checks admission, settlement records the outcome, observer observes.
Arbitrary agent metadata does not select mandatory platform hooks.
Behavior on timeout, cancellation, a recording failure and an unknown action outcome
is checked regardless of how the agent was declared.

A Tool performs an action; a hook takes part in its lifecycle; a skill holds
instructions and materials. Skills are not needed for the first stage. Future
execution of commands and untrusted code needs a separate isolation adapter;
a DI scope is not process, file or network isolation.

## 4. The checked current state

| Area | What exists | What has to change |
| --- | --- | --- |
| [AgentsModule](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/MODULE.md) | Definitions in PostgreSQL, protected Admin CRUD, versions, Main, RunService and agents.getAll | Main creating other agents through a Tool with a separate permission check |
| [Module AI metadata](../../src/bazis/core/agent/index.ts) | `agents/tools/prompts/agentToolHooks` extend the module metadata | Remove the dependency of agent execution on the module declaration; keep the current path during the migration |
| [AgentRegistry](../../src/bazis/core/agent/AgentRegistry.ts) | fromDefinition resolves toolNames from the host's explicit list; an immutable snapshot without an agent class | Storing a versioned snapshot together with a long-running session |
| [Agent metadata](../../src/bazis/core/agent/metadata.ts) | Dynamic definitions are data; classes/decorators stay for Tools/DTOs and compatibility | Align the old examples and generation without changing the old API without a migration |
| [CLI full template](../../src/bazis/cli/templates/module.ts) | Creates an AnalystAgent inside the module and writes `agents` into `@Module` | Separate module and agent generation, align codegen and checks |
| [Agent Runtime](../../src/bazis/core/agent/MODULE.md) | The working Agent → model → Tool loop and the checked limits of local fixes | Put the current contracts and registration in order before adding new capabilities |
| [Chat](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agent-chat/MODULE.md) / [CLI](../../src/bazis/cli/MODULE.md) | The shared RunService, saved answers, cancellation, text and tool progress in Vue; the CLI gets the final answer | CLI streaming/resume and a transport-independent session |
| [Session contracts](../../src/bazis/core/agent/session/contracts.ts) | Session contracts; entities, a codec and checkpoint protection exist next to them | Finish the executing service separately; having contracts does not prove recovery works |

The current code with `@Module.agents` is compatibility during the transition, not a
model for new agents. `extras` already allows passing separate declarations, but it
does not by itself complete an independent lifecycle and a dynamic catalog.
The existing tests of the module path stay the evidence of compatibility until the migration.

## 5. Order of work

1. **Bring what exists to the accepted model.** Clarify the public inputs, state
   owners and Agent/Tool/Prompt registration; separate agent registration from
   `@Module` using the current registry, DI and executor.
   Align the CLI, codegen and examples. Fix the defects found along the way.
   Existing consumers are moved in a controlled way; the old input is removed after
   its uses are replaced and compatibility is checked.
2. **Add definitions as data.** One contract, reference checks, versions and a
   catalog through the existing ORM. Creating a definition needs no new class, module
   or application rebuild. Main uses the regular catalog API.
3. **Develop long-running execution.** On the ordered base, finish sessions, the
   log, checkpoints, events, stopping, resuming and safe coordination.
   Check failure and recovery without repeating actions with an unknown outcome.

The first separation checks: an agent registers without `@Module.agents`; it has
access only to the assigned and allowed Tools; two agents use one tool
implementation without shared mutable run state; the old path keeps its checked
semantics during the transition. For CLI/codegen changes, the generation and
execution of the affected binary are checked.

By a separate request the catalog and its Admin UI were implemented before the full
migration of runtime registration. Chat now hands execution to the RunService of the
Agents module; the CLI uses the same server path. The definition is fixed before
pending, and references are resolved only from the host's tool list. The first
`agents.getAll` calls the existing catalog service through AgentToolExecutor and a
DI scope. Codex App Server uses the same executor through explicit dynamicTools;
Codex's own shell/MCP/other tools stay disabled.

This completes the first practical pass "definition → model → allowed tool →
answer". The next work goes in this order:

1. A long-running session and an event log: the same state regardless of the
   transport and process restarts, with explicit terminal/undetermined outcomes.
2. Resume and recovery: keep the agent snapshot and context, do not repeat actions
   with an unknown result, check cancellation at the dependency boundary.
3. Write tools and a Main that creates agents: domain permissions, confirmation when
   needed, versions and audit. A regular client never gets Admin through the model.

The old `--full` generation with an agent class is kept for compatibility for now;
this step does not migrate it. Results of the first pass and how to reproduce them:
[shared run check](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agent-run-2026-09-21.md).

The exact checks are chosen per change. The checks of the earlier
[audit](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-20-agent-tool/fixes/REPORT.md) do not confirm
the separation that is not done yet. The catalog, PostgreSQL, binary and browser
results are in the [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agents-module-2026-09-20.md).

## 6. Limits of the current solution

This is about the framework base. To check the definition model, the user also asked
for management from the existing admin panel; that adapter was added.
A separate later request added the Vue client and the atomic ClientAuth and Chat
modules. Chat uses RunService, which runs the snapshot through
`AgentRegistry.fromDefinition`, the existing AgentRuntime or CodexClient. This is an
application run; framework checkpoint/replay, extra channels and a marketplace stay a
separate area. Events and control commands belong to the runtime contract.

The OOP/SOLID, performance, resilience, binary execution and atomicity rules still
apply. New infrastructure modules are created through the CLI per MOD-ARCH-001; a
concrete agent definition is not a module. The upcoming separate agent generation is
implemented and checked in the CLI first. This document introduces no nonexistent
command and does not order a mass move of files.
