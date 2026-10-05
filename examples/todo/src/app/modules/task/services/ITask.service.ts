import { createToken } from "osnv/core/di";
import type { PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { CreateTaskRequest, UpdateTaskRequest } from "../http/contracts/Task.requests";
import type { TaskResponse } from "../http/contracts/Task.responses";

export interface ITaskService {
  getAll(query: ListQuery): Promise<PageResult<TaskResponse>>;
  getById(id: string): Promise<TaskResponse | null>;
  /** Number of tasks; only finished ones when `done` is true. */
  count(done?: boolean): Promise<number>;
  /** Null when the project does not exist. */
  create(body: CreateTaskRequest): Promise<TaskResponse | null>;
  update(id: string, body: UpdateTaskRequest): Promise<TaskResponse | null>;
  delete(id: string): Promise<boolean>;
}

export const ITaskService = createToken<ITaskService>("ITaskService");
