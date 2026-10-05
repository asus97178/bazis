import { BadRequest, Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from "osnv/core/http";
import { buildListDocument } from "osnv/library/jsonapi";
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

  @Get(":id(uuid)")
  async getById(id: string) {
    const item = await this.tasks.getById(id);
    return item ? Ok(item) : NotFound({ error: `task ${id} not found` });
  }

  @Post()
  async create(body: CreateTaskRequest, ctx: HttpContext) {
    const item = await this.tasks.create(body);
    return item
      ? Created(`${ctx.path.replace(/\/$/, "")}/${item.id}`, item)
      : BadRequest({ error: `project ${body.projectId} not found` });
  }

  @Put(":id(uuid)")
  async update(id: string, body: UpdateTaskRequest) {
    const item = await this.tasks.update(id, body);
    return item ? Ok(item) : NotFound({ error: `task ${id} not found` });
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    const removed = await this.tasks.delete(id);
    return removed ? NoContent() : NotFound({ error: `task ${id} not found` });
  }
}
