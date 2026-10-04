import type { ServiceProvider } from "../di";
import type { AgentRegistry } from "./AgentRegistry";
import {
  AgentExecutionDriver,
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
  type AgentRuntimeTaskInvokeOptions,
} from "./internal/AgentExecutionDriver";
import type { AgentModelProvider } from "./ModelProvider";

export {
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
  type AgentRuntimeStatus,
  type AgentRuntimeTaskInvokeOptions,
  type AgentRuntimeToolCallContext,
  type AgentRuntimeToolExecutionOptions,
} from "./internal/AgentExecutionDriver";

/** Public compatibility facade for the owner-private execution driver. */
export class AgentRuntime {
  private readonly driver: AgentExecutionDriver;
  private readonly defaultTimeoutMs?: number;

  constructor(
    services: ServiceProvider,
    registry: AgentRegistry,
    modelProvider: AgentModelProvider,
    options: AgentRuntimeOptions = {},
  ) {
    this.driver = new AgentExecutionDriver(services, registry, modelProvider, options);
    this.defaultTimeoutMs = this.driver.defaultTimeoutMs;
  }

  invoke(agentName: string, options: AgentRuntimeInvokeOptions = {}): Promise<AgentRuntimeResult> {
    return this.driver.invoke(agentName, options);
  }

  invokeTask(
    agentName: string,
    taskName: string,
    input: unknown,
    options: AgentRuntimeTaskInvokeOptions = {},
  ): Promise<AgentRuntimeResult> {
    return this.driver.invokeTask(agentName, taskName, input, options);
  }
}
