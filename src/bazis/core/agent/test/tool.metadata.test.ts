import { describe, expect, test } from "bun:test";
import { Module, createContainer, scoped } from "@/core/di";
import { AgentSetupError, Tool, toolMetadataOf } from "../index";
import { AgentRegistry } from "../AgentRegistry";

class SearchInput { query = ""; }

@Tool({
  callers: ["agent"], name: "catalog.search",
  description: "Find products in the catalog.",
  input: SearchInput,
  sideEffect: "read",
  timeoutMs: 500,
  tags: ["catalog"],
})
class SearchCatalogTool {}

describe("tool metadata", () => {
  test("@Tool.dryRun takes supported or unsupported", () => {
    @Tool({ name: "catalog.preview", description: "Shows what would change.", dryRun: "supported", callers: ["workflow"] })
    class PreviewTool {}
    expect(toolMetadataOf(PreviewTool)?.dryRun).toBe("supported");
    expect(() => {
      @Tool({ name: "catalog.wrong", description: "Wrong.", dryRun: "maybe" as never, callers: ["workflow"] })
      class WrongTool {}
      return WrongTool;
    }).toThrow("@Tool.dryRun must be supported or unsupported.");
  });

  test("@Tool writes normalized class metadata", () => {
    expect(toolMetadataOf(SearchCatalogTool)).toEqual({
      name: "catalog.search",
      description: "Find products in the catalog.",
      input: SearchInput,
      output: undefined,
      sideEffect: "read",
      approval: "policy",
      timeoutMs: 500,
      dryRun: "unsupported",
      callers: ["agent"],
      tags: ["catalog"],
    });
    expect(Object.isFrozen(toolMetadataOf(SearchCatalogTool))).toBe(true);
    expect(toolMetadataOf(class Plain {})).toBeUndefined();
  });

  test("write and external tools require approval by default", () => {
    @Tool({ callers: ["agent"], name: "catalog.reindex", description: "Rebuilds the product search index.", sideEffect: "write" })
    class ReindexTool {}
    @Tool({ callers: ["agent"], name: "mail.send", description: "Sends an email.", sideEffect: "external" })
    class SendMailTool {}

    expect(toolMetadataOf(ReindexTool)?.approval).toBe("required");
    expect(toolMetadataOf(SendMailTool)?.approval).toBe("required");
  });

  test("an unsafe tool cannot opt out of approval, and invalid options are setup errors", () => {
    expect(() => {
      @Tool({ callers: ["agent"], name: "catalog.delete", description: "Deletes a product.", sideEffect: "write", approval: "never" })
      class DeleteProductTool {}
      return DeleteProductTool;
    }).toThrow(AgentSetupError);
    for (const options of [
      { name: " ", description: "Blank name." },
      { name: "blank.description", description: "" },
      { name: "bad.timeout", description: "Timeout.", timeoutMs: 0 },
      { name: "bad.side-effect", description: "Side effect.", sideEffect: "delete" },
    ]) {
      expect(() => {
        @Tool(options as never)
        class Broken {}
        return Broken;
      }).toThrow(AgentSetupError);
    }
  });
});

describe("tool catalog", () => {
  test("collects @Module.tools from the whole module graph", () => {
    @Tool({ callers: ["agent"], name: "orders.find", description: "Finds an order.", sideEffect: "read" })
    class FindOrderTool {}
    @Module({ tools: [FindOrderTool], providers: [scoped(FindOrderTool)] })
    class OrdersModule {}
    @Module({ imports: [OrdersModule], tools: [SearchCatalogTool], providers: [scoped(SearchCatalogTool)] })
    class AppModule {}

    const container = createContainer(AppModule);
    try {
      const catalog = AgentRegistry.fromContainer(container);
      expect(catalog.listTools().map((tool) => tool.metadata.name).sort()).toEqual(["catalog.search", "orders.find"]);
      expect(catalog.requireTool("orders.find").target).toBe(FindOrderTool);
      expect(AgentRegistry.fromContainer(container)).toBe(catalog);
      expect(() => catalog.requireTool("missing")).toThrow('Tool "missing" is not registered.');
      expect(catalog.getAgent("anything")).toBeUndefined();
    } finally { void container.dispose(); }
  });

  test("fails fast on duplicate tool names", () => {
    @Tool({ callers: ["agent"], name: "catalog.search", description: "First search tool." })
    class FirstSearchTool {}
    @Tool({ callers: ["agent"], name: "catalog.search", description: "Second search tool." })
    class SecondSearchTool {}
    @Module({ tools: [FirstSearchTool, SecondSearchTool], providers: [scoped(FirstSearchTool), scoped(SecondSearchTool)] })
    class BrokenModule {}

    expect(() => createContainer(BrokenModule)).toThrow('Duplicate Tool registration "catalog.search".');
  });
});
