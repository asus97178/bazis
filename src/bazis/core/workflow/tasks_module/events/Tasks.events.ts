import { createEventToken } from "../../../kernel";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";

/** A person filled a task's form, for the application's audit. Published after it is saved. */
export interface WorkflowTaskCompleted {
  readonly taskId: string;
  readonly instanceId: string;
  readonly processKey: string;
  readonly nodeId: string;
  readonly partition: string | null;
  readonly actor: WorkflowActor;
  readonly request: WorkflowRequest | null;
}

export const WORKFLOW_TASK_COMPLETED = createEventToken<WorkflowTaskCompleted>("workflow.task-completed");
