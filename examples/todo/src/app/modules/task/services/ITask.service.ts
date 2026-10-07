import type { PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateTaskRequest, UpdateTaskRequest } from "../http/contracts/Task.requests";
import type { TaskResponse } from "../http/contracts/Task.responses";

export abstract class ITaskService {
  abstract getAll(query: ListQuery): Promise<PageResult<TaskResponse>>;
  abstract getById(id: string): Promise<TaskResponse | null>;
  /** Number of tasks; only finished ones when `done` is true. */
  abstract count(done?: boolean): Promise<number>;
  /** Null when the project does not exist. */
  abstract create(body: CreateTaskRequest): Promise<TaskResponse | null>;
  abstract update(id: string, body: UpdateTaskRequest): Promise<TaskResponse | null>;
  abstract delete(id: string): Promise<boolean>;
}
