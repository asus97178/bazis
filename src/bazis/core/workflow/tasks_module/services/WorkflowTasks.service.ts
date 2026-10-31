import { UniqueViolationError } from "../../../orm";
import { isUuid, pagingOf, type WorkflowActor, type WorkflowPage } from "../../contracts/types";
import type { WorkflowClock } from "../../contracts/WorkflowClock";
import { WorkflowError } from "../../contracts/WorkflowError";
import type { WorkflowInstancesDeleted, WorkflowTaskRequested, WorkflowTokenClosed } from "../../runtime_module/events/Runtime.events";
import type { IWorkflowRuntime } from "../../runtime_module/services/IWorkflowRuntime.service";
import type { TasksDbContext } from "../model/Tasks.dbContext";
import { WfTask, type TaskStatus } from "../model/WfTask.model";
import { IWorkflowTasks, type TaskDetails, type TaskListQuery } from "./IWorkflowTasks.service";

const STATUSES = new Set<TaskStatus>(["open", "claimed", "completed", "cancelled"]);

export class WorkflowTasks extends IWorkflowTasks {
  constructor(
    private readonly db: TasksDbContext,
    private readonly runtime: IWorkflowRuntime,
    private readonly clock: WorkflowClock,
  ) {
    super();
  }

  async list(query: TaskListQuery): Promise<WorkflowPage<TaskDetails>> {
    const { limit, offset } = pagingOf(query);
    const statuses = [...(query.status ?? ["open", "claimed"])];
    if (statuses.length === 0 || statuses.some((status) => !STATUSES.has(status))) throw new WorkflowError("invalid_input", "status must be open, claimed, completed or cancelled");
    const assignees = [...query.assignees];
    const mine = query.actor?.id;
    if (assignees.length === 0 && mine === undefined) return { items: [], total: 0 };
    let source = this.db.tasks.asNoTracking().where((t) => t.status.in(statuses));
    source = mine === undefined
      ? source.where((t) => t.assignee.in(assignees))
      : assignees.length === 0
        ? source.where((t) => t.claimedById.eq(mine))
        : source.where((t) => t.assignee.in(assignees).or(t.claimedById.eq(mine)));
    if (query.partition !== undefined) source = source.where((t) => t.partition.eq(query.partition!));
    if (query.processKey !== undefined) source = source.where((t) => t.processKey.eq(query.processKey!));
    const total = await source.count();
    const rows = await source.orderBy((t) => t.id).skip(offset).take(limit).toList();
    return { items: rows.map(detailsOf), total };
  }

  async get(taskId: string): Promise<TaskDetails> {
    return detailsOf(await this.task(taskId, false));
  }

  async claim(taskId: string, actor: WorkflowActor): Promise<TaskDetails> {
    return await this.db.transactionScope(async () => {
      const task = await this.locked(taskId);
      if (task.status === "claimed" && task.claimedById === actor.id) return detailsOf(task);
      if (task.status === "claimed") throw new WorkflowError("conflict", "The task is taken by someone else");
      if (task.status !== "open") throw new WorkflowError("wrong_status", `The task is ${task.status}`);
      task.status = "claimed";
      task.claimedById = actor.id;
      task.claimedAt = this.clock.now();
      await this.db.saveChanges();
      return detailsOf(task);
    });
  }

  async release(taskId: string, actor: WorkflowActor): Promise<TaskDetails> {
    return await this.db.transactionScope(async () => {
      const task = await this.locked(taskId);
      if (task.status !== "claimed" || task.claimedById !== actor.id) throw new WorkflowError("wrong_status", "Only the person who took the task gives it back");
      task.status = "open";
      task.claimedById = null;
      task.claimedAt = null;
      await this.db.saveChanges();
      return detailsOf(task);
    });
  }

  async complete(taskId: string, output: unknown, actor: WorkflowActor): Promise<TaskDetails> {
    const task = await this.task(taskId, false);
    if (task.status === "claimed" && task.claimedById !== actor.id) throw new WorkflowError("conflict", "The task is taken by someone else");
    if (task.status !== "open" && task.status !== "claimed") throw new WorkflowError("wrong_status", `The task is ${task.status}`);
    let instance;
    try {
      // The form is checked and the process moves on first; the task follows.
      instance = await this.runtime.completeToken(task.tokenId, output, actor);
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "wrong_status") await this.close(task.tokenId, "cancelled");
      throw error;
    }
    const saved = instance.nodes[task.nodeId];
    await this.db.tasks.asNoTracking().where((t) => t.id.eq(task.id)).executeUpdate({
      status: "completed",
      completedById: actor.id,
      completedAt: this.clock.now(),
      output: typeof saved === "object" && saved !== null && !Array.isArray(saved) ? saved as Record<string, unknown> : null,
    });
    return await this.get(task.id);
  }

  /** A step started waiting for a person: its task. Repeated events of one token make one task. */
  async requested(event: WorkflowTaskRequested): Promise<void> {
    const assignee = "role" in event.assignee ? `role:${event.assignee.role}` : `user:${event.assignee.user}`;
    this.db.tasks.add(Object.assign(new WfTask(), {
      tokenId: event.tokenId,
      instanceId: event.instanceId,
      processKey: event.processKey,
      nodeId: event.nodeId,
      partition: event.partition,
      title: event.title,
      assignee,
      form: event.form,
      dueAt: event.dueAt,
    }));
    try {
      await this.db.saveChanges();
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
  }

  /** The step closed otherwise than by its task: the task is cancelled. */
  async closed(event: WorkflowTokenClosed): Promise<void> {
    await this.close(event.tokenId, "cancelled");
  }

  /** Retention deleted the instances: their tasks go too. */
  async deleted(event: WorkflowInstancesDeleted): Promise<void> {
    if (event.instanceIds.length > 0) await this.db.tasks.asNoTracking().where((t) => t.instanceId.in([...event.instanceIds])).executeDelete();
  }

  private async close(tokenId: string, status: "cancelled"): Promise<void> {
    await this.db.tasks.asNoTracking().where((t) => t.tokenId.eq(tokenId).and(t.status.in(["open", "claimed"]))).executeUpdate({ status });
  }

  private async task(taskId: string, tracked: boolean): Promise<WfTask> {
    if (!isUuid(taskId)) throw notFound(taskId);
    const source = tracked ? this.db.tasks : this.db.tasks.asNoTracking();
    const task = await source.firstOrDefault((t) => t.id.eq(taskId));
    if (!task) throw notFound(taskId);
    return task;
  }

  private async locked(taskId: string): Promise<WfTask> {
    if (!isUuid(taskId)) throw notFound(taskId);
    const task = await this.db.tasks.where((t) => t.id.eq(taskId)).forUpdate().firstOrDefault();
    if (!task) throw notFound(taskId);
    return task;
  }
}

function notFound(taskId: string): WorkflowError {
  return new WorkflowError("not_found", `Task ${taskId} does not exist`);
}

function detailsOf(row: WfTask): TaskDetails {
  return {
    id: row.id,
    instanceId: row.instanceId,
    tokenId: row.tokenId,
    processKey: row.processKey,
    nodeId: row.nodeId,
    partition: row.partition,
    title: row.title,
    assignee: row.assignee,
    form: row.form,
    dueAt: row.dueAt,
    status: row.status,
    claimedBy: row.claimedById,
    claimedAt: row.claimedAt,
    completedBy: row.completedById,
    completedAt: row.completedAt,
    output: row.output,
    createdAt: row.createdAt,
  };
}
