import { OnEvent } from "../../../kernel";
import { WORKFLOW_INSTANCES_DELETED, WORKFLOW_TASK_REQUESTED, WORKFLOW_TOKEN_CLOSED, type WorkflowInstancesDeleted, type WorkflowTaskRequested, type WorkflowTokenClosed } from "../../runtime_module/events/Runtime.events";
import type { TasksDbContext } from "../model/Tasks.dbContext";
import { WfTask } from "../model/WfTask.model";

/** Keeps the inbox in line with the steps: a waiting user task gets a task, a closed one cancels it. */
export class TaskEvents {
  constructor(private readonly db: TasksDbContext) {}

  /** A step started waiting for a person: its task. Repeated events of one token make one task. */
  @OnEvent(WORKFLOW_TASK_REQUESTED)
  async requested(event: WorkflowTaskRequested): Promise<void> {
    const assignee = "role" in event.assignee ? `role:${event.assignee.role}` : `user:${event.assignee.user}`;
    // Past the change tracker: the scope may go on to update tasks directly, which a context holding one would refuse.
    await this.db.tasks.insertIfAbsent(Object.assign(new WfTask(), {
      tokenId: event.tokenId,
      instanceId: event.instanceId,
      processKey: event.processKey,
      nodeId: event.nodeId,
      partition: event.partition,
      title: event.title,
      assignee,
      form: event.form,
      dueAt: event.dueAt,
      createdAt: new Date(),
    }), { conflictBy: (t) => [t.tokenId] });
  }

  /** The step closed otherwise than by its task: the task is cancelled. */
  @OnEvent(WORKFLOW_TOKEN_CLOSED)
  async closed(event: WorkflowTokenClosed): Promise<void> {
    await this.db.tasks.asNoTracking().where((t) => t.tokenId.eq(event.tokenId).and(t.status.in(["open", "claimed"]))).executeUpdate({ status: "cancelled" });
  }

  /** Retention deleted the instances: their tasks go too. */
  @OnEvent(WORKFLOW_INSTANCES_DELETED)
  async deleted(event: WorkflowInstancesDeleted): Promise<void> {
    if (event.instanceIds.length > 0) await this.db.tasks.asNoTracking().where((t) => t.instanceId.in([...event.instanceIds])).executeDelete();
  }
}
