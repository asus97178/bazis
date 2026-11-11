import { expect, test } from "bun:test";
import { Module, createContainer, singleton } from "@/core/di";
import { AgentSetupError, Tool, ToolRunner, defineTool, isDefinedTool, toolNameOf, type DefinedTool, type ToolSet } from "../index";

// 0.138.0: a Tool made by a function is defineTool(...); a module lists made
// Tools and sets of them next to its classes with @Tool.
class Reports {
  export(id: string, format: string): string { return `${id}.${format}`; }
}

@Tool({ name: "reports.send", description: "Sends a report.", sideEffect: "read", callers: ["workflow"] })
class SendReportTool {
  execute(): object { return { sent: true }; }
}

function exportTools<const F extends string>(formats: readonly F[]): ToolSet<F> {
  return Object.fromEntries(formats.map((format) => [format, defineTool({
    name: `reports.export.${format}`,
    description: `Exports a report as ${format}.`,
    sideEffect: "read",
    callers: ["workflow"],
    inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] },
    execute: (input: { reportId: string }, _context, services) => ({ file: services.resolve(Reports).export(input.reportId, format) }),
  })])) as ToolSet<F>;
}

const exports = exportTools(["pdf", "csv"]);
const ping: DefinedTool<unknown, { pong: true }> = defineTool({ name: "reports.ping", description: "Answers.", sideEffect: "none", callers: ["workflow"], execute: () => ({ pong: true as const }) });

@Module({ tools: [SendReportTool, ping, exports], providers: [singleton(Reports)] })
class ReportsModule {}

test("a made Tool carries its name and is told from a class", () => {
  expect(exports.pdf.toolName).toBe("reports.export.pdf");
  expect(toolNameOf(exports.csv)).toBe("reports.export.csv");
  expect(toolNameOf(SendReportTool)).toBe("reports.send");
  expect(toolNameOf(Reports)).toBeUndefined();
  expect(isDefinedTool(ping)).toBe(true);
  expect(isDefinedTool(SendReportTool)).toBe(false);
});

test("a module lists classes, made Tools and sets of them; each runs with the services of its call", async () => {
  const container = createContainer(ReportsModule);
  try {
    const workflow = container.resolve(ToolRunner).as("workflow");
    expect(workflow.listTools().map((tool) => tool.metadata.name).sort()).toEqual(["reports.export.csv", "reports.export.pdf", "reports.ping", "reports.send"]);
    const made = await workflow.run("reports.export.pdf", { reportId: "r-1" });
    expect(made.status === "success" ? made.output : made).toEqual({ file: "r-1.pdf" });
    const answered = await workflow.run("reports.ping", {});
    expect(answered.status === "success" ? answered.output : answered).toEqual({ pong: true });
    // The schema describes the Tool to its callers.
    expect(JSON.stringify(workflow.describe("reports.export.csv")!.input)).toContain("reportId");
  } finally {
    await container.dispose();
  }
});

test("what is not a Tool is refused when the module is read", () => {
  @Module({ tools: [{ pdf: exports.pdf, other: Reports }] as never })
  class MixedSet {}
  expect(() => createContainer(MixedSet)).toThrow("an object in the list must hold only Tools made by defineTool");

  @Module({ tools: [Reports] })
  class NotATool {}
  expect(() => createContainer(NotATool)).toThrow("Reports is listed as a tool but is not decorated with @Tool(...)");

  expect(() => defineTool({ name: "x.y", description: "No work." } as never)).toThrow(AgentSetupError);
  expect(() => defineTool({ name: "", description: "No name.", callers: ["workflow"], execute: () => ({}) })).toThrow("@Tool.name must be a non-empty string.");
});
