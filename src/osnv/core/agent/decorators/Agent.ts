import { defineAgentMetadata, type AgentOptions } from "../metadata";

/**
 * Declares an executable agent class. The class stays a regular DI service;
 * this decorator only adds framework metadata for discovery and validation.
 */
export function Agent(options: AgentOptions = {}) {
  return (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    defineAgentMetadata(value, context.metadata, options);
  };
}
