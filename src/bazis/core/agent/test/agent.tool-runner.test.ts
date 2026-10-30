import { describe, expect, test } from "bun:test";
import { Module, createContainer } from "@/core/di";
import { Validator } from "@/library/validation";
import { AgentSetupError, Tool, ToolRunner, type AgentToolApprovalRequest, type AgentToolAuditEntry, type AgentToolExecutionContext } from "../index";
import { withToolExecution } from "./toolExecution.fixture";

// 0.123.0 (TOOLS-001): the framework registers ToolRunner for any module with
// Tools; code binds it with as(caller) and sees only Tools whose callers list
// that id. Tags never decide access.
class GreetInput {
  @Validator({ required: true, minLength: 2 })
  name!: string;
}

class GreetOutput {
  @Validator({ required: true })
  text!: string;
}

@Tool({ name: "runner.greet", description: "Greets by name.", input: GreetInput, output: GreetOutput, sideEffect: "read", callers: ["agent", "workflow"], tags: ["greeting"] })
class GreetTool {
  execute(input: GreetInput, context: AgentToolExecutionContext): GreetOutput {
    return { text: `Hello, ${input.name}${context.metadata.suffix ?? ""}` };
  }
}

const written: string[] = [];

@Tool({ name: "runner.write", description: "Writes a value.", input: GreetInput, sideEffect: "write", callers: ["workflow"], tags: ["data"] })
class WriteTool {
  execute(input: GreetInput): object {
    written.push(input.name);
    return {};
  }
}

// Tagged like a process step, but only agents may call it.
@Tool({ name: "runner.admin", description: "Agents only.", sideEffect: "read", callers: ["agent"], tags: ["data"] })
class AdminTool {
  execute(): object { return {}; }
}

@Module({ tools: [GreetTool, WriteTool, AdminTool] })
class ToolsModule {}

describe("ToolRunner", () => {
  test("is registered by the framework; a caller sees only its Tools, tags only narrow the list", async () => {
    const container = createContainer(ToolsModule);
    try {
      const workflow = container.resolve(ToolRunner).as("workflow");
      expect(workflow.caller).toBe("workflow");
      expect(workflow.listTools().map((tool) => tool.metadata.name).sort()).toEqual(["runner.greet", "runner.write"]);
      expect(workflow.listTools(["data"]).map((tool) => tool.metadata.name)).toEqual(["runner.write"]);
      expect(workflow.getTool("runner.admin")).toBeUndefined();
      expect(workflow.describe("runner.admin")).toBeUndefined();
      expect(JSON.stringify(workflow.describe("runner.greet")!.input)).toContain("name");
    } finally { await container.dispose(); }
  });

  test("runs a Tool, validates input and refuses a Tool the caller may not run", async () => {
    const container = createContainer(ToolsModule);
    try {
      const workflow = container.resolve(ToolRunner).as("workflow");
      const ok = await workflow.run("runner.greet", { name: "Alex" }, { callId: "call-1", metadata: { suffix: "!" } });
      expect(ok.status === "success" ? ok.output : ok.status).toEqual({ text: "Hello, Alex!" });
      expect(ok.callId).toBe("call-1");

      const invalid = await workflow.run("runner.greet", { name: "A" });
      expect(invalid.status === "error" ? invalid.error?.code : invalid.status).toBe("TOOL_INPUT_VALIDATION_FAILED");

      // The name may come from data (a stored process); the caller decides.
      const refused = await workflow.run("runner.admin", {});
      expect(refused.status).toBe("denied");
      expect(refused.error?.code).toBe("TOOL_CALLER_NOT_ALLOWED");

      expect((await workflow.run("runner.missing", {})).status).toBe("error");
    } finally { await container.dispose(); }
  });

  test("a write Tool needs the actor; caller and actor reach approval and audit", async () => {
    written.length = 0;
    const approvals: AgentToolApprovalRequest[] = [];
    const audit: AgentToolAuditEntry[] = [];
    const container = createContainer(withToolExecution(ToolsModule, {
      auditSink: (entry) => { audit.push(entry); },
      approvalPolicy: (request) => { approvals.push(request); return request.actor?.id !== "intruder"; },
    }));
    try {
      const workflow = container.resolve(ToolRunner).as("workflow");
      const anonymous = await workflow.run("runner.write", { name: "x1" });
      expect(anonymous.status === "error" ? anonymous.error?.code : anonymous.status).toBe("TOOL_ACTOR_REQUIRED");

      const ok = await workflow.run("runner.write", { name: "yes" }, { actor: { kind: "user", id: "u-1" }, idempotencyKey: "instance-1:step-2" });
      expect(ok.status).toBe("success");
      const denied = await workflow.run("runner.write", { name: "no" }, { actor: { kind: "user", id: "intruder" } });
      expect(denied.status).toBe("denied");
      expect(written).toEqual(["yes"]);

      expect(approvals[0]).toMatchObject({ caller: "workflow", actor: { kind: "user", id: "u-1" }, idempotencyKey: "instance-1:step-2" });
      expect(audit.find((entry) => entry.toolName === "runner.write")).toMatchObject({ caller: "workflow", actor: { kind: "user", id: "u-1" } });
    } finally { await container.dispose(); }
  });

  test("as() takes a caller id; agents do not use the runner", async () => {
    const container = createContainer(ToolsModule);
    try {
      const runner = container.resolve(ToolRunner);
      expect(() => runner.as("agent")).toThrow(AgentSetupError);
      expect(() => runner.as("agent")).toThrow('ToolRunner.as("agent"): agents run Tools through AgentRuntime.');
      expect(() => runner.as("Work Flow")).toThrow('ToolRunner.as("Work Flow"): a caller id is lower-case, such as "workflow".');
    } finally { await container.dispose(); }
  });

  test("a Tool without callers stops the build with the fix", () => {
    @Tool({ name: "runner.orphan", description: "Nobody may call it.", sideEffect: "read" } as never)
    class OrphanTool { execute(): object { return {}; } }
    @Module({ tools: [OrphanTool] })
    class OrphanModule {}
    expect(() => createContainer(OrphanModule)).toThrow('Tool "runner.orphan" (OrphanTool) declares no callers: list who may call it, for example callers: ["agent"] for LLM agents or ["workflow"] for a process engine.');
  });
});
