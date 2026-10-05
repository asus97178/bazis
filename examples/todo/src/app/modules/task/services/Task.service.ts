import { paginate, type PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { IProjectService } from "../../project/services/IProject.service";
import type { CreateTaskRequest, UpdateTaskRequest } from "../http/contracts/Task.requests";
import { toTaskResponse, type TaskResponse } from "../http/contracts/Task.responses";
import { Task } from "../model/Task.model";
import { TaskDbContext } from "../model/Task.dbContext";
import type { ITaskService } from "./ITask.service";

export class TaskService implements ITaskService {
  constructor(
    private readonly db: TaskDbContext,
    private readonly projects: IProjectService,
  ) {}

  async getAll(query: ListQuery): Promise<PageResult<TaskResponse>> {
    const { items, total } = await paginate(this.db.tasks.asNoTracking(), query);
    return { items: items.map(toTaskResponse), total };
  }

  async getById(id: string): Promise<TaskResponse | null> {
    const item = await this.db.tasks.find(id);
    return item ? toTaskResponse(item) : null;
  }

  count(done?: boolean): Promise<number> {
    return done === true
      ? this.db.tasks.where(item => item.done.eq(true)).count()
      : this.db.tasks.count();
  }

  async create(body: CreateTaskRequest): Promise<TaskResponse | null> {
    if (!await this.projects.getById(body.projectId)) {
      return null;
    }
    const item = Object.assign(new Task(), { projectId: body.projectId, title: body.title });
    this.db.tasks.add(item);
    await this.db.saveChanges();
    return toTaskResponse(item);
  }

  async update(id: string, body: UpdateTaskRequest): Promise<TaskResponse | null> {
    const item = await this.db.tasks.find(id);
    if (!item) {
      return null;
    }
    if (body.title !== undefined) {
      item.title = body.title;
    }
    if (body.done !== undefined) {
      item.done = body.done;
    }
    await this.db.saveChanges();
    return toTaskResponse(item);
  }

  async delete(id: string): Promise<boolean> {
    const item = await this.db.tasks.find(id);
    if (!item) {
      return false;
    }
    this.db.tasks.remove(item);
    await this.db.saveChanges();
    return true;
  }
}
