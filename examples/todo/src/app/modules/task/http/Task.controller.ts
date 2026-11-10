import { BadRequest, Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Post, Put } from "bazis/core/http";
import { buildListDocument } from "bazis/library/jsonapi";
import { TaskListQuery } from "./contracts/TaskList.query";
import { CreateTaskRequest, UpdateTaskRequest } from "./contracts/Task.requests";
import type { ITaskService } from "../services/ITask.service";

@Controller("tasks")
export class TaskController {
  constructor(private readonly tasks: ITaskService) {}

  @Get()
  async list(query: TaskListQuery, ctx: HttpContext) {
    const { items, total } = await this.tasks.getAll(query);
    return buildListDocument(items, query, total, { basePath: ctx.path });
  }

  @Get(":id(uuid)", { nullAs: NotFound })
  getById(id: string) {
    return this.tasks.getById(id);
  }

  @Post()
  async create(body: CreateTaskRequest) {
    const item = await this.tasks.create(body);
    return item
      ? Created(item)
      : BadRequest({ error: `project ${body.projectId} not found` });
  }

  @Put(":id(uuid)", { nullAs: NotFound })
  update(id: string, body: UpdateTaskRequest) {
    return this.tasks.update(id, body);
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    return await this.tasks.delete(id) ? NoContent() : NotFound();
  }
}
