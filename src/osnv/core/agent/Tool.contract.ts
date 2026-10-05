import { getGeneratedOpenApiMetadata, getGeneratedOpenApiSchemaName } from "../http/OpenApi/generatedOpenApiRegistry";
import type { ToolDefinition } from "./AgentRegistry";
import { inlineGeneratedSchema } from "./internal/Schema.contract";
import { agentClassSchema, agentJsonSchema, agentToolContract } from "./semantic";

/** The same generated contract is used by the local runtime and external executors. */
export function describeTool(tool: ToolDefinition) {
  const schema = (model: NonNullable<ToolDefinition["metadata"]["input"]>) => {
    const schemas = getGeneratedOpenApiMetadata().schemas;
    const name = getGeneratedOpenApiSchemaName(model) ?? model.name;
    return schemas[name] === undefined ? agentClassSchema(name)
      : agentJsonSchema(name, inlineGeneratedSchema(schemas[name], schemas));
  };
  return agentToolContract({
    name: tool.metadata.name, description: tool.metadata.description,
    input: tool.metadata.input ? schema(tool.metadata.input) : undefined,
    output: tool.metadata.output ? schema(tool.metadata.output) : undefined,
    sideEffect: tool.metadata.sideEffect, approval: tool.metadata.approval, timeoutMs: tool.metadata.timeoutMs,
  });
}
