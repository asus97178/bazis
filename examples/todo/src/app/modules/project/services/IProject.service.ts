import type { PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateProjectRequest, UpdateProjectRequest } from "../http/contracts/Project.requests";
import type { ProjectResponse } from "../http/contracts/Project.responses";

export abstract class IProjectService {
  abstract getAll(query: ListQuery): Promise<PageResult<ProjectResponse>>;
  abstract getById(id: string): Promise<ProjectResponse | null>;
  abstract count(): Promise<number>;
  /** A name another project has is refused by the unique index: `UniqueViolationError`, 409 over HTTP. */
  abstract create(body: CreateProjectRequest): Promise<ProjectResponse>;
  /** Null when not found. */
  abstract update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | null>;
  abstract delete(id: string): Promise<boolean>;
}
