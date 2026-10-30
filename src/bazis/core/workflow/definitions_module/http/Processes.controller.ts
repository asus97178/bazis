import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { Controller, Created, Get, Patch, Post, Put, type HttpContext } from "../../../http";
import { authorize, body, optionalInteger, optionalString, pagingQuery, param, requiredString } from "../../internal/http";
import { WorkflowError } from "../../contracts/WorkflowError";
import { IWorkflowDefinitions } from "../services/IWorkflowDefinitions.service";

/** The process catalog over HTTP (WORKFLOW-001 §3); rights come from `WorkflowAccess`. */
@Controller("workflow")
export class ProcessesController {
  constructor(private readonly definitions: IWorkflowDefinitions) {}

  @Get("processes")
  async list(ctx: HttpContext) {
    await authorize(ctx, "processes.read");
    const archived = ctx.query("archived");
    if (archived !== undefined && archived !== "true" && archived !== "false") throw new WorkflowError("invalid_input", "archived must be true or false");
    const page = await this.definitions.list({ ...pagingQuery(ctx), archived: archived === undefined ? undefined : archived === "true", search: optionalString(ctx.query("search"), "search") });
    return { data: page.items, meta: { total: page.total } };
  }

  @Post("processes")
  async create(ctx: HttpContext) {
    const request = await body(ctx);
    const key = requiredString(request.key, "key", 64);
    const actor = await authorize(ctx, "processes.manage", { processKey: key });
    const process = await this.definitions.create({
      key,
      title: requiredString(request.title, "title"),
      description: optionalString(request.description, "description", 2000) ?? null,
      retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null,
    }, actor);
    return Created(`${ctx.path}/${process.key}`, process);
  }

  @Get("processes/:key")
  async get(ctx: HttpContext) {
    const key = param(ctx, "key");
    await authorize(ctx, "processes.read", { processKey: key });
    return await this.definitions.get(key);
  }

  @Patch("processes/:key")
  async update(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const actor = await authorize(ctx, "processes.manage", { processKey: key });
    if (request.archived !== undefined && typeof request.archived !== "boolean") throw new WorkflowError("invalid_input", "archived must be a boolean");
    return await this.definitions.update(key, {
      ...(request.title === undefined ? {} : { title: requiredString(request.title, "title") }),
      ...(request.description === undefined ? {} : { description: optionalString(request.description, "description", 2000) ?? null }),
      ...(request.retentionDays === undefined ? {} : { retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null }),
      ...(request.archived === undefined ? {} : { archived: request.archived as boolean }),
    }, actor);
  }

  @Put("processes/:key/draft")
  async saveDraft(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const actor = await authorize(ctx, "processes.manage", { processKey: key });
    return await this.definitions.saveDraft(key, request.document, actor);
  }

  @Post("processes/:key/publish")
  async publish(ctx: HttpContext) {
    const key = param(ctx, "key");
    const actor = await authorize(ctx, "processes.publish", { processKey: key });
    const version = await this.definitions.publish(key, actor);
    return Created(`${ctx.path.replace(/\/publish$/, "")}/versions/${version.version}`, version);
  }

  @Get("processes/:key/versions")
  async versions(ctx: HttpContext) {
    const key = param(ctx, "key");
    await authorize(ctx, "processes.read", { processKey: key });
    return { data: await this.definitions.versions(key) };
  }

  @Get("processes/:key/versions/:version")
  async version(ctx: HttpContext) {
    const key = param(ctx, "key");
    await authorize(ctx, "processes.read", { processKey: key });
    const version = optionalInteger(param(ctx, "version"), "version");
    if (version === undefined) throw new WorkflowError("invalid_input", "version must be an integer");
    return await this.definitions.version(key, version);
  }

  @Get("tools")
  async tools(ctx: HttpContext) {
    await authorize(ctx, "processes.read");
    return { data: this.definitions.tools() };
  }
}
contextOnlyController(ProcessesController);
