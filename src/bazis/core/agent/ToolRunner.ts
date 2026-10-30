import { createToken, DI, DiError, HOSTED_SERVICE, SERVICE_PROVIDER, type ProviderDefinition, type ServiceProvider } from "../di";
import { LOGGER, type Logger } from "../kernel/logging/Logger";
import { modelValidatorAdapter } from "../../library/validation";
import { AgentRegistry, type ToolDefinition } from "./AgentRegistry";
import { AgentToolExecutor, type AgentToolExecutionOptions, type AgentToolExecutorOptions } from "./AgentToolExecutor";
import { describeTool } from "./Tool.contract";
import { agentToolCall, type AgentToolContract, type AgentToolResult } from "./semantic";

/**
 * Settings of {@link ToolRunner}: approval policy, audit sink, retries and
 * deadlines, the same as `toolExecutorOptions` of the agent runtime. Register
 * a value in any module; `toolRunnerProviders` read it from the root container.
 */
export const TOOL_RUNNER_OPTIONS = createToken<ToolRunnerOptions>("ToolRunnerOptions");

export interface ToolRunnerOptions extends AgentToolExecutorOptions {
  /** Where unexpected tool failures go with their stack. Defaults to the application logger. */
  readonly logger?: Logger;
}

/** One call of {@link ToolRunner.run}. */
export interface ToolRunOptions extends Omit<AgentToolExecutionOptions, "agentName" | "allowUnboundTools"> {
  /** Id of the call in audit and hooks; a random uuid by default. */
  readonly callId?: string;
}

/**
 * Calls the application's Tools (`@Module.tools`) by name without a model: for
 * code that decides itself which Tool to run, such as a business-process
 * engine or a scheduled job. The call goes through the same executor as an
 * agent's call: input and output validation, DI scope, approval, audit,
 * hooks, retries and deadline. There is no agent, so the agent visibility
 * check does not apply; the caller decides which Tools it may run, for
 * example by `tags`.
 *
 * ```ts
 * const result = await this.tools.run("orders.find", { id: 42 }, { idempotencyKey: jobId });
 * if (result.status === "success") use(result.output);
 * ```
 */
export class ToolRunner {
  private readonly catalog: AgentRegistry;
  private readonly executor: AgentToolExecutor;

  constructor(services: ServiceProvider, options: ToolRunnerOptions = {}) {
    const { logger, ...executorOptions } = options;
    this.catalog = AgentRegistry.fromContainer(services);
    // Invalid options and hook setup fail here, at the first resolve, not on the first call.
    this.executor = new AgentToolExecutor(
      services,
      this.catalog,
      { schemaValidator: modelValidatorAdapter, ...executorOptions, allowUnboundTools: true },
      logger,
    );
  }

  /** All registered Tools, optionally only those that carry every one of `tags`. */
  listTools(tags: readonly string[] = []): readonly ToolDefinition[] {
    const tools = this.catalog.listTools();
    return tags.length === 0 ? tools : tools.filter((tool) => tags.every((tag) => tool.metadata.tags.includes(tag)));
  }

  /** The Tool registered under `name`, or `undefined`. */
  getTool(name: string): ToolDefinition | undefined {
    return this.catalog.getTool(name);
  }

  /** The Tool's contract with its generated input and output JSON schemas, or `undefined`. */
  describe(name: string): AgentToolContract | undefined {
    const tool = this.catalog.getTool(name);
    return tool === undefined ? undefined : describeTool(tool);
  }

  /**
   * Runs the Tool `name` with `input`. Never throws for a Tool failure: an
   * unknown name, invalid input, denial, timeout or an exception of the Tool
   * comes back as `status: "error"` or `"denied"` with `error.code`.
   */
  run(name: string, input: unknown, options: ToolRunOptions = {}): Promise<AgentToolResult> {
    const { callId, ...execution } = options;
    const call = agentToolCall({ id: callId ?? crypto.randomUUID(), name, input: input as never });
    return this.executor.execute(call, execution);
  }
}

/**
 * {@link ToolRunner} as a singleton injectable by type, with options from
 * {@link TOOL_RUNNER_OPTIONS}. The runner is built at start, so wrong options
 * or hooks without an audit sink stop the application instead of the first call.
 *
 * ```ts
 * @Module({ providers: [...toolRunnerProviders], exports: [ToolRunner] })
 * export class ToolsModule {}
 * ```
 */
export const toolRunnerProviders: readonly ProviderDefinition[] = Object.freeze([
  DI.singleton(DI.factoryProviderWithResolver(ToolRunner, [], (resolver) => {
    const services = resolver.resolve(SERVICE_PROVIDER);
    const options = services.has(TOOL_RUNNER_OPTIONS) ? services.resolve(TOOL_RUNNER_OPTIONS) : {};
    return new ToolRunner(services, { ...options, logger: options.logger ?? services.tryResolve(LOGGER) });
  })),
  DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => ({
    start() {
      try {
        resolver.resolve(ToolRunner);
      } catch (error) {
        if (error instanceof DiError) throw error;
        throw new DiError(`ToolRunner: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    stop() {},
  }))),
]);
