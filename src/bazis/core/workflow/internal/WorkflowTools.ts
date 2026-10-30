import type { ServiceResolver } from "../../di";
import { ToolRunner, type AgentToolContract, type BoundToolRunner } from "../../agent";

/** The workflow caller id of TOOLS-001: processes run only Tools whose `callers` list it. */
export const WORKFLOW_CALLER = "workflow";

/**
 * The application's Tools as processes see them. `ToolRunner` exists only when
 * a module declares `tools`; without it there is nothing to call.
 */
export class WorkflowTools {
  private readonly runner: BoundToolRunner | undefined;

  constructor(services: ServiceResolver) {
    this.runner = services.tryResolve(ToolRunner)?.as(WORKFLOW_CALLER);
  }

  /** Whether a service task may call `name`. */
  has(name: string): boolean {
    return this.runner?.getTool(name) !== undefined;
  }

  /** Contracts of every Tool processes may call, by name. */
  list(): readonly AgentToolContract[] {
    if (this.runner === undefined) return [];
    return this.runner.listTools()
      .map((tool) => this.runner!.describe(tool.metadata.name))
      .filter((contract): contract is AgentToolContract => contract !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The bound runner; `undefined` when the application has no Tools. */
  get bound(): BoundToolRunner | undefined {
    return this.runner;
  }
}
