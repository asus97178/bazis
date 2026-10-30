import { describe, expect, test } from "bun:test";
import { Module, createContainer, singletonValue } from "@/core/di";
import { Validator } from "@/library/validation";
import { TOOL_RUNNER_OPTIONS, Tool, ToolRunner, toolRunnerProviders, type AgentToolExecutionContext, type ToolRunnerOptions } from "../index";

class GreetInput {
  @Validator({ required: true, minLength: 2 })
  name!: string;
}

class GreetOutput {
  @Validator({ required: true })
  text!: string;
}

@Tool({ name: "runner.greet", description: "Greets by name.", input: GreetInput, output: GreetOutput, sideEffect: "read", tags: ["workflow"] })
class GreetTool {
  execute(input: GreetInput, context: AgentToolExecutionContext): GreetOutput {
    return { text: `Hello, ${input.name}${context.metadata.suffix ?? ""}` };
  }
}

const written: string[] = [];

@Tool({ name: "runner.write", description: "Writes a value.", input: GreetInput, sideEffect: "write", tags: ["workflow", "data"] })
class WriteTool {
  execute(input: GreetInput): object {
    written.push(input.name);
    return {};
  }
}

@Tool({ name: "runner.hidden", description: "Not for processes.", sideEffect: "read" })
class HiddenTool {
  execute(): object { return {}; }
}

function app(options?: ToolRunnerOptions) {
  @Module({
    tools: [GreetTool, WriteTool, HiddenTool],
    providers: [...toolRunnerProviders, ...(options === undefined ? [] : [singletonValue(TOOL_RUNNER_OPTIONS, options)])],
    exports: [ToolRunner],
  })
  class ToolsModule {}
  return createContainer(ToolsModule);
}

describe("ToolRunner", () => {
  test("lists Tools by tags and describes their contracts", async () => {
    const container = app();
    try {
      const runner = container.resolve(ToolRunner);
      expect(runner.listTools().map((tool) => tool.metadata.name).sort()).toEqual(["runner.greet", "runner.hidden", "runner.write"]);
      expect(runner.listTools(["workflow"]).map((tool) => tool.metadata.name).sort()).toEqual(["runner.greet", "runner.write"]);
      expect(runner.listTools(["workflow", "data"]).map((tool) => tool.metadata.name)).toEqual(["runner.write"]);
      expect(runner.getTool("runner.greet")?.metadata.sideEffect).toBe("read");
      expect(runner.describe("runner.missing")).toBeUndefined();
      const contract = runner.describe("runner.greet")!;
      expect(contract.name).toBe("runner.greet");
      expect(JSON.stringify(contract.input)).toContain("name");
    } finally { await container.dispose(); }
  });

  test("runs a Tool without an agent and validates its input", async () => {
    const container = app();
    try {
      const runner = container.resolve(ToolRunner);
      const ok = await runner.run("runner.greet", { name: "Alex" }, { callId: "call-1", metadata: { suffix: "!" } });
      expect(ok.status).toBe("success");
      expect(ok.callId).toBe("call-1");
      expect(ok.status === "success" ? ok.output : null).toEqual({ text: "Hello, Alex!" });

      const invalid = await runner.run("runner.greet", { name: "A" });
      expect(invalid.status).toBe("error");
      expect(invalid.status === "error" ? invalid.error?.code : null).toBe("TOOL_INPUT_VALIDATION_FAILED");

      const unknown = await runner.run("runner.missing", {});
      expect(unknown.status).toBe("error");
    } finally { await container.dispose(); }
  });

  test("keeps the approval and audit gates for side effects", async () => {
    written.length = 0;
    const plain = app();
    try {
      const result = await plain.resolve(ToolRunner).run("runner.write", { name: "x1" });
      expect(result.status === "error" ? result.error?.code : result.status).toBe("TOOL_AUDIT_REQUIRED");
    } finally { await plain.dispose(); }

    const audited: string[] = [];
    const approved = app({
      auditSink: (entry) => { audited.push(`${entry.phase}:${entry.toolName}`); },
      approvalPolicy: (request) => request.call.input !== null && (request.call.input as { name?: string }).name !== "no",
    });
    try {
      const runner = approved.resolve(ToolRunner);
      expect((await runner.run("runner.write", { name: "yes" })).status).toBe("success");
      expect((await runner.run("runner.write", { name: "no" })).status).toBe("denied");
      expect(written).toEqual(["yes"]);
      expect(audited.some((line) => line.endsWith(":runner.write"))).toBe(true);
    } finally { await approved.dispose(); }
  });
});
