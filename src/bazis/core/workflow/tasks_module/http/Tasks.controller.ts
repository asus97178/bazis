import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { Controller, Get, Post, type HttpContext } from "../../../http";
import type { WorkflowActor } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import { assigneesOf, authorize, body, optionalString, pagingQuery, param } from "../../internal/http";
import type { TaskStatus } from "../model/WfTask.model";
import { IWorkflowTasks, type TaskDetails } from "../services/IWorkflowTasks.service";

/**
 * The caller's tasks (WORKFLOW-001 §5): those addressed to any of
 * `WorkflowAccess.assignees` or claimed by the caller. Another person's task
 * answers 404, as if it did not exist.
 */
@Controller("workflow/tasks")
export class TasksController {
  constructor(private readonly tasks: IWorkflowTasks) {}

  @Get()
  async list(ctx: HttpContext) {
    const partition = optionalString(ctx.query("partition"), "partition");
    const actor = await authorize(ctx, "tasks.work", { partition: partition ?? null });
    const status = ctx.query("status");
    const page = await this.tasks.list({
      ...pagingQuery(ctx),
      assignees: await assigneesOf(ctx, actor),
      actor,
      ...(status === undefined ? {} : { status: status.split(",") as TaskStatus[] }),
      partition,
      processKey: optionalString(ctx.query("processKey"), "processKey"),
    });
    return { data: page.items, meta: { total: page.total } };
  }

  @Get(":id")
  async get(ctx: HttpContext) {
    return (await this.visible(ctx)).task;
  }

  @Post(":id/claim")
  async claim(ctx: HttpContext) {
    const { task, actor } = await this.visible(ctx);
    return await this.tasks.claim(task.id, actor);
  }

  @Post(":id/release")
  async release(ctx: HttpContext) {
    const { task, actor } = await this.visible(ctx);
    return await this.tasks.release(task.id, actor);
  }

  @Post(":id/complete")
  async complete(ctx: HttpContext) {
    const { task, actor } = await this.visible(ctx);
    const request = await body(ctx);
    return await this.tasks.complete(task.id, request.output ?? {}, actor);
  }

  /** The task if the caller may see it: addressed to one of their assignees or claimed by them. */
  private async visible(ctx: HttpContext): Promise<{ task: TaskDetails; actor: WorkflowActor }> {
    const task = await this.tasks.get(param(ctx, "id"));
    const actor = await authorize(ctx, "tasks.work", { processKey: task.processKey, partition: task.partition, instanceId: task.instanceId, taskId: task.id });
    const assignees = await assigneesOf(ctx, actor);
    if (!assignees.includes(task.assignee) && task.claimedBy !== actor.id) throw new WorkflowError("not_found", `Task ${task.id} does not exist`);
    return { task, actor };
  }
}
contextOnlyController(TasksController);
