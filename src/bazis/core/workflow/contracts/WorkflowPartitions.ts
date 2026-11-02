import type { WorkflowPortContext } from "./WorkflowExtensions";

/** A partition a process is connected to. */
export interface ProcessPartition {
  /** `null`: the process runs without a partition. */
  readonly partition: string | null;
  /** An IANA time zone for the schedules of this partition; a time zone on the node goes first. */
  readonly timezone?: string;
  /** A process that is switched off here takes no events and no scheduled starts. */
  readonly enabled: boolean;
}

/**
 * Where a process works (WORKFLOW-002 §6): tenants, spaces, organizations. An
 * event starts a process only in a partition listed here, a schedule with
 * `partitions: "all"` runs in every enabled one, and a process connected to a
 * partition cannot be deleted. The application registers its implementation in
 * any module.
 */
export abstract class WorkflowPartitions {
  abstract of(processKey: string, context: WorkflowPortContext): readonly ProcessPartition[] | Promise<readonly ProcessPartition[]>;
}

/** By default a process has one place to work: no partition. */
export class DefaultWorkflowPartitions extends WorkflowPartitions {
  of(): readonly ProcessPartition[] {
    return [{ partition: null, enabled: true }];
  }
}
