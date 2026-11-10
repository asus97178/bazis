import { paginate, type PageResult } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";
import type { CreateProjectRequest, UpdateProjectRequest } from "../http/contracts/Project.requests";
import { toProjectResponse, type ProjectResponse } from "../http/contracts/Project.responses";
import { Project } from "../model/Project.model";
import { ProjectDbContext } from "../model/Project.dbContext";
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

  async create(body: CreateProjectRequest): Promise<ProjectResponse> {
    const item = Object.assign(new Project(), { name: body.name });
    this.db.projects.add(item);
    await this.db.saveChanges();
    return toProjectResponse(item);
  }

  async update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | null> {
    const item = await this.db.projects.find(id);
    if (!item) {
      return null;
    }
    if (body.name !== undefined) {
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
}
