import { DiContainer, type Class, type ServiceProvider } from "../di";
import { AgentSetupError } from "./errors";
import type { AgentDataDefinition } from "./AgentDataDefinition";
import { getAgentModuleContributionsV1 } from "./moduleContributions-v1";
import { toolMetadataOf, type ToolMetadata } from "./metadata";

/** A Tool of the application: the class registered in `@Module.tools` and its `@Tool` metadata. */
export interface ToolDefinition {
  readonly target: Class<object>;
  readonly metadata: ToolMetadata;
}

/** A meta-agent prepared for one run: its data and the Tools it may call. */
export interface AgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly modelProfile?: string;
  readonly tools: readonly ToolDefinition[];
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const containerCatalogs = new WeakMap<DiContainer, AgentRegistry>();

function snapshotTool(definition: ToolDefinition): ToolDefinition {
  return Object.freeze({
    target: definition.target,
    metadata: Object.freeze({ ...definition.metadata, tags: Object.freeze([...definition.metadata.tags]) }),
  });
}

/**
 * The Tools of an application (`fromContainer`) and, for one run, the
 * meta-agent allowed to call some of them (`fromDefinition`). An immutable
 * snapshot: a later change of the definition affects the next run only.
 */
export class AgentRegistry {
  private readonly toolsByName = new Map<string, ToolDefinition>();
  private readonly tools: readonly ToolDefinition[];
  private readonly agent?: AgentDefinition;

  private constructor(tools: readonly ToolDefinition[], agent?: AgentDefinition) {
    this.tools = Object.freeze(tools.map(snapshotTool));
    for (const tool of this.tools) {
      const existing = this.toolsByName.get(tool.metadata.name);
      if (existing !== undefined && existing.target !== tool.target) {
        throw new AgentSetupError(`Duplicate tool name "${tool.metadata.name}" on ${existing.target.name || "<anonymous class>"} and ${tool.target.name || "<anonymous class>"}.`);
      }
      this.toolsByName.set(tool.metadata.name, tool);
    }
    if (agent !== undefined) {
      this.agent = Object.freeze({ ...agent, tools: Object.freeze(agent.tools.map((tool) => this.toolsByName.get(tool.metadata.name) as ToolDefinition)) });
    }
  }

  /**
   * One meta-agent with the Tools it names, taken only from `allowedTools`
   * (the application's catalog). An unknown or repeated tool name is an
   * AgentSetupError before the model is called.
   */
  static fromDefinition(input: AgentDataDefinition, allowedTools: readonly ToolDefinition[] = []): AgentRegistry {
    if (!input || typeof input !== "object") throw new AgentSetupError("An agent definition must be an object.");
    if (typeof input.name !== "string" || !IDENTIFIER.test(input.name)) {
      throw new AgentSetupError("Agent name must be 1-128 latin letters, digits, dots, hyphens or underscores, starting with a letter or digit.");
    }
    if (typeof input.instructions !== "string" || input.instructions.length > 100_000) {
      throw new AgentSetupError(`Agent "${input.name}": instructions must be a string of at most 100000 characters.`);
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 4000)) {
      throw new AgentSetupError(`Agent "${input.name}": description must be a string of at most 4000 characters.`);
    }
    if (input.modelProfile !== undefined && (typeof input.modelProfile !== "string" || !IDENTIFIER.test(input.modelProfile))) {
      throw new AgentSetupError(`Agent "${input.name}": modelProfile must be an identifier of 1-128 characters.`);
    }
    if (input.toolNames !== undefined && (!Array.isArray(input.toolNames) || input.toolNames.length > 128)) {
      throw new AgentSetupError(`Agent "${input.name}": toolNames must be an array of at most 128 names.`);
    }
    const available = new Map<string, ToolDefinition>();
    for (const tool of allowedTools) {
      if (available.has(tool.metadata.name)) throw new AgentSetupError(`Duplicate tool name "${tool.metadata.name}" in the application catalog.`);
      available.set(tool.metadata.name, tool);
    }
    const seen = new Set<string>();
    const tools = (input.toolNames ?? []).map((name) => {
      if (typeof name !== "string") throw new AgentSetupError(`Agent "${input.name}": tool names must be strings.`);
      if (seen.has(name)) throw new AgentSetupError(`Agent "${input.name}": tool "${name}" is listed twice.`);
      const tool = available.get(name);
      if (tool === undefined) {
        const names = [...available.keys()].sort();
        throw new AgentSetupError(`Agent "${input.name}": tool "${name}" is not registered in the application${names.length ? ` (registered: ${names.join(", ")})` : " (no tools are registered in @Module.tools)"}.`);
      }
      seen.add(name);
      return tool;
    });
    const agent: AgentDefinition = {
      name: input.name,
      instructions: input.instructions,
      tools,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.modelProfile === undefined ? {} : { modelProfile: input.modelProfile }),
    };
    // The whole catalog stays known so that a call of an unnamed tool is denied as
    // not visible to this agent; the model is offered only `agent.tools`.
    return new AgentRegistry(allowedTools, agent);
  }

  /** The application's Tools from the `@Module.tools` registrations, without constructing them. */
  static fromContainer(services: ServiceProvider): AgentRegistry {
    if (!(services instanceof DiContainer)) throw new AgentSetupError("The Tool catalog requires the framework DiContainer.");
    const existing = containerCatalogs.get(services);
    if (existing) return existing;
    const tools = getAgentModuleContributionsV1(services).tools.map(({ payload }) => {
      const metadata = toolMetadataOf(payload.target);
      if (metadata === undefined) throw new AgentSetupError(`${payload.target.name || "<anonymous class>"} is listed in @Module.tools but is not decorated with @Tool(...).`);
      return { target: payload.target, metadata };
    });
    const registry = new AgentRegistry(tools);
    containerCatalogs.set(services, registry);
    return registry;
  }

  listTools(): readonly ToolDefinition[] {
    return this.tools;
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  requireTool(name: string): ToolDefinition {
    const definition = this.getTool(name);
    if (!definition) throw new AgentSetupError(`Tool "${name}" is not registered.`);
    return definition;
  }

  getAgent(name: string): AgentDefinition | undefined {
    return this.agent?.name === name ? this.agent : undefined;
  }

  requireAgent(name: string): AgentDefinition {
    const definition = this.getAgent(name);
    if (!definition) throw new AgentSetupError(`Agent "${name}" is not part of this run.`);
    return definition;
  }
}
