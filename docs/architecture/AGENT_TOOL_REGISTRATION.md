# Registering Tools and assigning them to agents

Identifier: **AGENT-TOOLS-001**. Version: **1.0**. Date: **2026-10-02**.
Status: implemented; isolated checks and the binary probe PASS.
Scope: native Tools from bazis code and their assignment to meta-agents through the catalog.

## 1. Placement and registration

The shared atomic [ToolsModule](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/MODULE.md)
of the osnova application lives inside its existing agents area. One tool is a
class with an execute method. It may use the public services of several modules.
Meta-agents stay definitions in the database; a tool is not copied per agent.

```text
src/app/modules/agents/
  Agents.module.ts                  meta-agent definitions, ORM, runs and Admin UI
  services/
    Agents.service.ts
    Run.service.ts
  tools/
    Tools.module.ts                the single list of registered Tools
    Tools.service.ts               the administrative catalog
    Tools.controller.ts            protected HTTP inputs
    Tools.initializer.ts           schema check at startup
    Agents.tool.ts                 agents.getAll
    contracts/
      Agents.input.ts              the tool's input DTO
      Tools.contracts.ts           catalog fields
    index.ts
    MODULE.md
    test/
```

The current registration:

```ts
import { Module, singleton } from "bazis/core/di";
import { AuthModule } from "../../auth/Auth.module";
import { AgentsModule } from "../Agents.module";
import { AgentsTool } from "./Agents.tool";
import { ToolsController } from "./Tools.controller";
import { ToolsInitializer } from "./Tools.initializer";
import { ToolsService } from "./Tools.service";

@Module({
  imports: [AgentsModule, AuthModule],
  tools: [AgentsTool],
  providers: [singleton(ToolsService)],
  controllers: [ToolsController],
  background: [ToolsInitializer],
  exports: [],
})
export class ToolsModule {}
```

A new tool is added to `tools` once. Its dependencies are declared in the
constructor; the required domain modules are connected through imports and public
DI exports. ToolsModule is connected to AppModule.

`tools` registers the class as scoped automatically. An earlier exact registration
`scoped(ToolClass)` by the same owner stays compatible and is reused.
An incompatible lifetime/factory/key, a repeated name and an owner conflict fail
the container build before a Tool is created. No extra registration decorator,
second DI container, defineTools or RunAppOptions.tools is introduced.

## 2. Shared catalog and dependencies

[AgentRegistry.fromContainer](../../src/bazis/core/agent/AgentRegistry.ts)
builds an immutable snapshot from the actual Tools contributions in DI. The catalog
is cached per container; regular providers without tools do not get into it. Tool
constructors are not called. Different containers have independent catalogs.
There is no hot source lookup and no execution of code from the database.

ToolsModule imports AgentsModule for the public IAgentsService. AgentsModule uses
the core catalog, so there is no reverse import of ToolsModule and no DI cycle.
The shared folder does not make each tool a separate module and does not turn
AgentsModule into an empty composite root. Its public IAgentsService/RunService,
the agents table and the existing HTTP inputs are kept.

## 3. Tool declaration and contracts

[AgentsTool](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/Agents.tool.ts) declares the name,
description, input DTO, sideEffect, approval and timeout through the existing @Tool.
[AgentsToolInput](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/contracts/Agents.input.ts)
holds page: an integer 1–10000, default 1. Regular codegen gets the JSON Schema
from the class and its validators. A declared output DTO is optional.
If an input/output is declared but the generated schema is missing, ToolsInitializer
stops startup before HTTP. The same check runs when a run is prepared.
The limits of the existing resolver of nested generated refs were not extended.

The Tool uses IAgentsService and the trusted clientUserId from the host context.
Output: up to 20 enabled agents with id, name and a description of up to 240
characters, the page number and hasMore. Instructions and model settings are not
returned. Execution still goes through AgentToolExecutor: the assignment check,
input, permissions/policies, approval, hooks, timeout/abort, output and scope release.
Assigning a Tool does not cancel domain checks and does not sandbox native code.

## 4. Catalog and assignment

[ToolsService](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/Tools.service.ts) provides:

| Operation | HTTP | Input | Result |
| --- | --- | --- | --- |
| getAll(query?) | GET /api/agent-tools | search up to 120 characters; page 1–10000; size 1–100; defaults "", 1, 20 | items, page, size, total |
| getById(name) | GET /api/agent-tools/:name | a name of length 1–128 | the description and inputSchema/outputSchema; DI null or HTTP 404 when missing |

All HTTP inputs require Admin; 200 and 404 responses return no-store. The HTTP
binder converts numeric query parameters; the service checks the bounds for a direct
DI call too. null is forbidden; invalid input is 400. The search is case-insensitive
over the name and description, ordered by name. A list item holds name, description,
tags, sideEffect, approval, timeoutMs; executable classes and dependencies never leave.
Schemas are returned only in the detailed response; null means an undeclared contract.

In the agent form the `agent-tools` widget shows a paged catalog with descriptions,
search and selection of up to 128 tools. Assigned names are shown separately;
changing the page, searching and a load error do not clear the selection. The
existing Agent.toolNames field is kept; no new table or migration is needed.

[AgentsService](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/services/Agents.service.ts) checks
all new assignments against the shared catalog before writing. On update under a row
lock the revision is checked first, then the new names. A historical missing name
can be kept or removed; a new unknown name is rejected with a toolNames issue.
Main is not overwritten at startup. A run that is already prepared keeps its snapshot.

## 5. How the model gets the tools

[RunService](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/services/Run.service.ts) takes toolNames
from the definition, resolves them through the shared catalog and creates
AgentRegistry.fromDefinition with only the assigned set. The service no longer has
a manual hostTools list. An unknown assignment or an unavailable declared schema
gives 409 before the pending turn and before calling the model. A model attempt to
call an unassigned tool is rejected.

A regular OpenAI-compatible adapter passes the descriptions in the tools field of
the API request. The model returns the name and arguments; our executor runs the
call and returns the result through the same adapter. Codex gets dynamicTools with
safe wire names and calls the same executor. DTOs, DI, identity and secrets stay
with bazis. The transport adapters and strict settings were not changed.

The contract stays standard: parameters are described with JSON Schema, and the
exchange with the model is the provider's function/tool calling. An bazis output
schema can be declared in addition.
Protocol overviews: [OpenAI](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
Anthropic integration, MCP and tool search by the model are not added to this module.

## 6. Checks and delivery

The CLI creation command and detailed fields are recorded in the
[ToolsModule passport](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/agents/tools/MODULE.md).
Static imports and regular codegen support the sources and the binary build.
The catalog is built once; sorting is O(N log N), search O(N), output bounded by size.
Reading the catalog makes no extra database queries; no speedup measurements are claimed.

Checked: registration and ownership, scoped identity, catalog independence,
Admin/no-store and query binding, schemas, assignments and historical references,
filtering the model's set, regular and Codex runs, CLI/codegen, TypeScript, the
Admin build and the binary probe. The database and the external LLM were replaced
by controlled ports in these checks; live PostgreSQL and the provider were not run
in this task. Result: 471 tests without errors, TypeScript/Admin build and the
app/CLI build PASS. The browser check of the form and the binary probe outside the
checkout PASS. Commands and limits are in the [report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/agent-tools-module-2026-10-02.md).
