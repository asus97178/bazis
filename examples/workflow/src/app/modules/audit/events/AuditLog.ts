import { OnEvent } from "bazis/core/kernel";
import {
  WORKFLOW_INSTANCE_CANCELLED,
  WORKFLOW_INSTANCE_RETRIED,
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_PROCESS_CHANGED,
  WORKFLOW_TASK_COMPLETED,
  type WorkflowActor,
  type WorkflowInstanceCancelled,
  type WorkflowInstanceRetried,
  type WorkflowInstanceStarted,
  type WorkflowProcessChanged,
  type WorkflowRequest,
  type WorkflowTaskCompleted,
} from "bazis/core/workflow";
import type { AuditDbContext } from "../model/Audit.dbContext";
import { AuditEntry } from "../model/AuditEntry.model";

/** The framework says what happened; keeping it is the application's own. */
export class AuditLog {
  constructor(private readonly db: AuditDbContext) {}

  @OnEvent(WORKFLOW_PROCESS_CHANGED)
  async processChanged(event: WorkflowProcessChanged): Promise<void> {
    await this.write(`process.${event.change}`, event.key, event);
  }

  @OnEvent(WORKFLOW_INSTANCE_STARTED)
  async instanceStarted(event: WorkflowInstanceStarted): Promise<void> {
    await this.write("instance.started", event.instanceId, event);
  }

  @OnEvent(WORKFLOW_INSTANCE_CANCELLED)
  async instanceCancelled(event: WorkflowInstanceCancelled): Promise<void> {
    await this.write("instance.cancelled", event.instanceId, event);
  }

  @OnEvent(WORKFLOW_INSTANCE_RETRIED)
  async instanceRetried(event: WorkflowInstanceRetried): Promise<void> {
    await this.write("instance.retried", event.instanceId, event);
  }

  @OnEvent(WORKFLOW_TASK_COMPLETED)
  async taskCompleted(event: WorkflowTaskCompleted): Promise<void> {
    await this.write("task.completed", event.taskId, event);
  }

  private async write(action: string, target: string, event: { readonly actor: WorkflowActor; readonly request: WorkflowRequest | null }): Promise<void> {
    this.db.entries.add(Object.assign(new AuditEntry(), {
      action,
      target,
      actorId: event.actor.id,
      ip: event.request?.ip ?? null,
      userAgent: event.request?.userAgent ?? null,
    }));
    await this.db.saveChanges();
  }
}
