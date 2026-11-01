import type { FormSpec } from "../../../../library/workflow";
import type { AccessFilter, ScopePrincipals } from "../../../access";
import type { WorkflowActor, WorkflowAuditOptions, WorkflowPage, WorkflowPaging } from "../../contracts/types";
import type { TaskStatus } from "../model/WfTask.model";

export interface TaskDetails {
  readonly id: string;
  readonly instanceId: string;
  readonly tokenId: string;
  readonly processKey: string;
  readonly nodeId: string;
  readonly partition: string | null;
  readonly title: string;
  readonly assignee: string;
  readonly form: FormSpec | null;
  readonly dueAt: Date | null;
  readonly status: TaskStatus;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly completedBy: string | null;
  readonly completedAt: Date | null;
  readonly output: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface TaskListQuery extends WorkflowPaging {
  /** Tasks addressed to these (`role:support`, `user:42`) in their partition, plus those the actor claimed. */
  readonly addressees: readonly ScopePrincipals[];
  /** Whose claimed tasks count as theirs. */
  readonly actor?: WorkflowActor;
  /** Which tasks the caller may see, from `IAccess`; without it the calling code has decided. */
  readonly access?: AccessFilter;
  /** `open` and `claimed` by default. */
  readonly status?: readonly TaskStatus[];
  readonly partition?: string;
  readonly processKey?: string;
}

/**
 * Tasks for people (WORKFLOW-001 §5): the inbox of `userTask` steps. A task
 * appears when its step starts waiting and is cancelled when the step closes
 * otherwise. Errors are {@link WorkflowError}: `not_found`, `conflict` (claimed
 * by another person), `wrong_status`, `invalid_input` with the form issues.
 */
export abstract class IWorkflowTasks {
  /** The tasks of these addressees, oldest first. */
  abstract list(query: TaskListQuery): Promise<WorkflowPage<TaskDetails>>;
  /** The partitions that have tasks in these statuses (`open` and `claimed` by default): where to ask for addressees. */
  abstract partitions(query?: { readonly status?: readonly TaskStatus[] }): Promise<readonly (string | null)[]>;
  abstract get(taskId: string): Promise<TaskDetails>;
  /** Takes an open task: nobody else can complete it until it is released. */
  abstract claim(taskId: string, actor: WorkflowActor): Promise<TaskDetails>;
  /** Gives a claimed task back. */
  abstract release(taskId: string, actor: WorkflowActor): Promise<TaskDetails>;
  /** Fills the form: the process moves on. */
  abstract complete(taskId: string, output: unknown, actor: WorkflowActor, options?: WorkflowAuditOptions): Promise<TaskDetails>;
}
