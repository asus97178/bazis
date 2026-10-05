import { paginate, type PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { CreateProjectRequest, UpdateProjectRequest } from "../http/contracts/ProjectRequests";
import { toProjectResponse, type ProjectResponse } from "../http/contracts/ProjectResponses";
import { Project } from "../model/Project.model";
import { ProjectDbContext } from "../model/ProjectDbContext";
import type { IProjectService } from "./IProject.service";

export class ProjectService implements IProjectService {
  constructor(private readonly db: ProjectDbContext) {}

  async getAll(query: ListQuery): Promise<PageResult<ProjectResponse>> {
    const { items, total } = await paginate(this.db.projects.asNoTracking(), query);
    return { items: items.map(toProjectResponse), total };
  }

  async getById(id: string): Promise<ProjectResponse | null> {
    const item = await this.db.projects.find(id);
    return item ? toProjectResponse(item) : null;
  }

  count(): Promise<number> {
    return this.db.projects.count();
  }

  async create(body: CreateProjectRequest): Promise<ProjectResponse | "conflict"> {
    if (await this.nameTaken(body.name)) {
      return "conflict";
    }
    const item = Object.assign(new Project(), { name: body.name });
    this.db.projects.add(item);
    await this.db.saveChanges();
    return toProjectResponse(item);
  }

  async update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | "conflict" | null> {
    const item = await this.db.projects.find(id);
    if (!item) {
      return null;
    }
    if (body.name !== undefined && body.name !== item.name) {
      if (await this.nameTaken(body.name)) {
        return "conflict";
      }
      item.name = body.name;
    }
    await this.db.saveChanges();
    return toProjectResponse(item);
  }

  async delete(id: string): Promise<boolean> {
    const item = await this.db.projects.find(id);
    if (!item) {
      return false;
    }
    this.db.projects.remove(item);
    await this.db.saveChanges();
    return true;
  }

  /**
   * Friendly 409 for the common case. Two concurrent requests can still both
   * pass this check; the unique index then rejects the second one.
   */
  private async nameTaken(name: string): Promise<boolean> {
    return await this.db.projects.where(item => item.name.eq(name)).count() > 0;
  }
}
