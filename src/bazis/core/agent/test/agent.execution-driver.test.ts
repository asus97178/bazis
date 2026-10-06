import { describe, expect, test } from "bun:test";
import { createContainer, Module } from "@/core/di";
import { Agent, AgentRegistry, type AgentModelProvider, type AgentModelRequest, type AgentModelResponse } from "../index";
import { AgentExecutionDriver } from "../internal/AgentExecutionDriver";

@Agent({ name: "checkpoint-agent" })
class CheckpointAgent {}

class CountingProvider implements AgentModelProvider {
  calls = 0;

  complete(_request: AgentModelRequest): AgentModelResponse {
    this.calls += 1;
    throw new Error("provider must not run during checkpoint preparation");
  }
}

describe("agent execution driver durable preparation", () => {
  test("creates strict initial Session state through shared preparation without provider dispatch", async () => {
    @Module({ agents: [CheckpointAgent] }) class AppModule {}
    const provider = new CountingProvider();
    const container = createContainer(AppModule);
    try {
      const driver = new AgentExecutionDriver(container, AgentRegistry.fromModules([AppModule]), provider);
      const outcome = await driver.prepareSessionCheckpoint({
        invocationId: "session-invocation",
        agentName: "checkpoint-agent",
        taskName: null,
        input: { request: "hello" },
        requested: { maxSteps: 3, maxToolCallsPerStep: 2, runTimeoutMs: null, modelProfile: null },
        module: {
          maxSessionSteps: 8, maxToolCallsPerStep: 8, runTimeoutMs: 300_000,
          providerCallTimeoutMs: 60_000, toolDefaultTimeoutMs: 30_000, scopeDisposeTimeoutMs: 5_000,
        },
      });
      expect(outcome.kind).toBe("prepared");
      if (outcome.kind !== "prepared") throw new Error("expected checkpoint");
      const checkpoint = outcome.checkpoint;
      expect(checkpoint.phase).toBe("ready-model");
    expect(checkpoint.invocation.options).toEqual({
      maxSteps: 3,
      maxToolCallsPerStep: 2,
      runTimeoutMs: 300_000,
      modelProfile: null,
      provider: { timeoutMs: 60_000 },
      context: { maxMessages: null, maxChars: null, maxTokens: null },
      output: { maxOutputTokens: null, temperature: null },
      tool: { defaultTimeoutMs: 30_000, scopeDisposeTimeoutMs: 5_000, maxAttempts: 1, timeouts: [] },
    });
      expect(checkpoint.messages.map((message) => message.role)).toEqual(["user"]);
      expect(provider.calls).toBe(0);
    } finally { await container.dispose(); }
  });
});
