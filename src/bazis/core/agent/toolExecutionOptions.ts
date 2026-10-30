import { createToken } from "../di";
import type { Logger } from "../kernel/logging/Logger";
import type { AgentToolExecutorOptions } from "./AgentToolExecutor";

/**
 * How Tools run for every caller: approval policy, audit sink, retries,
 * deadlines and hooks. Register one value in any module; `AgentRuntime` and
 * `ToolRunner` read it from the root container (TOOLS-001 §6).
 */
export interface ToolExecutionOptions extends AgentToolExecutorOptions {
  /** Where unexpected Tool failures go with their stack. Defaults to the application logger. */
  readonly logger?: Logger;
}

export const TOOL_EXECUTION_OPTIONS = createToken<ToolExecutionOptions>("ToolExecutionOptions");
