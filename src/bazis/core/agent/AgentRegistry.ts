import { DiContainer, expandModuleMetadata, type Class, type BazisModuleRef, type ServiceProvider } from "../di";
import { loadBazisGeneratedAgentMetadata } from "../generatedRuntime";
import { AgentSetupError } from "./errors";
import type { AgentDataDefinition } from "./AgentDataDefinition";
import { getAgentModuleContributionsV1 } from "./moduleContributions-v1";
import {
  agentMetadataOf,
  promptMetadataOf,
  toolMetadataOf,
  type AgentMetadata,
  type AgentTaskMetadata,
  type PromptMetadata,
  type ToolMetadata,
} from "./metadata";

export interface AgentDefinition {
  readonly target: Class<object>;
  readonly metadata: AgentMetadata;
  readonly prompt?: PromptDefinition;
  readonly tools: readonly ToolDefinition[];
  readonly tasks: readonly AgentTaskDefinition[];
}

export interface ToolDefinition {
  readonly target: Class<object>;
  readonly metadata: ToolMetadata;
}

export interface PromptDefinition {
  readonly target: Class<object>;
  readonly metadata: PromptMetadata;
}

export interface AgentTaskDefinition {
  readonly agent: AgentDefinition;
  readonly metadata: AgentTaskMetadata;
}

export interface AgentCatalog {
  readonly agents: readonly AgentDefinition[];
  readonly tools: readonly ToolDefinition[];
  readonly prompts: readonly PromptDefinition[];
}

export interface AgentCatalogExtras {
  readonly agents?: readonly Class<object>[];
  readonly tools?: readonly Class<object>[];
  readonly prompts?: readonly Class<object>[];
}

export interface AgentMetadataIndex {
  readonly agents: ReadonlyMap<Class<object>, AgentMetadata>;
  readonly tools: ReadonlyMap<Class<object>, ToolMetadata>;
  readonly prompts: ReadonlyMap<Class<object>, PromptMetadata>;
}

interface AgentModuleFields {
  readonly agents?: readonly Class<object>[];
  readonly tools?: readonly Class<object>[];
  readonly prompts?: readonly Class<object>[];
}

// Compatibility identity for the class-based catalog contract. Never instantiated;
// data agents have no decorated tasks or module registrations.
class DataAgentTarget {}

const containerCatalogs = new WeakMap<DiContainer, AgentRegistry>();

function debugNameOf(target: Class<object>): string {
  return target.name || "<anonymous class>";
}

function appendClass(target: Class<object>, out: Class<object>[], seen: Set<Class<object>>): void {
  if (!seen.has(target)) {
    seen.add(target);
    out.push(target);
  }
}

function appendClasses(
  values: readonly Class<object>[] | undefined,
  out: Class<object>[],
  seen: Set<Class<object>>,
): void {
  if (values === undefined) {
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    appendClass(values[index] as Class<object>, out, seen);
  }
}

function assertUniqueName(
  kind: "agent" | "tool" | "prompt",
  name: string,
  target: Class<object>,
  names: Map<string, Class<object>>,
): void {
  const existing = names.get(name);
  if (existing && existing !== target) {
    throw new AgentSetupError(
      `Duplicate ${kind} name "${name}" on ${debugNameOf(existing)} and ${debugNameOf(target)}.`,
    );
  }
  names.set(name, target);
}

function assertUniqueTaskName(agentName: string, task: AgentTaskMetadata, names: Map<string, AgentTaskMetadata>): void {
  const existing = names.get(task.name);
  if (existing && existing.methodName !== task.methodName) {
    throw new AgentSetupError(
      `Duplicate task name "${task.name}" on Agent "${agentName}" methods ` +
        `"${existing.methodName}" and "${task.methodName}".`,
    );
  }
  names.set(task.name, task);
}

function registerDefinition<TDefinition extends { readonly target: Class<object>; readonly metadata: { readonly name: string } }>(
  kind: "agent" | "tool" | "prompt",
  definition: TDefinition,
  byName: Map<string, TDefinition>,
  names: Map<string, Class<object>>,
): void {
  assertUniqueName(kind, definition.metadata.name, definition.target, names);
  byName.set(definition.metadata.name, definition);
}

function readAgentMetadata(target: Class<object>, metadataIndex?: AgentMetadataIndex): AgentMetadata | undefined {
  return metadataIndex?.agents.get(target) ?? agentMetadataOf(target);
}

function readToolMetadata(target: Class<object>, metadataIndex?: AgentMetadataIndex): ToolMetadata | undefined {
  return metadataIndex?.tools.get(target) ?? toolMetadataOf(target);
}

function readPromptMetadata(target: Class<object>, metadataIndex?: AgentMetadataIndex): PromptMetadata | undefined {
  return metadataIndex?.prompts.get(target) ?? promptMetadataOf(target);
}

function requireAgentMetadata(target: Class<object>, metadataIndex?: AgentMetadataIndex): AgentMetadata {
  const metadata = readAgentMetadata(target, metadataIndex);
  if (!metadata) {
    throw new AgentSetupError(`${debugNameOf(target)} is listed as an agent but is not decorated with @Agent(...).`);
  }
  return metadata;
}

function requireToolMetadata(target: Class<object>, owner?: string, metadataIndex?: AgentMetadataIndex): ToolMetadata {
  const metadata = readToolMetadata(target, metadataIndex);
  if (!metadata) {
    const prefix = owner ? `${owner} references ` : "";
    throw new AgentSetupError(`${prefix}${debugNameOf(target)} as a tool, but it is not decorated with @Tool(...).`);
  }
  return metadata;
}

function requirePromptMetadata(target: Class<object>, owner?: string, metadataIndex?: AgentMetadataIndex): PromptMetadata {
  const metadata = readPromptMetadata(target, metadataIndex);
  if (!metadata) {
    const prefix = owner ? `${owner} references ` : "";
    throw new AgentSetupError(`${prefix}${debugNameOf(target)} as a prompt, but it is not decorated with @Prompt(...).`);
  }
  return metadata;
}

function emptyCatalog(): AgentCatalog {
  return Object.freeze({
    agents: Object.freeze([]),
    tools: Object.freeze([]),
    prompts: Object.freeze([]),
  });
}

/**
 * Collects agent declarations from a module tree. The collector follows
 * `imports` and registered module metadata expanders, just like DI/container
 * discovery, but it keeps the AI layer outside the DI foundation.
 */
export function collectAgentCatalog(
  roots: readonly BazisModuleRef[],
  extras: AgentCatalogExtras = {},
  metadataIndex?: AgentMetadataIndex,
): AgentCatalog {
  if (roots.length === 0 && !extras.agents?.length && !extras.tools?.length && !extras.prompts?.length) {
    return emptyCatalog();
  }

  const loaded = new Set<BazisModuleRef>();
  const seenAgents = new Set<Class<object>>();
  const seenTools = new Set<Class<object>>();
  const seenPrompts = new Set<Class<object>>();
  const agentClasses: Class<object>[] = [];
  const toolClasses: Class<object>[] = [];
  const promptClasses: Class<object>[] = [];

  const visit = (moduleRef: BazisModuleRef): void => {
    if (loaded.has(moduleRef)) {
      return;
    }
    loaded.add(moduleRef);

    const agentFields = moduleRef as AgentModuleFields;
    appendClasses(agentFields.agents, agentClasses, seenAgents);
    appendClasses(agentFields.tools, toolClasses, seenTools);
    appendClasses(agentFields.prompts, promptClasses, seenPrompts);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        visit(imports[index] as BazisModuleRef);
      }
    }

    const expanded = expandModuleMetadata(moduleRef);
    for (let index = 0; index < expanded.length; index += 1) {
      visit(expanded[index] as BazisModuleRef);
    }
  };

  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index] as BazisModuleRef);
  }
  appendClasses(extras.agents, agentClasses, seenAgents);
  appendClasses(extras.tools, toolClasses, seenTools);
  appendClasses(extras.prompts, promptClasses, seenPrompts);

  const agentNames = new Map<string, Class<object>>();
  const agentsMeta = new Map<Class<object>, AgentMetadata>();
  for (let index = 0; index < agentClasses.length; index += 1) {
    const target = agentClasses[index] as Class<object>;
    const metadata = requireAgentMetadata(target, metadataIndex);
    assertUniqueName("agent", metadata.name, target, agentNames);
    const taskNames = new Map<string, AgentTaskMetadata>();
    for (let taskIndex = 0; taskIndex < metadata.tasks.length; taskIndex += 1) {
      assertUniqueTaskName(metadata.name, metadata.tasks[taskIndex] as AgentTaskMetadata, taskNames);
    }
    agentsMeta.set(target, metadata);
    const agentName = `Agent "${metadata.name}"`;
    if (metadata.prompt) {
      requirePromptMetadata(metadata.prompt, agentName, metadataIndex);
      appendClass(metadata.prompt, promptClasses, seenPrompts);
    }
    for (let toolIndex = 0; toolIndex < metadata.tools.length; toolIndex += 1) {
      requireToolMetadata(metadata.tools[toolIndex] as Class<object>, agentName, metadataIndex);
    }
    appendClasses(metadata.tools, toolClasses, seenTools);
  }

  const toolNames = new Map<string, Class<object>>();
  const toolsByClass = new Map<Class<object>, ToolDefinition>();
  const tools: ToolDefinition[] = [];
  for (let index = 0; index < toolClasses.length; index += 1) {
    const target = toolClasses[index] as Class<object>;
    const metadata = requireToolMetadata(target, undefined, metadataIndex);
    assertUniqueName("tool", metadata.name, target, toolNames);
    const definition: ToolDefinition = Object.freeze({ target, metadata });
    toolsByClass.set(target, definition);
    tools.push(definition);
  }

  const promptNames = new Map<string, Class<object>>();
  const promptsByClass = new Map<Class<object>, PromptDefinition>();
  const prompts: PromptDefinition[] = [];
  for (let index = 0; index < promptClasses.length; index += 1) {
    const target = promptClasses[index] as Class<object>;
    const metadata = requirePromptMetadata(target, undefined, metadataIndex);
    assertUniqueName("prompt", metadata.name, target, promptNames);
    const definition: PromptDefinition = Object.freeze({ target, metadata });
    promptsByClass.set(target, definition);
    prompts.push(definition);
  }

  const agents: AgentDefinition[] = [];
  for (let index = 0; index < agentClasses.length; index += 1) {
    const target = agentClasses[index] as Class<object>;
    const metadata = agentsMeta.get(target) as AgentMetadata;
    const agentName = `Agent "${metadata.name}"`;
    const resolvedTools: ToolDefinition[] = [];
    for (let toolIndex = 0; toolIndex < metadata.tools.length; toolIndex += 1) {
      const toolTarget = metadata.tools[toolIndex] as Class<object>;
      requireToolMetadata(toolTarget, agentName, metadataIndex);
      resolvedTools.push(toolsByClass.get(toolTarget) as ToolDefinition);
    }

    let prompt: PromptDefinition | undefined;
    if (metadata.prompt) {
      requirePromptMetadata(metadata.prompt, agentName, metadataIndex);
      prompt = promptsByClass.get(metadata.prompt);
    }

    const agentDefinition = {
      target,
      metadata,
      prompt,
      tools: Object.freeze(resolvedTools),
      tasks: [] as AgentTaskDefinition[],
    } as AgentDefinition & { tasks: AgentTaskDefinition[] };
    for (let taskIndex = 0; taskIndex < metadata.tasks.length; taskIndex += 1) {
      agentDefinition.tasks.push(Object.freeze({
        agent: agentDefinition,
        metadata: metadata.tasks[taskIndex] as AgentTaskMetadata,
      }));
    }
    Object.freeze(agentDefinition.tasks);
    agents.push(Object.freeze(agentDefinition));
  }

  return Object.freeze({
    agents: Object.freeze(agents),
    tools: Object.freeze(tools),
    prompts: Object.freeze(prompts),
  });
}

export class AgentRegistry {
  private readonly catalog: AgentCatalog;
  private readonly agentsByName = new Map<string, AgentDefinition>();
  private readonly toolsByName = new Map<string, ToolDefinition>();
  private readonly promptsByName = new Map<string, PromptDefinition>();
  private readonly tasksByAgentAndName = new Map<string, AgentTaskDefinition>();

  constructor(catalog: AgentCatalog = emptyCatalog()) {
    // The registry is a snapshot: callers must not be able to mutate its list
    // view after indexes and task backlinks have been constructed.
    // Definitions can be present only on an Agent. Memoization is intentionally
    // by source object, not class: two source definitions for one class may
    // carry different valid metadata, while a shared definition needs one
    // shared immutable snapshot wherever it is referenced.
    const toolSnapshots = new WeakMap<ToolDefinition, ToolDefinition>();
    const promptSnapshots = new WeakMap<PromptDefinition, PromptDefinition>();
    const taskMetadataSnapshots = new WeakMap<AgentTaskMetadata, AgentTaskMetadata>();
    const snapshotTool = (definition: ToolDefinition): ToolDefinition => {
      const existing = toolSnapshots.get(definition);
      if (existing) return existing;
      const snapshot = Object.freeze({
        target: definition.target,
        metadata: Object.freeze({ ...definition.metadata, tags: Object.freeze([...definition.metadata.tags]) }),
      });
      toolSnapshots.set(definition, snapshot);
      return snapshot;
    };
    const snapshotPrompt = (definition: PromptDefinition): PromptDefinition => {
      const existing = promptSnapshots.get(definition);
      if (existing) return existing;
      const snapshot = Object.freeze({
        target: definition.target,
        metadata: Object.freeze({
          ...definition.metadata,
          instructions: Object.freeze([...definition.metadata.instructions]),
          constraints: Object.freeze([...definition.metadata.constraints]),
          sections: Object.freeze(definition.metadata.sections.map((section) => Object.freeze({ ...section, content: Object.freeze([...section.content]) }))),
        }),
      });
      promptSnapshots.set(definition, snapshot);
      return snapshot;
    };
    const snapshotTaskMetadata = (metadata: AgentTaskMetadata): AgentTaskMetadata => {
      const existing = taskMetadataSnapshots.get(metadata);
      if (existing) return existing;
      const snapshot = Object.freeze({ ...metadata });
      taskMetadataSnapshots.set(metadata, snapshot);
      return snapshot;
    };
    const tools = Object.freeze(catalog.tools.map(snapshotTool));
    const prompts = Object.freeze(catalog.prompts.map(snapshotPrompt));
    const agents = Object.freeze(catalog.agents.map((definition) => {
      const metadata = Object.freeze({
        ...definition.metadata,
        instructions: Object.freeze([...definition.metadata.instructions]), constraints: Object.freeze([...definition.metadata.constraints]),
        sections: Object.freeze(definition.metadata.sections.map((section) => Object.freeze({ ...section, content: Object.freeze([...section.content]) }))),
        tools: Object.freeze([...definition.metadata.tools]),
        tasks: Object.freeze(definition.metadata.tasks.map(snapshotTaskMetadata)),
      });
      const agent = { target: definition.target, metadata, prompt: definition.prompt === undefined ? undefined : snapshotPrompt(definition.prompt), tools: Object.freeze(definition.tools.map(snapshotTool)), tasks: [] as AgentTaskDefinition[] } as AgentDefinition & { tasks: AgentTaskDefinition[] };
      agent.tasks.push(...definition.tasks.map((task) => Object.freeze({ agent, metadata: snapshotTaskMetadata(task.metadata) })));
      Object.freeze(agent.tasks);
      return Object.freeze(agent);
    }));
    this.catalog = Object.freeze({ agents, tools, prompts });

    const agentNames = new Map<string, Class<object>>();
    const toolNames = new Map<string, Class<object>>();
    const promptNames = new Map<string, Class<object>>();

    for (let index = 0; index < agents.length; index += 1) {
      const definition = agents[index] as AgentDefinition;
      registerDefinition("agent", definition, this.agentsByName, agentNames);
      for (let taskIndex = 0; taskIndex < definition.tasks.length; taskIndex += 1) {
        const task = definition.tasks[taskIndex] as AgentTaskDefinition;
        this.tasksByAgentAndName.set(taskKey(definition.metadata.name, task.metadata.name), task);
      }
    }
    for (let index = 0; index < tools.length; index += 1) {
      const definition = tools[index] as ToolDefinition;
      registerDefinition("tool", definition, this.toolsByName, toolNames);
    }
    for (let index = 0; index < prompts.length; index += 1) {
      const definition = prompts[index] as PromptDefinition;
      registerDefinition("prompt", definition, this.promptsByName, promptNames);
    }
  }

  /** Each invocation gets an immutable data snapshot and only host-approved tools. */
  static fromDefinition(input: AgentDataDefinition, allowedTools: readonly ToolDefinition[] = []): AgentRegistry {
    if (!input || typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.name)
      || typeof input.instructions !== "string" || input.instructions.length > 100_000
      || (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 4000))
      || (input.modelProfile !== undefined && (typeof input.modelProfile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.modelProfile)))
      || (input.toolNames !== undefined && (!Array.isArray(input.toolNames) || input.toolNames.length > 128))) {
      throw new AgentSetupError("Invalid data agent definition.");
    }
    const available = new Map<string, ToolDefinition>();
    for (const tool of allowedTools) {
      if (available.has(tool.metadata.name)) throw new AgentSetupError("Duplicate host tool name.");
      available.set(tool.metadata.name, tool);
    }
    const seen = new Set<string>();
    const tools = (input.toolNames ?? []).map(name => {
      const tool = available.get(name);
      if (typeof name !== "string" || !tool || seen.has(name)) throw new AgentSetupError("Agent tool is unavailable or duplicated.");
      seen.add(name);
      return tool;
    });
    const metadata: AgentMetadata = {
      name: input.name, description: input.description, modelProfile: input.modelProfile,
      instructions: input.instructions.trim() ? [input.instructions] : [],
      constraints: [], sections: [], tasks: [], tools: tools.map(tool => tool.target),
    };
    return new AgentRegistry({ agents: [{ target: DataAgentTarget, metadata, tools, tasks: [] }], tools, prompts: [] });
  }

  static fromModules(roots: readonly BazisModuleRef[], extras?: AgentCatalogExtras): AgentRegistry {
    return new AgentRegistry(collectAgentCatalog(roots, extras));
  }

  /** Host Tool catalog from actual owner-bound registrations, without constructing Tools or importing the app root. */
  static fromContainer(services: ServiceProvider): AgentRegistry {
    if (!(services instanceof DiContainer)) throw new AgentSetupError("A host Tool catalog requires a framework DiContainer.");
    const existing = containerCatalogs.get(services);
    if (existing) return existing;
    const tools = getAgentModuleContributionsV1(services).tools.map(({ payload }) => ({
      target: payload.target, metadata: requireToolMetadata(payload.target),
    }));
    const registry = new AgentRegistry({ agents: [], prompts: [], tools });
    containerCatalogs.set(services, registry);
    return registry;
  }

  static async fromGeneratedModules(roots: readonly BazisModuleRef[], extras?: AgentCatalogExtras): Promise<AgentRegistry> {
    const generated = await loadBazisGeneratedAgentMetadata(collectAgentMetadataTargets(roots, extras));
    return new AgentRegistry(collectAgentCatalog(roots, extras, generated));
  }

  listAgents(): readonly AgentDefinition[] {
    return this.catalog.agents;
  }

  listTools(): readonly ToolDefinition[] {
    return this.catalog.tools;
  }

  listPrompts(): readonly PromptDefinition[] {
    return this.catalog.prompts;
  }

  getAgent(name: string): AgentDefinition | undefined {
    return this.agentsByName.get(name);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  getPrompt(name: string): PromptDefinition | undefined {
    return this.promptsByName.get(name);
  }

  getTask(agentName: string, taskName: string): AgentTaskDefinition | undefined {
    return this.tasksByAgentAndName.get(taskKey(agentName, taskName));
  }

  requireAgent(name: string): AgentDefinition {
    const definition = this.getAgent(name);
    if (!definition) {
      throw new AgentSetupError(`Agent "${name}" is not registered.`);
    }
    return definition;
  }

  requireTool(name: string): ToolDefinition {
    const definition = this.getTool(name);
    if (!definition) {
      throw new AgentSetupError(`Tool "${name}" is not registered.`);
    }
    return definition;
  }

  requirePrompt(name: string): PromptDefinition {
    const definition = this.getPrompt(name);
    if (!definition) {
      throw new AgentSetupError(`Prompt "${name}" is not registered.`);
    }
    return definition;
  }

  requireTask(agentName: string, taskName: string): AgentTaskDefinition {
    const definition = this.getTask(agentName, taskName);
    if (!definition) {
      throw new AgentSetupError(`Task "${taskName}" is not registered on Agent "${agentName}".`);
    }
    return definition;
  }
}

function collectAgentMetadataTargets(roots: readonly BazisModuleRef[], extras: AgentCatalogExtras = {}): readonly Class<object>[] {
  const loaded = new Set<BazisModuleRef>();
  const targets: Class<object>[] = [];
  const seen = new Set<Class<object>>();
  const visit = (moduleRef: BazisModuleRef): void => {
    if (loaded.has(moduleRef)) return;
    loaded.add(moduleRef);
    const fields = moduleRef as AgentModuleFields;
    appendClasses(fields.agents, targets, seen);
    appendClasses(fields.tools, targets, seen);
    appendClasses(fields.prompts, targets, seen);
    for (const imported of moduleRef.imports ?? []) visit(imported as BazisModuleRef);
    for (const expanded of expandModuleMetadata(moduleRef)) visit(expanded as BazisModuleRef);
  };
  for (const root of roots) visit(root);
  appendClasses(extras.agents, targets, seen);
  appendClasses(extras.tools, targets, seen);
  appendClasses(extras.prompts, targets, seen);
  return targets;
}

function taskKey(agentName: string, taskName: string): string {
  return `${agentName}\u0000${taskName}`;
}
