import { OnEvent } from "../../../kernel";
import { WORKFLOW_INSTANCES_DELETED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED, type WorkflowInstancesDeleted, type WorkflowTaskRequested, type WorkflowTokenClosed } from "../../runtime_module/events/Runtime.events";
import type { WorkflowTasks } from "../services/WorkflowTasks.service";

/** Keeps the inbox in line with the steps: a waiting user task gets a task, a closed one cancels it. */
export class TaskEvents {
  constructor(private readonly tasks: WorkflowTasks) {}

  @OnEvent(WORKFLOW_TASK_REQUESTED)
  requested(event: WorkflowTaskRequested): Promise<void> {
    return this.tasks.requested(event);
  }

  @OnEvent(WORKFLOW_TOKEN_CLOSED)
  closed(event: WorkflowTokenClosed): Promise<void> {
    return this.tasks.closed(event);
  }

  @OnEvent(WORKFLOW_INSTANCES_DELETED)
  deleted(event: WorkflowInstancesDeleted): Promise<void> {
    return this.tasks.deleted(event);
  }
}
