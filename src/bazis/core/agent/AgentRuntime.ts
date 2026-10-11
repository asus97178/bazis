import { createToken, type ServiceProvider } from "../di";
import { modelValidatorAdapter } from "../../library/validation";
import type { AgentDataDefinition } from "./AgentDataDefinition";
import { AgentRegistry, type ToolDefinition } from "./AgentRegistry";
import {
  AgentExecutionDriver,
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
} from "./internal/AgentExecutionDriver";
import type { AgentModelProvider } from "./ModelProvider";

export {
  type AgentRuntimeInvokeOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
  type AgentRuntimeStatus,
  type AgentRuntimeToolCallContext,
  type AgentRuntimeToolExecutionOptions,
} from "./internal/AgentExecutionDriver";

/**
 * Optional runtime settings (limits, approval policy, audit sink, context
 * builder). Register a value in any module; the LLM connector reads it from
 * the root container when it creates {@link AgentRuntime}.
 */
export const AGENT_RUNTIME_OPTIONS = createToken<AgentRuntimeOptions>("AgentRuntimeOptions");

/**
 * Runs meta-agents: an agent is data ({@link AgentDataDefinition}) — a name,
 * instructions and the names of Tools it may call. The Tools themselves are
 * code, registered in `@Module.tools`. Injected by type; `llmConnect` and
 * `llmRouter` register it next to the model provider.
 *
 * ```ts
 * const result = await this.agents.run(
 *   { name: "support", instructions: "Answer about orders.", toolNames: ["orders.find"] },
 *   { input: "Where is order 42?" },
 * );
 * ```
 */
export class AgentRuntime {
  private readonly catalog: AgentRegistry;
  private readonly options: AgentRuntimeOptions;

  constructor(
    private readonly services: ServiceProvider,
    private readonly modelProvider: AgentModelProvider,
    options: AgentRuntimeOptions = {},
  ) {
    this.catalog = AgentRegistry.fromContainer(services);
    this.options = {
      ...options,
      toolExecutorOptions: { schemaValidator: modelValidatorAdapter, ...options.toolExecutorOptions },
    };
    // Invalid options and hook setup fail here, at the first resolve, not on the first run.
    new AgentExecutionDriver(services, this.catalog, modelProvider, this.options);
  }

  /** The Tools an agent definition may name in `toolNames`. */
  listTools(): readonly ToolDefinition[] {
    return this.catalog.listTools();
  }

  /**
   * Checks a definition the way `run` does, without calling the model: an
   * invalid field or a tool name not registered in `@Module.tools` throws
   * AgentSetupError. Use it before saving a definition an operator edited.
   */
  check(definition: AgentDataDefinition): void {
    AgentRegistry.fromDefinition(definition, this.catalog.listTools());
  }

  /**
   * Runs one agent definition. An invalid definition, or a tool name that is
   * not registered in `@Module.tools`, rejects with AgentSetupError before the
   * model is called; failures of the run itself come back as `status: "failed"`.
   */
  async run(definition: AgentDataDefinition, options: AgentRuntimeInvokeOptions = {}): Promise<AgentRuntimeResult> {
    const registry = AgentRegistry.fromDefinition(definition, this.catalog.listTools());
    const driver = new AgentExecutionDriver(this.services, registry, this.modelProvider, this.options);
    return driver.invoke(definition.name, options);
  }
}
