import { expect, test } from "bun:test";
import { Module } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import type { LogFields, Logger } from "@/core/kernel/logging/Logger";
import { startTestApp } from "@/core/testing";
import { Infra, llmConnect, llmProfile, llmRouter, openAiCompatibleAdapter, type LlmProviderAdapter } from "@/core/infra";
import { AgentRuntime, AgentSetupError, agentMessage, agentModelResponse, type AgentModelProvider } from "@/core/agent";

class MemoryLogger implements Logger {
  readonly warnings: { message: string; fields?: LogFields }[] = [];
  readonly errors: { message: string; fields?: LogFields }[] = [];
  debug() {}
  info() {}
  warn(message: string, fields?: LogFields) { this.warnings.push({ message, fields }); }
  error(message: string, fields?: LogFields) { this.errors.push({ message, fields }); }
}

const llmConfig = defineConfig("llm", { default: { provider: "script", model: "small", baseUrl: "http://127.0.0.1:9/v1", apiKey: secret("k") } });

function adapter(answer: (model: string) => string): LlmProviderAdapter {
  return {
    create(connection): AgentModelProvider {
      return {
        complete(request) {
          return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", answer(connection.model)) });
        },
      };
    },
  };
}

const failingBig = adapter((model) => { if (model === "big") throw new Error("HTTP 503 from big, token=abc123"); return `from ${model}`; });

async function app(infra: object, logger = new MemoryLogger()) {
  @Module({})
  class AppModule {}
  const started = await startTestApp(AppModule, { infra: infra as never, http: false, configure: (builder) => builder.useLogger(logger) });
  return { started, logger, agents: started.container.resolve(AgentRuntime) };
}

test("a fallback is reported to the application log instead of being silent", async () => {
  @Infra({ llm: llmRouter({
    fast: llmProfile(llmConfig, failingBig, { model: "small" }),
    reasoning: llmProfile(llmConfig, failingBig, { model: "big", fallback: "fast" }),
  }, { defaultProfile: "fast" }) })
  class AppInfra {}
  const { started, logger, agents } = await app(AppInfra);
  try {
    const result = await agents.run({ name: "support", instructions: "", modelProfile: "reasoning" }, { input: "hi" });
    expect(result.finalMessage?.content[0]).toEqual({ kind: "text", text: "from small" });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toMatchObject({ message: "LLM model profile failed, using fallback", fields: { profile: "reasoning", fallback: "fast", agent: "support" } });
    expect((logger.warnings[0]?.fields?.error as { message: string }).message).toBe("HTTP 503 from big, token=***");
  } finally {
    await started.stop();
  }
});

test("an agent naming a profile the router does not serve fails before the model", async () => {
  let calls = 0;
  const counting = adapter((model) => { calls++; return model; });
  @Infra({ llm: llmRouter({ fast: llmProfile(llmConfig, counting), reasoning: llmProfile(llmConfig, counting, { model: "big" }) }, { defaultProfile: "fast" }) })
  class AppInfra {}
  const { started, agents } = await app(AppInfra);
  try {
    const creative = { name: "support", instructions: "", modelProfile: "creative" };
    expect(() => agents.check(creative)).toThrow(AgentSetupError);
    expect(() => agents.check(creative)).toThrow('Agent "support": model profile "creative" is not configured (configured: fast, reasoning).');
    await expect(agents.run(creative, { input: "hi" })).rejects.toThrow('model profile "creative" is not configured');
    await expect(agents.run({ name: "support", instructions: "" }, { input: "hi", modelProfile: "creative" })).rejects.toThrow(AgentSetupError);
    expect(() => agents.check({ name: "support", instructions: "", modelProfile: "reasoning" })).not.toThrow();
    expect(calls).toBe(0);
  } finally {
    await started.stop();
  }
});

test("a single llmConnect model accepts any profile", async () => {
  @Infra({ llm: llmConnect(llmConfig, adapter(() => "ok")) })
  class AppInfra {}
  const { started, agents } = await app(AppInfra);
  try {
    expect(() => agents.check({ name: "support", instructions: "", modelProfile: "anything" })).not.toThrow();
  } finally {
    await started.stop();
  }
});

test("the connector's own timeout is reported as AGENT_PROVIDER_TIMEOUT", async () => {
  const hanging = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  for (const llm of [
    llmConnect(llmConfig, openAiCompatibleAdapter({ fetch: hanging, healthCheck: false }), { timeoutMs: 30 }),
    llmRouter({ main: llmProfile(llmConfig, openAiCompatibleAdapter({ fetch: hanging, healthCheck: false }), { timeoutMs: 30 }) }),
  ]) {
    @Infra({ llm })
    class AppInfra {}
    const { started, agents, logger } = await app(AppInfra);
    try {
      const result = await agents.run({ name: "support", instructions: "" }, { input: "hi" });
      expect(result.error?.code).toBe("AGENT_PROVIDER_TIMEOUT");
      expect(logger.errors[0]).toMatchObject({ message: "Agent model call failed", fields: { code: "AGENT_PROVIDER_TIMEOUT" } });
    } finally {
      await started.stop();
    }
  }
});
