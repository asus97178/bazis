import { defineAgentTaskMetadata, type AgentTaskOptions } from "../metadata";

type TaskDecorator = (value: (...args: never[]) => unknown, context: ClassMethodDecoratorContext) => void;

export type TaskDecoratorOptions = string | AgentTaskOptions;

function normalizeOptions(options: TaskDecoratorOptions | undefined): AgentTaskOptions {
  if (options === undefined) {
    return {};
  }
  if (typeof options === "string") {
    return { name: options };
  }
  return options;
}

/**
 * Declares an executable agent task on an @Agent class. This mirrors
 * controller action decorators: the method is a business operation contract,
 * while AgentRuntime performs the actual AI execution.
 */
export function Task(options?: TaskDecoratorOptions): TaskDecorator {
  return (_value, context) => {
    if (context.static || context.private) {
      throw new Error(`@Task supports public instance methods only ("${String(context.name)}").`);
    }
    defineAgentTaskMetadata(context.name, context.metadata, normalizeOptions(options));
  };
}
