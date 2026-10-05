import { describe, expect, test } from "bun:test";
import { createContainer, Global, Module, singletonValue } from "@/core/di";
import {
  AGENT_MODEL_PROVIDER,
  agentMessage,
  agentModelRequest,
  agentModelResponse,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
} from "@/core/agent";
import { Configuration, defineConfig, secret } from "@/core/kernel";
import {
  Infra,
  LlmModelRouter,
  llmProfile,
  llmRouter,
  type InfraManifest,
  type LlmConnectionOptions,
  type LlmProviderAdapter,
} from "../index";

const sharedConfig = defineConfig("llm", {
  default: {
    provider: "test",
    model: "config-model",
    baseUrl: "https://llm.internal",
    apiKey: secret("test-key"),
  },
});

const fastConfig = defineConfig("llm-fast", {
  default: {
    provider: "test",
    model: "fast-config-model",
    baseUrl: "https://fast.internal",
    apiKey: secret("fast-key"),
  },
});

class CapturingProvider implements AgentModelProvider {
  public readonly options: LlmConnectionOptions;
  public readonly requests: AgentModelRequest[] = [];
  public readonly contexts: AgentModelProviderContext[] = [];

  constructor(
    private readonly name: string,
    options: LlmConnectionOptions,
    private readonly fail = false,
  ) {
    this.options = options;
  }

  complete(request: AgentModelRequest, context: AgentModelProviderContext): AgentModelResponse {
    this.requests.push(request);
    this.contexts.push(context);
    if (this.fail) {
      throw new Error(`${this.name} offline`);
    }
    return agentModelResponse({
      invocationId: request.invocationId,
      finishReason: "stop",
      message: agentMessage("assistant", `${this.name}:${request.model}:${request.temperature}:${request.maxOutputTokens}`),
      metadata: { profile: context.modelProfile ?? null },
    });
  }
}

function adapter(name: string, providers: CapturingProvider[], fail = false): LlmProviderAdapter {
  return {
    create(options) {
      const provider = new CapturingProvider(name, options, fail);
      providers.push(provider);
      return provider;
    },
  };
}

function lifecycleAdapter(
  name: string,
  events: string[],
  options: { readonly connectError?: boolean; readonly disposeError?: boolean; readonly health?: boolean | "throw" } = {},
): LlmProviderAdapter {
  return {
    create(connection) {
      return new CapturingProvider(name, connection);
    },
    connect() {
      events.push(`connect:${name}`);
      if (options.connectError) throw new Error(`token=${name}-connect-secret`);
    },
    dispose() {
      events.push(`dispose:${name}`);
      if (options.disposeError) throw new Error(`token=${name}-dispose-secret`);
    },
    healthCheck() {
      events.push(`health:${name}`);
      if (options.health === "throw") throw new Error(`${name} health failed`);
      return options.health ?? true;
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

describe("LLM model router", () => {
  test("exports one model provider token and owns profile configs", () => {
    const providers: CapturingProvider[] = [];

    @Infra({
      llm: llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers), { model: "gpt-fast" }),
        reasoning: llmProfile(sharedConfig, adapter("reasoning", providers), { model: "gpt-reasoning" }),
      }, { defaultProfile: "fast" }),
    })
    class AppInfra {}

    const meta = AppInfra as unknown as { exports?: readonly unknown[]; config?: readonly unknown[] };
    expect(meta.exports).toEqual([AGENT_MODEL_PROVIDER]);
    expect(meta.config).toEqual([fastConfig, sharedConfig]);
  });

  test("routes by request modelProfile and applies profile defaults", async () => {
    const providers: CapturingProvider[] = [];
    const container = containerFor({
      llm: llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers), {
          model: "gpt-fast",
          temperature: 0.1,
          maxOutputTokens: 1000,
        }),
        reasoning: llmProfile(sharedConfig, adapter("reasoning", providers), {
          model: "gpt-reasoning",
          temperature: 0.2,
          maxOutputTokens: 4000,
          fallback: "fast",
        }),
      }, { defaultProfile: "fast" }),
    });
    try {
      const router = container.resolve(AGENT_MODEL_PROVIDER);
      const response = await router.complete(
        agentModelRequest({
          invocationId: "inv-1",
          messages: [agentMessage("user", "Think")],
          modelProfile: "reasoning",
        }),
        {
          invocationId: "inv-1",
          agentName: "architect-agent",
          modelProfile: "reasoning",
          metadata: {},
          signal: new AbortController().signal,
        },
      );

      expect(response.message?.content[0]).toEqual({ kind: "text", text: "reasoning:gpt-reasoning:0.2:4000" });
      const reasoning = providers.find((provider) => provider.options.model === "gpt-reasoning");
      expect(reasoning?.options.timeoutMs).toBe(60_000);
      expect(reasoning?.requests[0]).toMatchObject({
        modelProfile: "reasoning",
        model: "gpt-reasoning",
        temperature: 0.2,
        maxOutputTokens: 4000,
      });
      expect(reasoning?.contexts[0]?.modelProfile).toBe("reasoning");
    } finally {
      await container.dispose();
    }
  });

  test("allows an explicit zero timeout profile for compatibility", async () => {
    const providers: CapturingProvider[] = [];
    const container = containerFor({
      llm: llmRouter({
        unbounded: llmProfile(sharedConfig, adapter("unbounded", providers), { timeoutMs: 0 }),
      }),
    });
    try {
      await (container.resolve(AGENT_MODEL_PROVIDER) as LlmModelRouter).connect();
      expect(providers[0]?.options.timeoutMs).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("keeps the profile-owned model while request sampling options override defaults", async () => {
    const providers: CapturingProvider[] = [];
    const container = containerFor({
      llm: llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers), {
          model: "gpt-fast",
          temperature: 0.1,
          maxOutputTokens: 1000,
        }),
      }),
    });
    try {
      const router = container.resolve(AGENT_MODEL_PROVIDER);
      const response = await router.complete(
        agentModelRequest({
          invocationId: "inv-1",
          messages: [agentMessage("user", "Quick")],
          model: "manual-model",
          temperature: 0.9,
          maxOutputTokens: 77,
        }),
        {
          invocationId: "inv-1",
          agentName: "fast-agent",
          metadata: {},
          signal: new AbortController().signal,
        },
      );

      expect(response.message?.content[0]).toEqual({ kind: "text", text: "fast:gpt-fast:0.9:77" });
    } finally {
      await container.dispose();
    }
  });

  test("falls back to the configured profile when the primary provider fails", async () => {
    const providers: CapturingProvider[] = [];
    const container = containerFor({
      llm: llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers), { model: "gpt-fast" }),
        reasoning: llmProfile(sharedConfig, adapter("reasoning", providers, true), {
          model: "gpt-reasoning",
          fallback: "fast",
        }),
      }, { defaultProfile: "fast" }),
    });
    try {
      const router = container.resolve(AGENT_MODEL_PROVIDER);
      const response = await router.complete(
        agentModelRequest({
          invocationId: "inv-1",
          messages: [agentMessage("user", "Think")],
          modelProfile: "reasoning",
        }),
        {
          invocationId: "inv-1",
          agentName: "architect-agent",
          modelProfile: "reasoning",
          metadata: {},
          signal: new AbortController().signal,
        },
      );

      expect(response.message?.content[0]).toEqual({ kind: "text", text: "fast:gpt-fast:undefined:undefined" });
      expect(providers.find((provider) => provider.options.model === "gpt-reasoning")?.requests).toHaveLength(1);
      expect(providers.find((provider) => provider.options.model === "gpt-fast")?.requests[0]?.modelProfile).toBe("fast");
    } finally {
      await container.dispose();
    }
  });

  test("does not start fallback after abort observed before fallback dispatch", async () => {
    const providers: CapturingProvider[] = [];
    const controller = new AbortController();
    const primaryAdapter: LlmProviderAdapter = {
      create(options) {
        const provider = new CapturingProvider("primary", options);
        provider.complete = (request, context) => {
          provider.requests.push(request);
          provider.contexts.push(context);
          controller.abort(new Error("cancelled before fallback"));
          throw new Error("primary offline");
        };
        providers.push(provider);
        return provider;
      },
    };
    const container = containerFor({
      llm: llmRouter({
        primary: llmProfile(sharedConfig, primaryAdapter, { fallback: "fallback" }),
        fallback: llmProfile(fastConfig, adapter("fallback", providers)),
      }, { defaultProfile: "primary" }),
    });
    try {
      const router = container.resolve(AGENT_MODEL_PROVIDER);
      await expect(router.complete(
        agentModelRequest({ invocationId: "inv-abort", messages: [agentMessage("user", "Stop")] }),
        {
          invocationId: "inv-abort",
          agentName: "agent",
          metadata: {},
          signal: controller.signal,
        },
      )).rejects.toThrow(/cancelled before provider dispatch/);
      expect(providers.find((provider) => provider.options.model === "config-model")?.requests).toHaveLength(1);
      expect(providers.find((provider) => provider.options.model === "fast-config-model")?.requests).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  test("fails fast for ambiguous default profiles and unknown requested profiles", async () => {
    const providers: CapturingProvider[] = [];
    expect(() =>
      llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers)),
        reasoning: llmProfile(sharedConfig, adapter("reasoning", providers)),
      }),
    ).toThrow(/defaultProfile/);

    const container = containerFor({
      llm: llmRouter({
        fast: llmProfile(fastConfig, adapter("fast", providers)),
      }),
    });
    try {
      const router = container.resolve(AGENT_MODEL_PROVIDER);
      await expect(
        router.complete(
          agentModelRequest({
            invocationId: "inv-1",
            messages: [agentMessage("user", "Use unknown")],
            modelProfile: "unknown",
          }),
          {
            invocationId: "inv-1",
            agentName: "agent",
            modelProfile: "unknown",
            metadata: {},
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow(/Unknown LLM model profile/);
    } finally {
      await container.dispose();
    }
  });

  test("fails fast when the fallback graph contains an indirect cycle", () => {
    const providers: CapturingProvider[] = [];
    expect(() => llmRouter({
      fast: llmProfile(fastConfig, adapter("fast", providers), { fallback: "reasoning" }),
      reasoning: llmProfile(sharedConfig, adapter("reasoning", providers), { fallback: "archive" }),
      archive: llmProfile(sharedConfig, adapter("archive", providers), { fallback: "fast" }),
    }, { defaultProfile: "fast" })).toThrow(/fallback cycle.*fast -> reasoning -> archive -> fast/);
  });

  test("partial connect rolls back every created profile in reverse and aggregates cleanup errors", async () => {
    const events: string[] = [];
    const connector = llmRouter({
      first: llmProfile(sharedConfig, lifecycleAdapter("first", events, { disposeError: true })),
      second: llmProfile(sharedConfig, lifecycleAdapter("second", events, { connectError: true })),
      third: llmProfile(sharedConfig, lifecycleAdapter("third", events, { disposeError: true })),
    }, { defaultProfile: "first" });
    const client = connector.create();

    try {
      await connector.connect(client);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(3);
      expect(String(error)).not.toContain("connect-secret");
      expect(String(error)).not.toContain("dispose-secret");
    }
    expect(events).toEqual([
      "connect:first",
      "connect:second",
      "dispose:third",
      "dispose:second",
      "dispose:first",
    ]);
    // Rollback makes the connector's later generic cleanup idempotent.
    await connector.dispose(client);
    expect(events).toHaveLength(5);
  });

  test("health and dispose continue across all profiles", async () => {
    const events: string[] = [];
    const connector = llmRouter({
      first: llmProfile(sharedConfig, lifecycleAdapter("first", events, { health: "throw", disposeError: true })),
      second: llmProfile(sharedConfig, lifecycleAdapter("second", events, { health: false })),
      third: llmProfile(sharedConfig, lifecycleAdapter("third", events, { health: true, disposeError: true })),
    }, { defaultProfile: "first" });
    const client = connector.create();

    expect(await connector.healthCheck?.(client)).toBe(false);
    expect(events).toEqual(["health:first", "health:second", "health:third"]);
    await expect(connector.dispose(client)).rejects.toBeInstanceOf(AggregateError);
    expect(events.slice(3)).toEqual(["dispose:third", "dispose:second", "dispose:first"]);
  });
});
