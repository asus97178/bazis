import { expect, test } from "bun:test";
import type { ToolExecutionOptions } from "../toolExecutionOptions";
import { withToolExecution } from "./toolExecution.fixture";
import { DI, Module, createContainer, scoped } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { LOGGER, type LogFields, type Logger } from "@/core/kernel/logging/Logger";
import { Infra, llmConnect } from "@/core/infra";
import {
  AgentRuntime,
  AgentToolPreCommitError,
  Tool,
  ToolError,
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelRequest,
} from "../index";

class MemoryLogger implements Logger {
  readonly errors: { message: string; fields?: LogFields }[] = [];
  debug() {}
  info() {}
  warn() {}
  error(message: string, fields?: LogFields) { this.errors.push({ message, fields }); }
}

let preCommitFailures = 0;

@Tool({ callers: ["agent"], name: "fail.crash", description: "Throws an unexpected error.", sideEffect: "read" })
class CrashTool { execute() { throw new Error("db host 10.0.0.5 is down, password=hunter2"); } }

@Tool({ callers: ["agent"], name: "fail.reply", description: "Reports a failure to the model.", sideEffect: "read" })
class ReplyTool { execute() { throw new ToolError("Товар kiwi снят с продажи"); } }

@Tool({ callers: ["agent"], name: "fail.write", description: "Throws after a write started.", sideEffect: "write" })
class CrashWriteTool { execute() { throw new Error("connection reset by 10.0.0.5"); } }

@Tool({ callers: ["agent"], name: "fail.precommit", description: "Fails before writing, once.", sideEffect: "write" })
class PreCommitTool {
  execute() {
    if (preCommitFailures-- > 0) throw new AgentToolPreCommitError("Платёжный шлюз занят");
    return { paid: true };
  }
}

@Tool({ callers: ["agent"], name: "fail.resolve", description: "Cannot be constructed.", sideEffect: "read" })
class BrokenConstructorTool {
  constructor() { throw new Error("missing secret key=abc123"); }
  execute() { return null; }
}

@Module({
  tools: [CrashTool, ReplyTool, CrashWriteTool, PreCommitTool, BrokenConstructorTool],
  providers: [scoped(CrashTool), scoped(ReplyTool), scoped(CrashWriteTool), scoped(PreCommitTool), scoped(BrokenConstructorTool)],
})
class FailuresModule {}

function callOnce(name: string, requests: AgentModelRequest[]): AgentModelProvider {
  return {
    complete(request) {
      requests.push(request);
      return requests.length === 1
        ? agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: [agentToolCall({ id: "c1", name, input: {} })] })
        : agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "ok") });
    },
  };
}

async function runTool(name: string, execution: ToolExecutionOptions = {}) {
  const container = createContainer(withToolExecution(FailuresModule, execution));
  const logger = new MemoryLogger();
  const requests: AgentModelRequest[] = [];
  try {
    const runtime = new AgentRuntime(container, callOnce(name, requests), { logger });
    const result = await runtime.run({ name: "support", instructions: "", toolNames: [name] }, { input: "go" });
    const sent = requests[1]?.messages.at(-1)?.content[0];
    return { result, logger, sent: JSON.stringify(sent ?? null) };
  } finally {
    await container.dispose();
  }
}

test("an unexpected exception reaches the model as a generic message and the log with its stack", async () => {
  const { result, logger, sent } = await runTool("fail.crash");
  expect(result.toolResults[0]?.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "Tool execution failed." });
  expect(sent).not.toContain("10.0.0.5");
  expect(sent).not.toContain("hunter2");
  expect(logger.errors).toHaveLength(1);
  expect(logger.errors[0]?.message).toBe("Agent tool failed");
  expect(logger.errors[0]?.fields).toMatchObject({ agent: "support", tool: "fail.crash", callId: "c1", code: "TOOL_EXECUTION_FAILED" });
  const error = logger.errors[0]?.fields?.error as { message: string; stack: string };
  expect(error.message).toBe("db host 10.0.0.5 is down, password=***");
  expect(error.stack).toContain("agent.tool-failures.test.ts");
});

test("a ToolError message reaches the model as written and is not logged", async () => {
  const { result, logger } = await runTool("fail.reply");
  expect(result.toolResults[0]?.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "Товар kiwi снят с продажи" });
  expect(logger.errors).toEqual([]);
});

test("an exception after a write started hides the cause from the model and logs it", async () => {
  const { result, logger, sent } = await runTool("fail.write", { auditSink: () => undefined, approvalPolicy: () => true });
  expect(result.error?.code).toBe("AGENT_TOOL_OUTCOME_UNKNOWN");
  expect(result.toolResults[0]?.error?.message).toBe('Tool "fail.write" threw after side-effect execution started; retry safety is unknown.');
  expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  expect(sent).toBe("null");
  expect(logger.errors[0]).toMatchObject({ message: "Agent tool failed", fields: { code: "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN" } });
});

test("AgentToolPreCommitError keeps its message for the model and stays retryable", async () => {
  preCommitFailures = 1;
  const failed = await runTool("fail.precommit", { auditSink: () => undefined, approvalPolicy: () => true });
  expect(failed.result.toolResults[0]?.error).toEqual({ code: "TOOL_EXECUTION_FAILED", message: "Платёжный шлюз занят" });
  expect(failed.logger.errors).toEqual([]);
  preCommitFailures = 1;
  const retried = await runTool("fail.precommit", { auditSink: () => undefined, approvalPolicy: () => true, retryPolicy: { maxAttempts: 2 } });
  expect(retried.result.toolResults[0]).toMatchObject({ status: "success", output: { paid: true } });
});

test("a tool that cannot be created is reported generically and logged", async () => {
  const { result, logger, sent } = await runTool("fail.resolve");
  expect(result.toolResults[0]?.error).toEqual({ code: "TOOL_RESOLVE_FAILED", message: "Tool could not be created." });
  expect(sent).not.toContain("abc123");
  expect(logger.errors[0]).toMatchObject({ message: "Agent tool failed", fields: { code: "TOOL_RESOLVE_FAILED" } });
});

test("model failures are logged; an aborted run is not", async () => {
  const container = createContainer({});
  const logger = new MemoryLogger();
  try {
    const failing = new AgentRuntime(container, { complete() { throw new Error("upstream 503 token=secret-value"); } }, { logger });
    const result = await failing.run({ name: "support", instructions: "" }, { input: "hi" });
    expect(result.error?.code).toBe("AGENT_PROVIDER_FAILED");
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatchObject({ message: "Agent model call failed", fields: { agent: "support", code: "AGENT_PROVIDER_FAILED" } });
    expect(JSON.stringify(logger.errors[0])).not.toContain("secret-value");

    const hanging = new AgentRuntime(container, { complete: () => new Promise(() => undefined) }, { logger });
    const controller = new AbortController();
    controller.abort();
    expect((await hanging.run({ name: "support", instructions: "" }, { input: "hi", signal: controller.signal })).error?.code).toBe("AGENT_ABORTED");
    expect(logger.errors).toHaveLength(1);
  } finally {
    await container.dispose();
  }
});

test("llmConnect gives AgentRuntime the application logger", async () => {
  const logger = new MemoryLogger();
  const llmConfig = defineConfig("llm", { default: { provider: "script", model: "m", baseUrl: "https://llm.internal", apiKey: secret("k") } });
  const model: AgentModelProvider = { complete() { throw new Error("model is down"); } };
  @Infra({ llm: llmConnect(llmConfig, { create: () => model }) })
  class AppInfra {}
  @Module({ imports: [AppInfra], providers: [DI.singleton(DI.valueProvider(LOGGER, logger))] })
  class AppModule {}
  const container = createContainer(AppModule);
  try {
    await container.resolve(AgentRuntime).run({ name: "support", instructions: "" }, { input: "hi" });
    expect(logger.errors[0]).toMatchObject({ message: "Agent model call failed", fields: { code: "AGENT_PROVIDER_FAILED" } });
  } finally {
    await container.dispose();
  }
});
