import type { AppConfig, ConfigRegistry, Secret } from "../../kernel";
import { AGENT_MODEL_PROVIDER, AGENT_RUNTIME_OPTIONS, AgentRuntime, type AgentModelProvider } from "../../agent";
import { DI, SERVICE_PROVIDER, type ProviderDefinition } from "../../di";
import { reader, requireValue } from "../connectorConfig";
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
    return new AgentRuntime(services, model, services.has(AGENT_RUNTIME_OPTIONS) ? services.resolve(AGENT_RUNTIME_OPTIONS) : {});
  })),
]);

export function llmConnect<T extends LlmConfigShape>(
  config: AppConfig<T>,
  adapter: LlmProviderAdapter,
  options: LlmConnectorOptions = {},
): InfraConnector<AgentModelProvider> {
  return identifyConnector({
    token: AGENT_MODEL_PROVIDER,
    config,
    providers: agentRuntimeProviders,
    exports: [AgentRuntime],
    create(configs) {
      return adapter.create(resolveLlmConnectionOptions(config, options, configs));
    },
    connect(provider, signal) {
      return adapter.connect?.(provider, signal);
    },
    dispose(provider) {
      return adapter.dispose?.(provider);
    },
    healthCheck: adapter.healthCheck
      ? (provider, signal) => adapter.healthCheck?.(provider, signal) ?? false
      : undefined,
  }, "llm");
}
