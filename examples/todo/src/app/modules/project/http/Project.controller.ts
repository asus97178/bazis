import { Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Post, Put } from "bazis/core/http";
import { buildListDocument } from "bazis/library/jsonapi";
import { ProjectListQuery } from "./contracts/ProjectList.query";
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

  @Get(":id(uuid)", { nullAs: NotFound })
  getById(id: string) {
    return this.projects.getById(id);
  }

  /** A taken name answers 409 by the unique index of the model. */
  @Post()
  async create(body: CreateProjectRequest) {
    return Created(await this.projects.create(body));
  }

  @Put(":id(uuid)", { nullAs: NotFound })
  update(id: string, body: UpdateProjectRequest) {
    return this.projects.update(id, body);
  }

  @Delete(":id(uuid)")
  async delete(id: string) {
    return await this.projects.delete(id) ? NoContent() : NotFound();
  }
}
