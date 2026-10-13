import type { AppConfig, ConfigRegistry, Secret } from "../../kernel";
import { AGENT_MODEL_PROVIDER, AGENT_RUNTIME_OPTIONS, AgentRuntime, type AgentModelProvider } from "../../agent";
import { DI, DiError, HOSTED_SERVICE, SERVICE_PROVIDER, type ProviderDefinition } from "../../di";
import { LOGGER } from "../../kernel/logging/Logger";
import { reader, requireValue, settingNames } from "../connectorConfig";
import { InfraError, type InfraConnector } from "../InfraConnector";
import { identifyConnector } from "../connectorIdentity";

/** Safe default for direct provider calls and health checks. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 60_000;

export interface LlmConfigShape {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: Secret;
}

export interface LlmConnectionOptions {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Request timeout. Defaults to 60s; `0` explicitly disables it. */
  readonly timeoutMs?: number;
}

export interface LlmConnectorOptions {
  /** Request timeout. Defaults to 60s; `0` explicitly disables it. */
  readonly timeoutMs?: number;
  /**
   * Check the provider at start (the adapter's `connect`: `GET /models` for an
   * OpenAI-compatible API, five seconds), so a wrong key or address stops the
   * start instead of the first agent request. Default `true`.
   */
  readonly checkOnStart?: boolean;
}

export interface LlmProviderAdapter {
  create(options: LlmConnectionOptions): AgentModelProvider;
  connect?(provider: AgentModelProvider, signal?: AbortSignal): Promise<void> | void;
  dispose?(provider: AgentModelProvider): Promise<void> | void;
  healthCheck?(provider: AgentModelProvider, signal?: AbortSignal): Promise<boolean> | boolean;
}

export function resolveLlmConnectionOptions<T extends LlmConfigShape>(
  config: AppConfig<T>,
  options: LlmConnectorOptions,
  configs?: ConfigRegistry,
): LlmConnectionOptions {
  const c = reader(config, configs);
  const configuredTimeout = options.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 0) {
    throw new InfraError("llm timeoutMs must be a non-negative safe integer");
  }
  return {
    provider: requireValue(c.get("provider"), "provider", "llm"),
    model: requireValue(c.get("model"), "model", "llm"),
    baseUrl: requireValue(c.get("baseUrl"), "baseUrl", "llm"),
    apiKey: (c.get("apiKey") as Secret).reveal(),
    timeoutMs: configuredTimeout,
  };
}

/**
 * `AgentRuntime` on top of the connector's model provider, injectable by type.
 * Options come from `AGENT_RUNTIME_OPTIONS` when the application registers it.
 */
export const agentRuntimeProviders: readonly ProviderDefinition[] = Object.freeze([
  DI.singleton(DI.factoryProviderWithResolver(AgentRuntime, [AGENT_MODEL_PROVIDER], (resolver, model: AgentModelProvider) => {
    const services = resolver.resolve(SERVICE_PROVIDER);
    const options = services.has(AGENT_RUNTIME_OPTIONS) ? services.resolve(AGENT_RUNTIME_OPTIONS) : {};
    return new AgentRuntime(services, model, { ...options, logger: options.logger ?? services.tryResolve(LOGGER) });
  })),
  // Builds the runtime at start: wrong options or hooks without an audit sink
  // stop the application instead of failing every agent request.
  DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => ({
    start() {
      try {
        resolver.resolve(AgentRuntime);
      } catch (error) {
        if (error instanceof DiError) throw error;
        throw new DiError(`AgentRuntime: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    stop() {},
  }))),
]);

export function llmConnect<T extends LlmConfigShape>(
  config: AppConfig<T>,
  adapter: LlmProviderAdapter,
  options: LlmConnectorOptions = {},
): InfraConnector<AgentModelProvider> {
  const described = new WeakMap<AgentModelProvider, { connection: LlmConnectionOptions; settings: string[] }>();
  return identifyConnector({
    token: AGENT_MODEL_PROVIDER,
    config,
    providers: agentRuntimeProviders,
    exports: [AgentRuntime],
    create(configs) {
      const connection = resolveLlmConnectionOptions(config, options, configs);
      const provider = adapter.create(connection);
      described.set(provider, { connection, settings: settingNames(config, configs, ["baseUrl", "apiKey"]) });
      return provider;
    },
    connect(provider, signal) {
      if (options.checkOnStart === false) return;
      return adapter.connect?.(provider, signal);
    },
    describe(provider, { connected }) {
      const known = described.get(provider);
      if (known === undefined) return {};
      return {
        kind: `${known.connection.provider} · ${known.connection.model}`,
        address: known.connection.baseUrl,
        details: connected && options.checkOnStart !== false && adapter.connect !== undefined ? ["checked"] : [],
        settings: known.settings,
      };
    },
    dispose(provider) {
      return adapter.dispose?.(provider);
    },
    healthCheck: adapter.healthCheck
      ? (provider, signal) => adapter.healthCheck?.(provider, signal) ?? false
      : undefined,
  }, "llm");
}
