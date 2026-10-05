import { paginate, UniqueViolationError, type PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
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

  async create(body: CreateProjectRequest): Promise<ProjectResponse | "conflict"> {
    const item = Object.assign(new Project(), { name: body.name });
    this.db.projects.add(item);
    return await this.save() ? toProjectResponse(item) : "conflict";
  }

  async update(id: string, body: UpdateProjectRequest): Promise<ProjectResponse | "conflict" | null> {
    const item = await this.db.projects.find(id);
    if (!item) {
      return null;
    }
    if (body.name !== undefined) {
      item.name = body.name;
    }
    return await this.save() ? toProjectResponse(item) : "conflict";
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
   * The unique index on `name` decides, so two concurrent requests cannot
   * both win. False when it rejected the change.
   */
  private async save(): Promise<boolean> {
    try {
      await this.db.saveChanges();
      return true;
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        return false;
      }
      throw error;
    }
  }
}
