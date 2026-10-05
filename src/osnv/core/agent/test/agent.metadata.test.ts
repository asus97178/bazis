import { describe, expect, test } from "bun:test";
import { Module } from "@/core/di";
import {
  Agent,
  AgentRegistry,
  AgentSetupError,
  Prompt,
  Task,
  Tool,
  agentOutput,
  agentMetadataOf,
  collectAgentCatalog,
  type AgentCatalog,
  type AgentDefinition,
  type AgentMetadataIndex,
  type AgentTaskDefinition,
  type AgentTaskMetadata,
  type PromptDefinition,
  type PromptMetadata,
  type ToolDefinition,
  type ToolMetadata,
  promptMetadataOf,
  toolMetadataOf,
} from "../index";
import { GENERATED_AGENT_METADATA } from "../generated/catalog";

@Tool({
  name: "catalog.search",
  description: "Find products in the catalog.",
  sideEffect: "read",
})
class SearchCatalogTool {}

@Prompt({
  name: "product.designer",
  role: "Product designer",
  goal: "Turn product context into clear requirements.",
  instructions: ["Prefer explicit acceptance criteria."],
  sections: [
    {
      kind: "developer",
      title: "Delivery Rules",
      content: ["Prefer reversible operations.", "Name risky assumptions."],
    },
  ],
})
class ProductDesignerPrompt {}

@Agent({
  name: "product-designer",
  description: "Creates product artifacts.",
  prompt: ProductDesignerPrompt,
  tools: [SearchCatalogTool],
  modelProfile: "reasoning",
  maxSteps: 8,
})
class ProductDesignerAgent {}

class CreateRequirementsRequest {
  feature!: string;
}

class ProductRequirementsDocument {
  goal!: string;
}

@Agent({
  name: "system-analyst",
  description: "Prepares business artifacts.",
  goal: "Помочь пользователю выполнить бизнес-сценарий.",
  instructions: ["Отвечай кратко.", "Не выдумывай данные."],
  sections: [
    {
      kind: "tool-policy",
      content: "Для данных используй только tools.",
    },
  ],
})
class SystemAnalystAgent {
  @Task({
    name: "prepare-requirements",
    description: "Prepare product requirements for a feature.",
    input: CreateRequirementsRequest,
    output: ProductRequirementsDocument,
    modelProfile: "reasoning",
    maxSteps: 3,
  })
  prepareRequirements(_input: CreateRequirementsRequest): ProductRequirementsDocument {
    return agentOutput();
  }
}

describe("agent metadata", () => {
  test("decorators write normalized class metadata", () => {
    expect(agentMetadataOf(ProductDesignerAgent)).toMatchObject({
      name: "product-designer",
      description: "Creates product artifacts.",
      modelProfile: "reasoning",
      maxSteps: 8,
    });
    expect(toolMetadataOf(SearchCatalogTool)).toMatchObject({
      name: "catalog.search",
      sideEffect: "read",
      approval: "policy",
    });
    expect(promptMetadataOf(ProductDesignerPrompt)).toMatchObject({
      name: "product.designer",
      role: "Product designer",
      sections: [
        {
          kind: "developer",
          title: "Delivery Rules",
          content: ["Prefer reversible operations.", "Name risky assumptions."],
        },
      ],
    });
    expect(agentMetadataOf(SystemAnalystAgent)?.tasks).toEqual([
      expect.objectContaining({
        name: "prepare-requirements",
        methodName: "prepareRequirements",
        description: "Prepare product requirements for a feature.",
        input: CreateRequirementsRequest,
        output: ProductRequirementsDocument,
        modelProfile: "reasoning",
        maxSteps: 3,
      }),
    ]);
    expect(agentMetadataOf(SystemAnalystAgent)).toMatchObject({
      goal: "Помочь пользователю выполнить бизнес-сценарий.",
      instructions: ["Отвечай кратко.", "Не выдумывай данные."],
      constraints: [],
      sections: [
        {
          kind: "tool-policy",
          content: ["Для данных используй только tools."],
        },
      ],
    });
  });

  test("write and external tools require approval by default", () => {
    @Tool({
      name: "catalog.reindex",
      description: "Rebuilds the product search index.",
      sideEffect: "write",
    })
    class ReindexTool {}

    expect(toolMetadataOf(ReindexTool)?.approval).toBe("required");
  });

  test("unsafe write tool cannot opt out of approval", () => {
    expect(() => {
      @Tool({
        name: "catalog.delete",
        description: "Deletes a product.",
        sideEffect: "write",
        approval: "never",
      })
      class DeleteProductTool {}

      return DeleteProductTool;
    }).toThrow(AgentSetupError);
  });

  test("agent model profile must be non-empty when provided", () => {
    expect(() => {
      @Agent({ name: "broken-agent", modelProfile: "   " })
      class BrokenAgent {}

      return BrokenAgent;
    }).toThrow(AgentSetupError);
  });

  test("prompt sections validate kind, title and content", () => {
    expect(() => {
      @Prompt({ name: "broken", sections: [{ kind: "developer", content: "   " }] })
      class BlankSectionPrompt {}

      return BlankSectionPrompt;
    }).toThrow(AgentSetupError);

    expect(() => {
      @Prompt({ name: "broken-kind", sections: [{ kind: "unknown" as never, content: "ok" }] })
      class UnknownSectionPrompt {}

      return UnknownSectionPrompt;
    }).toThrow(AgentSetupError);
  });

  test("task decorators support public instance methods only and reject empty names", () => {
    expect(() => {
      class BrokenTaskAgent {
        @Task("   ")
        broken(): string {
          return agentOutput();
        }
      }

      return BrokenTaskAgent;
    }).toThrow(AgentSetupError);
  });
});

describe("agent catalog", () => {
  test("collects agents from module imports and resolves referenced tools and prompts", () => {
    @Module({ agents: [ProductDesignerAgent] })
    class ProductModule {}

    @Module({ imports: [ProductModule] })
    class AppModule {}

    const catalog = collectAgentCatalog([AppModule]);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.prompts).toHaveLength(1);
    expect(catalog.agents[0]?.tools[0]?.metadata.name).toBe("catalog.search");
    expect(catalog.agents[0]?.prompt?.metadata.name).toBe("product.designer");
    expect(catalog.agents[0]?.tasks).toHaveLength(0);

    const registry = AgentRegistry.fromModules([AppModule]);
    expect(registry.requireAgent("product-designer").metadata.name).toBe("product-designer");
    expect(registry.getTool("catalog.search")?.metadata.sideEffect).toBe("read");
  });

  test("collects task methods from agent classes and resolves them by agent and task name", () => {
    @Module({ agents: [SystemAnalystAgent] })
    class AnalystModule {}

    const registry = AgentRegistry.fromModules([AnalystModule]);
    const agent = registry.requireAgent("system-analyst");
    const task = registry.requireTask("system-analyst", "prepare-requirements");

    expect(agent.tasks).toHaveLength(1);
    expect(task.metadata.name).toBe("prepare-requirements");
    expect(task.metadata.methodName).toBe("prepareRequirements");
    expect(task.agent.metadata.name).toBe("system-analyst");
  });

  test("can resolve catalog metadata from a generated metadata index", () => {
    @Module({ agents: [ProductDesignerAgent] })
    class ProductModule {}

    const generatedMetadata: AgentMetadataIndex = Object.freeze({
      agents: new Map([
        [
          ProductDesignerAgent,
          Object.freeze({
            name: "generated-product-designer",
            instructions: Object.freeze([]),
            constraints: Object.freeze([]),
            sections: Object.freeze([]),
            prompt: ProductDesignerPrompt,
            tools: Object.freeze([SearchCatalogTool]),
            tasks: Object.freeze([]),
          }),
        ],
      ]),
      tools: new Map([
        [
          SearchCatalogTool,
          Object.freeze({
            name: "generated.catalog.search",
            description: "Generated search metadata.",
            sideEffect: "read",
            approval: "policy",
            tags: Object.freeze([]),
          }),
        ],
      ]),
      prompts: new Map([
        [
          ProductDesignerPrompt,
          Object.freeze({
            name: "generated.product.designer",
            instructions: Object.freeze([]),
            constraints: Object.freeze([]),
            sections: Object.freeze([]),
          }),
        ],
      ]),
    });

    const catalog = collectAgentCatalog([ProductModule], {}, generatedMetadata);
    expect(catalog.agents[0]?.metadata.name).toBe("generated-product-designer");
    expect(catalog.agents[0]?.tools[0]?.metadata.name).toBe("generated.catalog.search");
    expect(catalog.agents[0]?.prompt?.metadata.name).toBe("generated.product.designer");
  });

  test("generated metadata file is importable and usable by AgentRegistry", async () => {
    @Module({})
    class EmptyModule {}

    expect(GENERATED_AGENT_METADATA.agents).not.toBeInstanceOf(Map);
    expect(GENERATED_AGENT_METADATA.tools).not.toBeInstanceOf(Map);
    expect(GENERATED_AGENT_METADATA.prompts).not.toBeInstanceOf(Map);
    let callbackMap: ReadonlyMap<unknown, unknown> | undefined;
    GENERATED_AGENT_METADATA.agents.forEach((_value, _key, map) => { callbackMap = map; });
    // Empty generated catalogs still prove that the facade cannot be used as a
    // mutable Map or leak the backing map through the Map API.
    expect(callbackMap ?? GENERATED_AGENT_METADATA.agents).toBe(GENERATED_AGENT_METADATA.agents);
    expect(() => Map.prototype.set.call(GENERATED_AGENT_METADATA.agents, EmptyModule, {})).toThrow();

    const registry = await AgentRegistry.fromGeneratedModules([EmptyModule]);
    expect(registry.listAgents()).toEqual([]);
  });

  test("fails fast when a listed agent is missing @Agent", () => {
    class PlainAgent {}

    @Module({ agents: [PlainAgent] })
    class BrokenModule {}

    expect(() => collectAgentCatalog([BrokenModule])).toThrow(/not decorated with @Agent/);
  });

  test("fails fast on duplicate tool names", () => {
    @Tool({ name: "catalog.search", description: "First search tool." })
    class FirstSearchTool {}

    @Tool({ name: "catalog.search", description: "Second search tool." })
    class SecondSearchTool {}

    @Module({ tools: [FirstSearchTool, SecondSearchTool] })
    class BrokenModule {}

    expect(() => collectAgentCatalog([BrokenModule])).toThrow(/Duplicate tool name "catalog.search"/);
  });

  test("fails fast on duplicate task names within one agent", () => {
    @Agent({ name: "duplicate-task-agent" })
    class DuplicateTaskAgent {
      @Task("prepare")
      first(): string {
        return agentOutput();
      }

      @Task("prepare")
      second(): string {
        return agentOutput();
      }
    }

    @Module({ agents: [DuplicateTaskAgent] })
    class BrokenModule {}

    expect(() => collectAgentCatalog([BrokenModule])).toThrow(/Duplicate task name "prepare"/);
  });

  test("takes a catalog snapshot with task backlinks bound to its own agent", () => {
    @Agent({ name: "snapshot-agent" })
    class SnapshotAgent {
      @Task("snapshot-task")
      run(): never { return agentOutput(); }
    }
    @Module({ agents: [SnapshotAgent] })
    class SnapshotModule {}
    const source = collectAgentCatalog([SnapshotModule]);
    const registry = new AgentRegistry(source);
    const agent = registry.requireAgent("snapshot-agent");
    const task = registry.requireTask("snapshot-agent", "snapshot-task");
    expect(task.agent).toBe(agent);
    expect(task.agent.tasks).toContain(task);
    expect(registry.listAgents()).not.toBe(source.agents);
  });

  test("snapshots mutable source definitions by identity without losing agent-local references", () => {
    class SharedTool {}
    class LocalTool {}
    class SharedPrompt {}
    class LocalPrompt {}
    class SharedAgent {}
    class LocalAgent {}
    const sharedToolMetadata = { name: "shared-tool", description: "shared original", sideEffect: "read" as const, approval: "policy" as const, tags: ["shared"] } satisfies ToolMetadata;
    const localToolMetadata = { name: "local-tool", description: "local original", sideEffect: "read" as const, approval: "policy" as const, tags: ["local"] } satisfies ToolMetadata;
    const sharedPromptMetadata = { name: "shared-prompt", instructions: ["shared original"], constraints: [], sections: [] } satisfies PromptMetadata;
    const localPromptMetadata = { name: "local-prompt", instructions: ["local original"], constraints: [], sections: [] } satisfies PromptMetadata;
    const sharedTool: ToolDefinition = { target: SharedTool, metadata: sharedToolMetadata };
    const localTool: ToolDefinition = { target: LocalTool, metadata: localToolMetadata };
    const sharedPrompt: PromptDefinition = { target: SharedPrompt, metadata: sharedPromptMetadata };
    const localPrompt: PromptDefinition = { target: LocalPrompt, metadata: localPromptMetadata };
    const listedTaskMetadata = { name: "listed-task", methodName: "listed" } satisfies AgentTaskMetadata;
    const actualTaskMetadata = { name: "actual-task", methodName: "actual" } satisfies AgentTaskMetadata;
    const sourceSharedAgent = {
      target: SharedAgent,
      metadata: { name: "shared-agent", instructions: ["shared"], constraints: [], sections: [], prompt: SharedPrompt, tools: [SharedTool], tasks: [listedTaskMetadata] },
      prompt: sharedPrompt,
      tools: [sharedTool],
      tasks: [] as AgentTaskDefinition[],
    };
    sourceSharedAgent.tasks.push({ agent: sourceSharedAgent, metadata: actualTaskMetadata });
    const sourceLocalAgent = {
      target: LocalAgent,
      metadata: { name: "local-agent", instructions: ["local"], constraints: [], sections: [], prompt: LocalPrompt, tools: [LocalTool], tasks: [] },
      prompt: localPrompt,
      tools: [localTool],
      tasks: [],
    } satisfies AgentDefinition;
    const catalog: AgentCatalog = { agents: [sourceSharedAgent, sourceLocalAgent], tools: [sharedTool], prompts: [sharedPrompt] };
    const registry = new AgentRegistry(catalog);

    sharedToolMetadata.description = "mutated";
    sharedToolMetadata.tags.push("mutated");
    localToolMetadata.description = "mutated";
    localToolMetadata.tags.push("mutated");
    sharedPromptMetadata.instructions.push("mutated");
    localPromptMetadata.instructions.push("mutated");
    actualTaskMetadata.name = "mutated-task";
    sourceSharedAgent.metadata.tools.push(LocalTool);

    const sharedAgent = registry.requireAgent("shared-agent");
    const localAgent = registry.requireAgent("local-agent");
    expect(sharedAgent.target).toBe(SharedAgent);
    expect(localAgent.target).toBe(LocalAgent);
    expect(sharedAgent.tools[0]).toBe(registry.requireTool("shared-tool"));
    expect(sharedAgent.prompt).toBe(registry.requirePrompt("shared-prompt"));
    expect(localAgent.tools[0]?.target).toBe(LocalTool);
    expect(localAgent.prompt?.target).toBe(LocalPrompt);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listPrompts()).toHaveLength(1);
    expect(sharedAgent.tools[0]?.metadata).toMatchObject({ description: "shared original", tags: ["shared"] });
    expect(localAgent.tools[0]?.metadata).toMatchObject({ description: "local original", tags: ["local"] });
    expect(sharedAgent.prompt?.metadata.instructions).toEqual(["shared original"]);
    expect(localAgent.prompt?.metadata.instructions).toEqual(["local original"]);
    expect(sharedAgent.metadata.tasks[0]?.name).toBe("listed-task");
    expect(sharedAgent.tasks[0]?.metadata.name).toBe("actual-task");
    expect(sharedAgent.tasks[0]?.agent).toBe(sharedAgent);
    expect(Object.isFrozen(sharedAgent.tasks[0]?.metadata)).toBe(true);
  });
});
