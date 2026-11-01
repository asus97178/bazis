import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { can } from "../../../access";
import { Authorize, Controller, Get, Post, type HttpContext } from "../../../http";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import { buildListDocument } from "../../../../library/jsonapi";
import { body, callerOf, defaultLanguage, filterOf, listQuery, pagingOfList, param, withTitleText } from "../../internal/http";
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
    const { access, actor, language } = await callerOf(ctx);
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
    return buildListDocument(page.items.map((item) => withTitleText(item, language, defaultLanguage(ctx))), list, page.total, { basePath: ctx.path });
  }

  @Get(":id")
  @Authorize(can("workflow.tasks.work"))
  async get(ctx: HttpContext) {
    const { task, language } = await this.visible(ctx);
    return withTitleText(task, language, defaultLanguage(ctx));
  }

  @Post(":id/claim")
  @Authorize(can("workflow.tasks.work"))
  async claim(ctx: HttpContext) {
    const { task, actor, language } = await this.visible(ctx);
    return withTitleText(await this.tasks.claim(task.id, actor), language, defaultLanguage(ctx));
  }

  @Post(":id/release")
  @Authorize(can("workflow.tasks.work"))
  async release(ctx: HttpContext) {
    const { task, actor, language } = await this.visible(ctx);
    return withTitleText(await this.tasks.release(task.id, actor), language, defaultLanguage(ctx));
  }

  @Post(":id/complete")
  @Authorize(can("workflow.tasks.work"))
  async complete(ctx: HttpContext) {
    const { task, actor, request: from, language } = await this.visible(ctx);
    const request = await body(ctx);
    return withTitleText(await this.tasks.complete(task.id, request.output ?? {}, actor, { request: from, language }), language, defaultLanguage(ctx));
  }

  /** The task if the caller may see it: addressed to one of their principals or claimed by them. */
  private async visible(ctx: HttpContext): Promise<{ task: TaskDetails; actor: WorkflowActor; request: WorkflowRequest; language: string }> {
    const task = await this.tasks.get(param(ctx, "id"));
    const { access, actor, request, language } = await callerOf(ctx, "workflow.tasks.work", { scope: task.partition, process: task.processKey });
    const addressees = await access.principals([task.partition]);
    if (!addressees.some(({ principals }) => principals.includes(task.assignee)) && task.claimedBy !== actor.id) throw new WorkflowError("not_found", `Task ${task.id} does not exist`);
    return { task, actor, request, language };
  }
}
contextOnlyController(TasksController);
