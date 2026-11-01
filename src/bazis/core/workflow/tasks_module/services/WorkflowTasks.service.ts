import { grantsToWhere, type ScopePrincipals } from "../../../access";
import { isUuid, pagingOf, type WorkflowActor, type WorkflowPage } from "../../contracts/types";
import type { WorkflowClock } from "../../contracts/WorkflowClock";
import { WorkflowError } from "../../contracts/WorkflowError";
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
    const statuses = statusesOf(query.status);
    const groups = groupByPrincipals(query.addressees);
    const mine = query.actor?.id;
    const where = query.access === undefined ? "all" : grantsToWhere(query.access);
    if (where === "none" || (groups.length === 0 && mine === undefined)) return { items: [], total: 0 };
    let source = this.db.tasks.asNoTracking().where((t) => t.status.in(statuses));
    if (where !== "all") source = source.where(() => where);
    source = source.where((t) => {
      const theirs = groups.map(({ scopes, principals }) => {
        const named = scopes.filter((scope): scope is string => scope !== null);
        const partition = !scopes.includes(null) ? t.partition.in(named) : named.length === 0 ? t.partition.isNull() : t.partition.isNull().or(t.partition.in(named));
        return t.assignee.in(principals).and(partition);
      });
      if (mine !== undefined) theirs.push(t.claimedById.eq(mine));
      return theirs.reduce((left, right) => left.or(right));
    });
    if (query.partition !== undefined) source = source.where((t) => t.partition.eq(query.partition!));
    if (query.processKey !== undefined) source = source.where((t) => t.processKey.eq(query.processKey!));
    const total = await source.count();
    const rows = await source.orderBy((t) => t.id).skip(offset).take(limit).toList();
    return { items: rows.map(detailsOf), total };
  }

  async partitions(query: { readonly status?: readonly TaskStatus[] } = {}): Promise<readonly (string | null)[]> {
    const statuses = statusesOf(query.status);
    const rows = await this.db.database.querySqlRaw(`SELECT DISTINCT "partition" FROM "bazis_wf_task_items" WHERE "status" IN (${statuses.map((_, index) => `{${index}}`).join(", ")})`, ...statuses);
    return rows.map((row) => row.partition as string | null);
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

function statusesOf(status: readonly TaskStatus[] | undefined): TaskStatus[] {
  const statuses = [...(status ?? ["open", "claimed"] as const)];
  if (statuses.length === 0 || statuses.some((item) => !STATUSES.has(item))) throw new WorkflowError("invalid_input", "status must be open, claimed, completed or cancelled");
  return statuses;
}

/** Partitions with the same addressees go together: usually all of them, so the query stays short. */
function groupByPrincipals(addressees: readonly ScopePrincipals[]): { scopes: (string | null)[]; principals: string[] }[] {
  const groups = new Map<string, { scopes: (string | null)[]; principals: string[] }>();
  for (const { scope, principals } of addressees) {
    if (principals.length === 0) continue;
    const list = [...new Set(principals)].sort();
    const key = JSON.stringify(list);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { scopes: [scope], principals: list });
    else group.scopes.push(scope);
  }
  return [...groups.values()];
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
