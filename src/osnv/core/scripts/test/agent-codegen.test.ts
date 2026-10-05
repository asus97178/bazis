import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateAgentMetadataCatalog, type AgentCodegenSource } from "../agent-codegen";

function source(filePath: string, content: string): AgentCodegenSource {
  return { filePath, content };
}

describe("agent metadata codegen", () => {
  test("renders generated metadata for exported agents, tools and prompts", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/product.ts",
        `
          export class SearchInput {}
          export class SearchOutput {}

          @Prompt({
            name: "product.designer",
            role: "Product designer",
            instructions: ["Prefer acceptance criteria."],
            constraints: ["Never mutate data."],
            sections: [
              {
                kind: "developer",
                title: "Delivery Rules",
                content: ["Keep changes reviewable.", "Prefer reversible actions."],
              },
              {
                kind: "tool-policy",
                content: "Use read tools before write tools.",
              },
            ],
          })
          export class ProductPrompt {}

          @Tool({
            name: "catalog.search",
            description: "Find products.",
            input: SearchInput,
            output: SearchOutput,
            sideEffect: "read",
            timeoutMs: 500,
            tags: ["catalog"],
          })
          export class SearchTool {}

          @Tool({
            name: "catalog.reindex",
            description: "Rebuilds the catalog index.",
            sideEffect: "write",
          })
          export class ReindexTool {}

          @Agent({
            name: "product-agent",
            description: "Creates product artifacts.",
            goal: "Help the operator manage the catalog.",
            instructions: ["Answer briefly.", "Do not invent data."],
            constraints: ["Use only registered tools."],
            sections: [
              {
                kind: "tool-policy",
                content: "Call read tools before the final answer.",
              },
            ],
            prompt: ProductPrompt,
            tools: [SearchTool, ReindexTool],
            input: SearchInput,
            output: SearchOutput,
            maxSteps: 4,
          })
          export class ProductAgent {
            @Task({
              name: "prepare-requirements",
              description: "Prepare product requirements.",
              modelProfile: "reasoning",
              maxSteps: 3,
            })
            prepareRequirements(input: SearchInput): SearchOutput {
              throw new Error("framework marker");
            }
          }
        `,
      ),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.agentCount).toBe(1);
    expect(result.toolCount).toBe(2);
    expect(result.promptCount).toBe(1);
    expect(result.schemaNames).toEqual(["SearchInput", "SearchOutput"]);
    expect(result.output).toContain('from "../../../../app/agents/product"');
    expect(result.output).toContain('[ProductAgent, Object.freeze({ name: "product-agent"');
    expect(result.output).toContain('goal: "Help the operator manage the catalog."');
    expect(result.output).toContain('instructions: Object.freeze(["Answer briefly.", "Do not invent data."])');
    expect(result.output).toContain('constraints: Object.freeze(["Use only registered tools."])');
    expect(result.output).toContain('sections: Object.freeze([Object.freeze({ kind: "tool-policy"');
    expect(result.output).toContain('tools: Object.freeze([SearchTool, ReindexTool])');
    expect(result.output).toContain('tasks: Object.freeze([Object.freeze({ name: "prepare-requirements"');
    expect(result.output).toContain('methodName: "prepareRequirements"');
    expect(result.output).toContain('description: "Prepare product requirements."');
    expect(result.output).toContain('input: SearchInput');
    expect(result.output).toContain('output: SearchOutput');
    expect(result.output).toContain('modelProfile: "reasoning"');
    expect(result.output).toContain('approval: "required"');
    expect(result.output).toContain('instructions: Object.freeze(["Prefer acceptance criteria."])');
    expect(result.output).toContain('sections: Object.freeze([Object.freeze({ kind: "developer"');
    expect(result.output).toContain('title: "Delivery Rules"');
    expect(result.output).toContain('content: Object.freeze(["Keep changes reviewable.", "Prefer reversible actions."])');
    expect(result.output).toContain('kind: "tool-policy"');
  });

  test("uses class names as default agent and prompt names", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/defaults.ts",
        `
          @Prompt()
          export class DefaultPrompt {}

          @Agent()
          export class DefaultAgent {}
        `,
      ),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.agentCount).toBe(1);
    expect(result.promptCount).toBe(1);
    expect(result.output).toContain('name: "DefaultAgent"');
    expect(result.output).toContain('name: "DefaultPrompt"');
  });

  test("rejects write or external tools that opt out of approval", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/unsafe.ts",
        `
          @Tool({
            name: "catalog.delete",
            description: "Deletes products.",
            sideEffect: "write",
            approval: "never",
          })
          export class DeleteTool {}
        `,
      ),
    ]);

    expect(result.toolCount).toBe(0);
    expect(result.output).not.toContain("DeleteTool");
    expect(result.warnings.join("\n")).toContain('write/external tools cannot use approval: "never"');
  });

  test("omits non-exported decorated classes and agents that reference non-exported classes", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/private-tool.ts",
        `
          @Tool({ name: "catalog.private", description: "Private tool." })
          class PrivateTool {}

          @Agent({ name: "private-agent", tools: [PrivateTool] })
          export class PrivateAgent {}
        `,
      ),
    ]);

    expect(result.agentCount).toBe(0);
    expect(result.toolCount).toBe(0);
    expect(result.output).not.toContain("PrivateAgent");
    expect(result.warnings.join("\n")).toContain("PrivateTool");
    expect(result.warnings.join("\n")).toContain("not a named export");
  });

  test("warns and skips dynamic decorator options", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/dynamic.ts",
        `
          const options = { name: "dynamic-agent" };

          @Agent(options)
          export class DynamicAgent {}
        `,
      ),
    ]);

    expect(result.agentCount).toBe(0);
    expect(result.output).not.toContain("DynamicAgent");
    expect(result.warnings.join("\n")).toContain("object literal options only");
  });

  test("omits ambiguous class names instead of generating unsafe imports", () => {
    const result = generateAgentMetadataCatalog([
      source(
        "src/app/agents/one.ts",
        `
          @Prompt({ name: "one" })
          export class SharedPrompt {}
        `,
      ),
      source(
        "src/app/agents/two.ts",
        `
          @Prompt({ name: "two" })
          export class SharedPrompt {}

          @Agent({ name: "ambiguous-agent", prompt: SharedPrompt })
          export class AmbiguousAgent {}
        `,
      ),
    ]);

    expect(result.agentCount).toBe(0);
    expect(result.promptCount).toBe(0);
    expect(result.output).not.toContain("AmbiguousAgent");
    expect(result.warnings.join("\n")).toContain('ambiguous referenced class "SharedPrompt"');
  });

  test("emits a nonempty immutable metadata-map facade", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "osnv-agent-codegen-"));
    try {
      const fixturePath = path.join(tempRoot, "fixture.ts");
      const generatedDir = path.join(tempRoot, "generated");
      const generatedPath = path.join(generatedDir, "catalog.ts");
      await Bun.write(fixturePath, `
        export class CatalogInput {}
        export class CatalogOutput {}
        export class CatalogPrompt {}
        export class CatalogTool {}
        export class CatalogAgent {}
      `);
      const inputs = [source(fixturePath, `
        @Prompt({ name: "catalog-prompt", instructions: ["Be precise."] })
        export class CatalogPrompt {}
        @Tool({ name: "catalog.search", description: "Search catalog.", input: CatalogInput, output: CatalogOutput, sideEffect: "read" })
        export class CatalogTool {}
        @Agent({ name: "catalog-agent", prompt: CatalogPrompt, tools: [CatalogTool], input: CatalogInput, output: CatalogOutput })
        export class CatalogAgent {}
        export class CatalogInput {}
        export class CatalogOutput {}
      `)];
      const first = generateAgentMetadataCatalog(inputs, { generatedDir, frameworkImports: "public" });
      const second = generateAgentMetadataCatalog(inputs, { generatedDir, frameworkImports: "public" });
      expect(first.warnings).toEqual([]);
      expect(first.output).toBe(second.output);
      await mkdir(generatedDir, { recursive: true });
      await Bun.write(generatedPath, first.output);

      const fixture = await import(fixturePath);
      const generated = await import(`${generatedPath}?catalog=nonempty`);
      const catalog = generated.GENERATED_AGENT_METADATA as {
        readonly agents: ReadonlyMap<object, { readonly name: string }>;
        readonly tools: ReadonlyMap<object, { readonly name: string }>;
        readonly prompts: ReadonlyMap<object, { readonly name: string }>;
      };
      const maps = [catalog.agents, catalog.tools, catalog.prompts] as const;
      expect(catalog.agents.size).toBe(1);
      expect(catalog.agents.has(fixture.CatalogAgent)).toBe(true);
      expect(catalog.agents.get(fixture.CatalogAgent)?.name).toBe("catalog-agent");
      expect([...catalog.agents.entries()].map(([key, value]) => [key, value.name])).toEqual([[fixture.CatalogAgent, "catalog-agent"]]);
      expect([...catalog.tools.keys()]).toEqual([fixture.CatalogTool]);
      expect([...catalog.prompts.values()].map((value) => value.name)).toEqual(["catalog-prompt"]);

      let callbackCount = 0;
      let callbackMap: ReadonlyMap<object, { readonly name: string }> | undefined;
      catalog.agents.forEach((value, key, map) => {
        callbackCount += 1;
        expect(key).toBe(fixture.CatalogAgent);
        expect(value.name).toBe("catalog-agent");
        callbackMap = map;
      });
      expect(callbackCount).toBe(1);
      expect(callbackMap).toBe(catalog.agents);
      for (const map of maps) {
        expect(Object.isFrozen(map)).toBe(true);
        expect(() => Map.prototype.set.call(map, fixture.CatalogAgent, { name: "mutated" })).toThrow();
        expect(() => Map.prototype.delete.call(map, fixture.CatalogAgent)).toThrow();
        expect(() => Map.prototype.clear.call(map)).toThrow();
      }
      expect(catalog.agents.get(fixture.CatalogAgent)?.name).toBe("catalog-agent");
      expect(catalog.tools.get(fixture.CatalogTool)?.name).toBe("catalog.search");
      expect(catalog.prompts.get(fixture.CatalogPrompt)?.name).toBe("catalog-prompt");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
