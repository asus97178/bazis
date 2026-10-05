import { createToken } from "osnv/core/di";
import type { PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { CreateProjectRequest, UpdateProjectRequest } from "../http/contracts/Project.requests";
import type { ProjectResponse } from "../http/contracts/Project.responses";

export interface IProjectService {
  getAll(query: ListQuery): Promise<PageResult<ProjectResponse>>;
  getById(id: string): Promise<ProjectResponse | null>;
  count(): Promise<number>;
  /** `"conflict"` when another project already has this name. */
  create(body: CreateProjectRequest): Promise<ProjectResponse | "conflict">;
  /** Null when not found; `"conflict"` when another project already has the new name. */
  update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | "conflict" | null>;
  delete(id: string): Promise<boolean>;
}

export const IProjectService = createToken<IProjectService>("IProjectService");
