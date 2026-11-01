import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { can } from "../../../access";
import { Authorize, Controller, Get, Post, type HttpContext } from "../../../http";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import { buildListDocument } from "../../../../library/jsonapi";
import { body, callerOf, filterOf, listQuery, pagingOfList, param } from "../../internal/http";
import type { TaskStatus } from "../model/WfTask.model";
import { IWorkflowTasks, type TaskDetails } from "../services/IWorkflowTasks.service";

/**
 * The caller's tasks (WORKFLOW-002 §6.2): those addressed to any of the
 * subject's `principals` in the task's partition or claimed by the caller.
 * Another person's task answers 404, as if it did not exist.
 */
@Controller("workflow/tasks")
export class TasksController {
  constructor(private readonly tasks: IWorkflowTasks) {}

  @Get()
  @Authorize(can("workflow.tasks.work"))
  async list(ctx: HttpContext) {
    const { access, actor } = await callerOf(ctx);
    const list = listQuery(ctx, { filter: { partition: ["eq"], processKey: ["eq"], status: ["eq", "in"] }, sort: ["createdAt", "dueAt", "status", "processKey"] });
    const partition = filterOf(list, "partition");
    const status = filterOf(list, "status");
    const statuses = status === undefined ? {} : { status: status.split(",") as TaskStatus[] };
    const page = await this.tasks.list({
      ...pagingOfList(list),
      ...statuses,
      // Addressees are per partition and counted now, not when the task was created.
      addressees: await access.principals(partition === undefined ? await this.tasks.partitions(statuses) : [partition]),
      actor,
      access: await access.filter("workflow.tasks.work"),
      partition,
      processKey: filterOf(list, "processKey"),
    });
    return buildListDocument(page.items, list, page.total, { basePath: ctx.path });
  }

  @Get(":id")
  @Authorize(can("workflow.tasks.work"))
  async get(ctx: HttpContext) {
    return (await this.visible(ctx)).task;
  }

  @Post(":id/claim")
  @Authorize(can("workflow.tasks.work"))
  async claim(ctx: HttpContext) {
    const { task, actor } = await this.visible(ctx);
    return await this.tasks.claim(task.id, actor);
  }

  @Post(":id/release")
  @Authorize(can("workflow.tasks.work"))
  async release(ctx: HttpContext) {
    const { task, actor } = await this.visible(ctx);
    return await this.tasks.release(task.id, actor);
  }

  @Post(":id/complete")
  @Authorize(can("workflow.tasks.work"))
  async complete(ctx: HttpContext) {
    const { task, actor, request: from } = await this.visible(ctx);
    const request = await body(ctx);
    return await this.tasks.complete(task.id, request.output ?? {}, actor, { request: from });
  }

  /** The task if the caller may see it: addressed to one of their principals or claimed by them. */
  private async visible(ctx: HttpContext): Promise<{ task: TaskDetails; actor: WorkflowActor; request: WorkflowRequest }> {
    const task = await this.tasks.get(param(ctx, "id"));
    const { access, actor, request } = await callerOf(ctx, "workflow.tasks.work", { scope: task.partition, process: task.processKey });
    const addressees = await access.principals([task.partition]);
    if (!addressees.some(({ principals }) => principals.includes(task.assignee)) && task.claimedBy !== actor.id) throw new WorkflowError("not_found", `Task ${task.id} does not exist`);
    return { task, actor, request };
  }
}
contextOnlyController(TasksController);
