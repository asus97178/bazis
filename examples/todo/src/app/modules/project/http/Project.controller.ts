import { Conflict, Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from "osnv/core/http";
import { buildListDocument } from "osnv/library/jsonapi";
import { ProjectListQuery } from "./contracts/Project.query";
import { CreateProjectRequest, UpdateProjectRequest } from "./contracts/Project.requests";
import type { IProjectService } from "../services/IProject.service";

@Controller("projects")
export class ProjectController {
  constructor(private readonly projects: IProjectService) {}

  @Get()
  async list(query: ProjectListQuery, ctx: HttpContext) {
    const { items, total } = await this.projects.getAll(query);
    return buildListDocument(items, query, total, { basePath: ctx.path });
  }

  @Get(":id(uuid)")
  async getById(id: string) {
    const item = await this.projects.getById(id);
    return item ? Ok(item) : NotFound({ error: `project ${id} not found` });
  }

  @Post()
  async create(body: CreateProjectRequest, ctx: HttpContext) {
    const item = await this.projects.create(body);
    return item === "conflict"
      ? Conflict({ error: `project "${body.name}" already exists` })
      : Created(`${ctx.path.replace(/\/$/, "")}/${item.id}`, item);
  }

  @Put(":id(uuid)")
  async update(id: string, body: UpdateProjectRequest) {
    const item = await this.projects.update(id, body);
    if (item === "conflict") {
      return Conflict({ error: `project "${body.name}" already exists` });
    }
    return item ? Ok(item) : NotFound({ error: `project ${id} not found` });
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    const removed = await this.projects.delete(id);
    return removed ? NoContent() : NotFound({ error: `project ${id} not found` });
  }
}
