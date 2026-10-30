import { Global, Module, singletonValue, type BazisModuleRef } from "@/core/di";
import { TOOL_EXECUTION_OPTIONS, type ToolExecutionOptions } from "../toolExecutionOptions";

/** `root` plus the Tool execution settings, the way an application registers them (TOOLS-001 §6). */
export function withToolExecution(root: BazisModuleRef, options: ToolExecutionOptions): BazisModuleRef {
  @Global()
  @Module({ providers: [singletonValue(TOOL_EXECUTION_OPTIONS, options)], exports: [TOOL_EXECUTION_OPTIONS] })
  class ToolExecutionSettings {}
  return { imports: [root, ToolExecutionSettings] };
}
