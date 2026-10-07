import type { PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateProjectRequest, UpdateProjectRequest } from "../http/contracts/Project.requests";
import type { ProjectResponse } from "../http/contracts/Project.responses";

export abstract class IProjectService {
  abstract getAll(query: ListQuery): Promise<PageResult<ProjectResponse>>;
  abstract getById(id: string): Promise<ProjectResponse | null>;
  abstract count(): Promise<number>;
  /** `"conflict"` when another project already has this name. */
  abstract create(body: CreateProjectRequest): Promise<ProjectResponse | "conflict">;
  /** Null when not found; `"conflict"` when another project already has the new name. */
  abstract update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | "conflict" | null>;
  abstract delete(id: string): Promise<boolean>;
}
