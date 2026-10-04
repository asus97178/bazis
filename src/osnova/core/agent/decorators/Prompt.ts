import { definePromptMetadata, type PromptOptions } from "../metadata";

/**
 * Declares a reusable prompt contract. Prompts are metadata classes so modules
 * can own and version them without exposing provider-specific APIs.
 */
export function Prompt(options: PromptOptions = {}) {
  return (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    definePromptMetadata(value, context.metadata, options);
  };
}
