import { defineToolMetadata, type ToolOptions } from "../metadata";

/**
 * Declares a tool callable by an agent. Side-effect and approval metadata is
 * required by the future runtime policy layer; unsafe write/external tools are
 * approval-gated by default.
 */
export function Tool(options: ToolOptions) {
  return (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    defineToolMetadata(value, context.metadata, options);
  };
}
