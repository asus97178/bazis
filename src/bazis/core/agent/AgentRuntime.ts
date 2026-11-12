import { createToken, type ServiceProvider } from "../di";
import { modelValidatorAdapter } from "../../library/validation";
import { AgentSetupError } from "./errors";
import { TOOL_EXECUTION_OPTIONS } from "./toolExecutionOptions";
import type { AgentDataDefinition } from "./AgentDataDefinition";
import { AgentRegistry, type ToolDefinition } from "./AgentRegistry";
import {
  AgentExecutionDriver,
  type AgentRunEvent,
  type AgentRuntimeInvokeOptions,
  type AgentExecutionDriverOptions,
  type AgentRuntimeOptions,
  type AgentRuntimeResult,
} from "./internal/AgentExecutionDriver";
import type { AgentModelProvider } from "./ModelProvider";

export {
  type AgentRunEvent,
  type AgentStepStartedEvent,
  type AgentTextDeltaEvent,
  type AgentModelRetryEvent,
  type AgentModelAnsweredEvent,
  type AgentToolStartedEvent,
  type AgentToolFinishedEvent,
  type AgentCompactedEvent,
  type AgentRunFinishedEvent,
  type AgentCompactionOptions,
  type AgentToolApproval,
  type AgentPendingApproval,
  type AgentModelRetryPolicy,
  type AgentRuntimeInvokeOptions,
  type AgentExecutionDriverOptions,
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
  private readonly options: AgentExecutionDriverOptions;

  constructor(
    private readonly services: ServiceProvider,
    private readonly modelProvider: AgentModelProvider,
    options: AgentRuntimeOptions = {},
  ) {
    this.catalog = AgentRegistry.fromContainer(services);
    // One Tool execution setup for agents and ToolRunner (TOOLS-001 §6).
    const { logger: _toolLogger, ...toolExecutorOptions } = services.has(TOOL_EXECUTION_OPTIONS) ? services.resolve(TOOL_EXECUTION_OPTIONS) : {};
    this.options = {
      ...options,
      toolExecutorOptions: { schemaValidator: modelValidatorAdapter, ...toolExecutorOptions },
      // What a model's tokens turned out to cost is learned once for every run.
      tokenScales: new Map<string, number>(),
    };
    const summaryProfile = options.compaction === undefined || options.compaction === false ? undefined : options.compaction.modelProfile;
    if (summaryProfile !== undefined && typeof modelProvider.modelProfiles === "function" && !modelProvider.modelProfiles().includes(summaryProfile)) {
      throw new AgentSetupError(`AgentRuntime.compaction: model profile "${summaryProfile}" is not configured (configured: ${[...modelProvider.modelProfiles()].sort().join(", ")}).`);
    }
    // Invalid options and hook setup fail here, at the first resolve, not on the first run.
    new AgentExecutionDriver(services, this.catalog, modelProvider, this.options);
  }

  /** The Tools an agent definition may name in `toolNames`. */
  listTools(): readonly ToolDefinition[] {
    return this.catalog.listTools();
  }

  /** A profile the model provider does not serve fails before the model is called. */
  private assertModelProfile(agentName: string, profile: string | undefined): void {
    if (profile === undefined || typeof this.modelProvider.modelProfiles !== "function") return;
    const configured = this.modelProvider.modelProfiles();
    if (!configured.includes(profile)) {
      throw new AgentSetupError(`Agent "${agentName}": model profile "${profile}" is not configured (configured: ${[...configured].sort().join(", ")}).`);
    }
  }

  /**
   * Checks a definition the way `run` does, without calling the model: an
   * invalid field or a tool name not registered in `@Module.tools` throws
   * AgentSetupError. Use it before saving a definition an operator edited.
   */
  check(definition: AgentDataDefinition): void {
    AgentRegistry.fromDefinition(definition, this.catalog.listTools());
    this.assertModelProfile(definition.name, definition.modelProfile);
  }

  /**
   * Runs one agent definition. An invalid definition, or a tool name that is
   * not registered in `@Module.tools`, rejects with AgentSetupError before the
   * model is called; failures of the run itself come back as `status: "failed"`.
   */
  async run(definition: AgentDataDefinition, options: AgentRuntimeInvokeOptions = {}): Promise<AgentRuntimeResult> {
    const registry = AgentRegistry.fromDefinition(definition, this.catalog.listTools());
    this.assertModelProfile(definition.name, options.modelProfile ?? definition.modelProfile);
    const driver = new AgentExecutionDriver(this.services, registry, this.modelProvider, this.options);
    return driver.invoke(definition.name, options);
  }

  /**
   * Runs a definition and gives what happens as it happens: for a response
   * that is written to the client while the agent works. The last event is
   * `finished` with the result `run` would return. Leaving the loop early
   * cancels the run.
   *
   * ```ts
   * for await (const event of this.agents.stream(support, { input: question })) {
   *   if (event.kind === "text-delta") write(event.text);
   *   if (event.kind === "tool-started") write(`\n[${event.call.name}]\n`);
   * }
   * ```
   */
  stream(definition: AgentDataDefinition, options: AgentRuntimeInvokeOptions = {}): AsyncIterable<AgentRunEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const events: AgentRunEvent[] = [];
        let wake: (() => void) | undefined;
        let ended = false;
        let failure: unknown;
        const cancel = new AbortController();
        const signal = options.signal === undefined ? cancel.signal : AbortSignal.any([options.signal, cancel.signal]);
        const notify = (): void => { const waiting = wake; wake = undefined; waiting?.(); };
        const run = this.run(definition, {
          ...options,
          signal,
          onEvent: (event) => { options.onEvent?.(event); events.push(event); notify(); },
        }).then(() => undefined, (error: unknown) => { failure = error; }).finally(() => { ended = true; notify(); });
        return {
          async next(): Promise<IteratorResult<AgentRunEvent>> {
            for (;;) {
              const event = events.shift();
              if (event !== undefined) return { value: event, done: false };
              if (ended) {
                // A definition that cannot be run rejects here, like `run` does.
                if (failure !== undefined) throw failure;
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => { wake = resolve; });
            }
          },
          async return(): Promise<IteratorResult<AgentRunEvent>> {
            cancel.abort();
            await run;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
