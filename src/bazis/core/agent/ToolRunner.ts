import { DI, DiError, Global, HOSTED_SERVICE, Module, registerModuleMetadataExpander, SERVICE_PROVIDER, type BazisModuleMetadata, type ServiceProvider } from "../di";
import { LOGGER } from "../kernel/logging/Logger";
import { modelValidatorAdapter } from "../../library/validation";
import { AgentRegistry, type ToolDefinition } from "./AgentRegistry";
import { AgentToolExecutor, type AgentToolExecutionOptions } from "./AgentToolExecutor";
import { AgentSetupError } from "./errors";
import { callerId, type ToolActor } from "./metadata";
import { describeTool } from "./Tool.contract";
import { agentToolCall, agentToolResult, type AgentToolContract, type AgentToolResult } from "./semantic";
import { TOOL_EXECUTION_OPTIONS, type ToolExecutionOptions } from "./toolExecutionOptions";

/** One call of {@link BoundToolRunner.run}. */
export interface ToolRunOptions extends Omit<AgentToolExecutionOptions, "agentName" | "caller" | "actor"> {
  /** Id of the call in audit and hooks; a random uuid by default. */
  readonly callId?: string;
  /** On whose behalf the Tool runs. Required for `write` and `external` Tools. */
  readonly actor?: ToolActor;
}

/**
 * Runs the application's Tools without a model (TOOLS-001 §4). The framework
 * registers it whenever a module declares `tools`; code binds it to its caller
 * id and sees only the Tools whose `callers` list that id:
 *
 * ```ts
 * constructor(runner: ToolRunner) { this.tools = runner.as("workflow"); }
 * const result = await this.tools.run(step.toolName, input, { actor, idempotencyKey: stepId });
 * ```
 *
 * The call goes through the same executor as an agent's call: input and output
 * validation, DI scope, approval, audit, hooks, retries and deadline, configured
 * once with `TOOL_EXECUTION_OPTIONS`.
 */
export class ToolRunner {
  private readonly catalog: AgentRegistry;
  private readonly executor: AgentToolExecutor;

  constructor(services: ServiceProvider, options: ToolExecutionOptions = {}) {
    const { logger, ...executorOptions } = options;
    this.catalog = AgentRegistry.fromContainer(services);
    // Invalid options and hook setup fail here, when the runner is built at start.
    this.executor = new AgentToolExecutor(services, this.catalog, { schemaValidator: modelValidatorAdapter, ...executorOptions }, logger);
  }

  /** A view of the Tools this caller may run. `"agent"` is refused: agents run through `AgentRuntime`. */
  as(caller: string): BoundToolRunner {
    let id: string;
    try {
      id = callerId(caller);
    } catch {
      throw new AgentSetupError(`ToolRunner.as(${JSON.stringify(caller)}): a caller id is lower-case, such as "workflow".`);
    }
    if (id === "agent") throw new AgentSetupError('ToolRunner.as("agent"): agents run Tools through AgentRuntime.');
    return new BoundToolRunner(id, this.catalog, this.executor);
  }
}

/** {@link ToolRunner} bound to one caller id: it sees and runs only that caller's Tools. */
export class BoundToolRunner {
  constructor(
    readonly caller: string,
    private readonly catalog: AgentRegistry,
    private readonly executor: AgentToolExecutor,
  ) {}

  /** The Tools this caller may run, optionally only those that carry every one of `tags`. */
  listTools(tags: readonly string[] = []): readonly ToolDefinition[] {
    return this.catalog.listTools().filter((tool) => tool.metadata.callers.includes(this.caller) && tags.every((tag) => tool.metadata.tags.includes(tag)));
  }

  /** The Tool registered under `name` if this caller may run it, otherwise `undefined`. */
  getTool(name: string): ToolDefinition | undefined {
    const tool = this.catalog.getTool(name);
    return tool?.metadata.callers.includes(this.caller) ? tool : undefined;
  }

  /** The contract with the generated input and output JSON schemas, or `undefined`. */
  describe(name: string): AgentToolContract | undefined {
    const tool = this.getTool(name);
    return tool === undefined ? undefined : describeTool(tool);
  }

  /**
   * Runs the Tool `name` with `input`. Never throws for a Tool failure: an
   * unknown name, a Tool this caller may not run (TOOL_CALLER_NOT_ALLOWED),
   * invalid input, denial, timeout or an exception comes back as the result.
   */
  run(name: string, input: unknown, options: ToolRunOptions = {}): Promise<AgentToolResult> {
    const { callId, actor, ...execution } = options;
    const call = agentToolCall({ id: callId ?? crypto.randomUUID(), name, input: input as never });
    const tool = this.catalog.getTool(name);
    if (tool !== undefined && actor === undefined && (tool.metadata.sideEffect === "write" || tool.metadata.sideEffect === "external") && tool.metadata.callers.includes(this.caller)) {
      return Promise.resolve(agentToolResult({
        callId: call.id,
        name,
        status: "error",
        error: { code: "TOOL_ACTOR_REQUIRED", message: `Tool "${name}" changes data: pass actor, the user or system the call runs for.` },
        durationMs: 0,
        metadata: {},
      }));
    }
    return this.executor.execute(call, { ...execution, caller: this.caller, ...(actor === undefined ? {} : { actor }) });
  }
}

/** Provides ToolRunner once per application and builds it at start, so wrong options stop the start. */
@Global()
@Module({
  providers: [
    DI.singleton(DI.factoryProviderWithResolver(ToolRunner, [], (resolver) => {
      const services = resolver.resolve(SERVICE_PROVIDER);
      const options = services.has(TOOL_EXECUTION_OPTIONS) ? services.resolve(TOOL_EXECUTION_OPTIONS) : {};
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
  ],
  exports: [ToolRunner],
})
class ToolRunnerModule {}

// A module that declares Tools brings the runner; importing it twice is one module.
registerModuleMetadataExpander((metadata: BazisModuleMetadata) => {
  const tools = (metadata as { readonly tools?: readonly unknown[] }).tools;
  return Array.isArray(tools) && tools.length > 0 ? [ToolRunnerModule] : [];
});
