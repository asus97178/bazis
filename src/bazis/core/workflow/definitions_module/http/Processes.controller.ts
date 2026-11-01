import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { can } from "../../../access";
import { Authorize, Controller, Created, Get, Patch, Post, Put, type HttpContext } from "../../../http";
import { buildListDocument } from "../../../../library/jsonapi";
import { body, callerOf, filterOf, listQuery, optionalInteger, optionalString, pagingOfList, param, requiredString } from "../../internal/http";
import { WorkflowError } from "../../contracts/WorkflowError";
import { IWorkflowDefinitions } from "../services/IWorkflowDefinitions.service";

/** The process catalog over HTTP (WORKFLOW-001 §3); rights are `workflow.processes.*` (WORKFLOW-002 §6.2). */
@Controller("workflow")
export class ProcessesController {
  constructor(private readonly definitions: IWorkflowDefinitions) {}

  @Get("processes")
  @Authorize(can("workflow.processes.read"))
  async list(ctx: HttpContext) {
    const { access } = await callerOf(ctx);
    const list = listQuery(ctx, { filter: { archived: ["eq"], search: ["eq"] }, sort: ["key", "title", "createdAt", "updatedAt"] });
    const archived = filterOf(list, "archived");
    if (archived !== undefined && archived !== "true" && archived !== "false") throw new WorkflowError("invalid_input", "archived must be true or false");
    const page = await this.definitions.list({ ...pagingOfList(list), access: await access.filter("workflow.processes.read"), archived: archived === undefined ? undefined : archived === "true", search: filterOf(list, "search") });
    return buildListDocument(page.items, list, page.total, { basePath: ctx.path });
  }

  @Post("processes")
  @Authorize(can("workflow.processes.manage"))
  async create(ctx: HttpContext) {
    const request = await body(ctx);
    const key = requiredString(request.key, "key", 64);
    const { actor, request: from } = await callerOf(ctx, "workflow.processes.manage", { process: key });
    const process = await this.definitions.create({
      key,
      title: requiredString(request.title, "title"),
      description: optionalString(request.description, "description", 2000) ?? null,
      retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null,
    }, actor, { request: from });
    return Created(`${ctx.path}/${process.key}`, process);
  }

  @Get("processes/:key")
  @Authorize(can("workflow.processes.read"))
  async get(ctx: HttpContext) {
    const key = param(ctx, "key");
    await callerOf(ctx, "workflow.processes.read", { process: key });
    return await this.definitions.get(key);
  }

  @Patch("processes/:key")
  @Authorize(can("workflow.processes.manage"))
  async update(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const { actor, request: from } = await callerOf(ctx, "workflow.processes.manage", { process: key });
    if (request.archived !== undefined && typeof request.archived !== "boolean") throw new WorkflowError("invalid_input", "archived must be a boolean");
    return await this.definitions.update(key, {
      ...(request.title === undefined ? {} : { title: requiredString(request.title, "title") }),
      ...(request.description === undefined ? {} : { description: optionalString(request.description, "description", 2000) ?? null }),
      ...(request.retentionDays === undefined ? {} : { retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null }),
      ...(request.archived === undefined ? {} : { archived: request.archived as boolean }),
    }, actor, { request: from });
  }

  @Put("processes/:key/draft")
  @Authorize(can("workflow.processes.manage"))
  async saveDraft(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const { actor, request: from } = await callerOf(ctx, "workflow.processes.manage", { process: key });
    const expected = optionalString(request.expected, "expected");
    const expectedAt = expected === undefined ? undefined : new Date(expected);
    if (expectedAt !== undefined && Number.isNaN(expectedAt.getTime())) throw new WorkflowError("invalid_input", "expected must be the draftUpdatedAt that was read");
    return await this.definitions.saveDraft(key, request.document, actor, { request: from, ...(expectedAt === undefined ? {} : { expected: expectedAt }) });
  }

  @Post("processes/:key/publish")
  @Authorize(can("workflow.processes.publish"))
  async publish(ctx: HttpContext) {
    const key = param(ctx, "key");
    const { actor, request } = await callerOf(ctx, "workflow.processes.publish", { process: key });
    const version = await this.definitions.publish(key, actor, { request });
    return Created(`${ctx.path.replace(/\/publish$/, "")}/versions/${version.version}`, version);
  }

  @Get("processes/:key/versions")
  @Authorize(can("workflow.processes.read"))
  async versions(ctx: HttpContext) {
    const key = param(ctx, "key");
    await callerOf(ctx, "workflow.processes.read", { process: key });
    return { data: await this.definitions.versions(key) };
  }

  @Get("processes/:key/versions/:version")
  @Authorize(can("workflow.processes.read"))
  async version(ctx: HttpContext) {
    const key = param(ctx, "key");
    await callerOf(ctx, "workflow.processes.read", { process: key });
    const version = optionalInteger(param(ctx, "version"), "version");
    if (version === undefined) throw new WorkflowError("invalid_input", "version must be an integer");
    return await this.definitions.version(key, version);
  }

  @Get("tools")
  @Authorize(can("workflow.processes.read"))
  async tools() {
    return { data: this.definitions.tools() };
  }
}
contextOnlyController(ProcessesController);
