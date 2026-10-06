import { describe, expect, test } from "bun:test";
import { createContainer, Global, HOSTED_SERVICE, Module, singletonValue, type HostedService } from "@/core/di";
import { AGENT_MODEL_PROVIDER, agentMessage, agentModelResponse, type AgentModelProvider } from "@/core/agent";
import { Configuration, defineConfig, HEALTH_CHECK, secret, type HealthCheck } from "@/core/kernel";
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  Infra,
  InfraLifecycle,
  llmConnect,
  type InfraManifest,
  type LlmConnectionOptions,
  type LlmProviderAdapter,
} from "../index";

const llmConfig = defineConfig("llm", {
  default: {
    provider: "test",
    model: "test-model",
    baseUrl: "https://llm.internal",
    apiKey: secret("test-key"),
  },
});

class TestModelProvider implements AgentModelProvider {
  public readonly options: LlmConnectionOptions;

  constructor(options: LlmConnectionOptions) {
    this.options = options;
  }

  complete(request: Parameters<AgentModelProvider["complete"]>[0]) {
    return agentModelResponse({
      invocationId: request.invocationId,
      finishReason: "stop",
      message: agentMessage("assistant", "ok"),
    });
  }
}

function adapter(events: string[]): LlmProviderAdapter {
  return {
    create(options) {
      events.push(`create:${options.provider}:${options.model}`);
      return new TestModelProvider(options);
    },
    connect() {
      events.push("connect");
    },
    dispose() {
      events.push("dispose");
    },
    healthCheck() {
      events.push("health");
      return true;
    },
  };
}

function containerFor(manifest: InfraManifest) {
  @Global()
  @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] })
  class ConfigModule {}

  @Infra(manifest)
  class InfraModule {}

  @Module({ imports: [ConfigModule, InfraModule] })
  class Root {}

  return createContainer(Root);
}

describe("LLM infra connector", () => {
  test("@Infra exports the model provider token and owns its config", () => {
    const events: string[] = [];

    @Infra({ llm: llmConnect(llmConfig, adapter(events)) })
    class AppInfra {}

    const meta = AppInfra as unknown as { global?: boolean; exports?: readonly unknown[]; config?: readonly unknown[] };
    expect(meta.global).toBe(true);
    expect(meta.exports).toEqual([AGENT_MODEL_PROVIDER]);
    expect(meta.config).toEqual([llmConfig]);
  });

  test("resolves the provider under AGENT_MODEL_PROVIDER and wires lifecycle/health", async () => {
    const events: string[] = [];
    const container = containerFor({ llm: llmConnect(llmConfig, adapter(events), { timeoutMs: 2500 }) });
    try {
      const provider = container.resolve(AGENT_MODEL_PROVIDER);
      expect(provider).toBeInstanceOf(TestModelProvider);
      expect((provider as TestModelProvider).options).toMatchObject({
        provider: "test",
        model: "test-model",
        baseUrl: "https://llm.internal",
        apiKey: "test-key",
        timeoutMs: 2500,
      });

      const hosted = container.resolveAll(HOSTED_SERVICE) as readonly HostedService[];
      const lifecycle = hosted.find((service): service is InfraLifecycle<AgentModelProvider> => service instanceof InfraLifecycle);
      expect(lifecycle?.instanceName).toBe("llm");
      await lifecycle?.start();

      const checks = container.resolveAll(HEALTH_CHECK) as readonly HealthCheck[];
      expect(checks.map((check) => check.name)).toEqual(["infra:llm"]);
      expect(await checks[0]?.check()).toEqual({ healthy: true });
      await lifecycle?.stop();

      expect(events).toEqual(["create:test:test-model", "connect", "health", "dispose"]);
    } finally {
      await container.dispose();
    }
  });

  test("uses a safe request timeout by default and keeps an explicit unbounded opt-out", async () => {
    const defaultContainer = containerFor({ llm: llmConnect(llmConfig, adapter([])) });
    const unboundedContainer = containerFor({ llm: llmConnect(llmConfig, adapter([]), { timeoutMs: 0 }) });
    try {
      expect((defaultContainer.resolve(AGENT_MODEL_PROVIDER) as TestModelProvider).options.timeoutMs)
        .toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
      expect((unboundedContainer.resolve(AGENT_MODEL_PROVIDER) as TestModelProvider).options.timeoutMs).toBe(0);
    } finally {
      await Promise.all([defaultContainer.dispose(), unboundedContainer.dispose()]);
    }

    const invalid = containerFor({ llm: llmConnect(llmConfig, adapter([]), { timeoutMs: -1 }) });
    try {
      expect(() => invalid.resolve(AGENT_MODEL_PROVIDER)).toThrow("timeoutMs");
    } finally {
      await invalid.dispose();
    }
  });
});
