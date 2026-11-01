import type { ToolExecutionOptions } from "bazis/core/agent";
import type { Logger } from "bazis/core/kernel";

/**
 * Every step leaves a line in the log; a published process is the approval of
 * its steps. Fields, not methods: the executor copies the options.
 */
export class ToolOptions implements ToolExecutionOptions {
  readonly auditSink: ToolExecutionOptions["auditSink"];
  readonly approvalPolicy: ToolExecutionOptions["approvalPolicy"];

  constructor(logger: Logger) {
    this.auditSink = (entry) => logger.info("tool", { phase: entry.phase, tool: entry.toolName, actor: entry.actor?.id });
    this.approvalPolicy = (request) => request.caller === "workflow";
  }
}
