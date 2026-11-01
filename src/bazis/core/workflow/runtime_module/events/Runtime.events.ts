import { createEventToken } from "../../../kernel";
import type { FormSpec, LocalizedText } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";
import type { InstanceStatus, StartedVia } from "../model/WfInstance.model";

/** A token reached a user task. Published after the step commits. */
export interface WorkflowTaskRequested {
  readonly instanceId: string;
  readonly tokenId: string;
  readonly processKey: string;
  readonly nodeId: string;
  readonly partition: string | null;
  readonly title: LocalizedText;
  readonly assignee: { readonly role: string } | { readonly user: string };
  readonly form: FormSpec | null;
  /** When the task is due, from the node's `dueIn`. */
  readonly dueAt: Date | null;
}

/** A waiting token was closed otherwise than by its task: the task is dropped. */
export interface WorkflowTokenClosed {
  readonly instanceId: string;
  readonly tokenId: string;
  /** `cancelled` — the instance was cancelled; `interrupted` — a boundary timer took over the step. */
  readonly reason: "cancelled" | "interrupted";
}

/** An instance finished: completed or cancelled. */
export interface WorkflowInstanceFinished {
  readonly instanceId: string;
  readonly processKey: string;
  readonly partition: string | null;
  readonly status: Extract<InstanceStatus, "completed" | "cancelled">;
}

/** Retention deleted these finished instances with their tokens and history. */
export interface WorkflowInstancesDeleted {
  readonly instanceIds: readonly string[];
}

/** What the audit events of an instance share. Published after the commit. */
interface WorkflowInstanceAudit {
  readonly instanceId: string;
  readonly processKey: string;
  readonly partition: string | null;
  readonly actor: WorkflowActor;
  readonly request: WorkflowRequest | null;
}

/** An instance started: by hand, from an event or on schedule. */
export interface WorkflowInstanceStarted extends WorkflowInstanceAudit {
  readonly version: number;
  readonly businessKey: string | null;
  readonly startedVia: StartedVia;
}

export interface WorkflowInstanceCancelled extends WorkflowInstanceAudit {
  readonly reason: string | null;
}

/** The failed steps of an instance run again. */
export type WorkflowInstanceRetried = WorkflowInstanceAudit;

export const WORKFLOW_TASK_REQUESTED = createEventToken<WorkflowTaskRequested>("workflow.task-requested");
export const WORKFLOW_TOKEN_CLOSED = createEventToken<WorkflowTokenClosed>("workflow.token-closed");
export const WORKFLOW_INSTANCE_FINISHED = createEventToken<WorkflowInstanceFinished>("workflow.instance-finished");
export const WORKFLOW_INSTANCES_DELETED = createEventToken<WorkflowInstancesDeleted>("workflow.instances-deleted");
export const WORKFLOW_INSTANCE_STARTED = createEventToken<WorkflowInstanceStarted>("workflow.instance-started");
export const WORKFLOW_INSTANCE_CANCELLED = createEventToken<WorkflowInstanceCancelled>("workflow.instance-cancelled");
export const WORKFLOW_INSTANCE_RETRIED = createEventToken<WorkflowInstanceRetried>("workflow.instance-retried");
