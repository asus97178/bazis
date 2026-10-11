import type { Class, DiContainer } from "@/core/di";
import type { AgentDataDefinition } from "../AgentDataDefinition";
import { AgentRegistry } from "../AgentRegistry";
import { toolMetadataOf } from "../metadata";

export interface TestAgentOptions {
  readonly name: string;
  readonly instructions?: string;
  readonly description?: string;
  readonly modelProfile?: string;
  /** `@Tool` classes; the definition names them in `toolNames`. */
  readonly tools?: readonly Class<object>[];
}

/** A meta-agent definition whose `toolNames` come from `@Tool` classes. */
export function agentDefinition(options: TestAgentOptions): AgentDataDefinition {
  return {
    name: options.name,
    instructions: options.instructions ?? "",
    toolNames: (options.tools ?? []).map((tool) => {
      const metadata = toolMetadataOf(tool);
      if (metadata === undefined) throw new Error(`${tool.name} has no @Tool metadata.`);
      return metadata.name;
    }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.modelProfile === undefined ? {} : { modelProfile: options.modelProfile }),
  };
}

/** The run registry `AgentRuntime.run` builds: the definition over the container's Tool catalog. */
export function agentRegistry(container: DiContainer, definition: AgentDataDefinition): AgentRegistry {
  return AgentRegistry.fromDefinition(definition, AgentRegistry.fromContainer(container).listTools());
}
