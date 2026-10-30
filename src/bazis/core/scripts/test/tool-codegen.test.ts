import { describe, expect, test } from "bun:test";
import { collectToolSchemaModels, type ToolCodegenSource } from "../tool-codegen";

function source(filePath: string, content: string): ToolCodegenSource {
  return { filePath, content };
}

describe("tool schema codegen", () => {
  test("collects input and output classes of exported @Tool declarations", () => {
    const result = collectToolSchemaModels([
      source("src/app/catalog/Search.tool.ts", `
        export class SearchInput {}
        export class SearchOutput {}
        @Tool({ callers: ["agent"], name: "catalog.search", description: "Searches.", input: SearchInput, output: SearchOutput, sideEffect: "read" })
        export class SearchCatalogTool {}
        @Tool({ callers: ["agent"], name: "catalog.ping", description: "No contracts." })
        export class PingTool {}
      `),
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.toolCount).toBe(2);
    expect(result.schemaNames).toEqual(["SearchInput", "SearchOutput"]);
    expect(result.schemaModels.map((declaration) => declaration.name?.text)).toEqual(["SearchInput", "SearchOutput"]);
  });

  test("uses the OpenAPI naming policy for schema names", () => {
    const result = collectToolSchemaModels([
      source("src/app/a.ts", `export class Query {}\n@Tool({ callers: ["agent"], name: "a", description: "A.", input: Query }) export class ATool {}`),
    ], { schemaNameForDeclaration: (name) => `App.${name}` });
    expect(result.schemaNames).toEqual(["App.Query"]);
  });

  test("warns about non-exported tools, dynamic contracts and ambiguous class names", () => {
    const result = collectToolSchemaModels([
      source("src/app/one.ts", `
        export class Shared {}
        @Tool({ callers: ["agent"], name: "private", description: "Private." }) class PrivateTool {}
        @Tool({ callers: ["agent"], name: "dynamic", description: "Dynamic.", input: contracts.input }) export class DynamicTool {}
        @Tool({ callers: ["agent"], name: "shared", description: "Shared.", input: Shared }) export class SharedTool {}
      `),
      source("src/app/two.ts", "export class Shared {}"),
    ]);

    const warnings = result.warnings.join("\n");
    expect(warnings).toContain('@Tool class "PrivateTool"');
    expect(warnings).toContain("not a named export");
    expect(warnings).toContain("DynamicTool");
    expect(warnings).toContain("input must be a class identifier");
    expect(warnings).toContain('input class "Shared" is declared in more than one file');
    expect(result.schemaNames).toEqual([]);
    expect(result.toolCount).toBe(2);
  });

  test("ignores @Agent, @Task and @Prompt: agents are data, not classes", () => {
    const result = collectToolSchemaModels([
      source("src/app/legacy.ts", `
        export class Input {}
        @Agent({ name: "old", input: Input }) export class OldAgent {}
      `),
    ]);
    expect(result).toMatchObject({ warnings: [], toolCount: 0, schemaNames: [] });
  });
});
