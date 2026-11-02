import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { can, type AccessObject } from "../../../access";
import type { LocalizedText } from "../../../../library/workflow";
import { Authorize, Controller, Created, Get, Patch, Post, Put, type HttpContext } from "../../../http";
import { buildListDocument } from "../../../../library/jsonapi";
import { body, callerOf, defaultLanguage, filterOf, listQuery, optionalInteger, optionalString, optionalText, pagingOfList, param, requiredString, withTitleText } from "../../internal/http";
import { WorkflowError } from "../../contracts/WorkflowError";
import { IWorkflowDefinitions, type ProcessSummary } from "../services/IWorkflowDefinitions.service";

/** The process catalog over HTTP (WORKFLOW-001 §3); rights are `workflow.processes.*` (WORKFLOW-002 §6.2). */
@Controller("workflow")
export class ProcessesController {
  constructor(private readonly definitions: IWorkflowDefinitions) {}

  @Get("processes")
  @Authorize(can("workflow.processes.read"))
  async list(ctx: HttpContext) {
    const { access, language } = await callerOf(ctx);
    const list = listQuery(ctx, { filter: { archived: ["eq"], search: ["eq"], folder: ["eq"], owner: ["eq"] }, sort: ["key", "title", "folder", "createdAt", "updatedAt"] });
    const archived = filterOf(list, "archived");
    if (archived !== undefined && archived !== "true" && archived !== "false") throw new WorkflowError("invalid_input", "archived must be true or false");
    const page = await this.definitions.list({
      ...pagingOfList(list),
      access: await access.filter("workflow.processes.read"),
      archived: archived === undefined ? undefined : archived === "true",
      search: filterOf(list, "search"),
      folder: filterOf(list, "folder"),
      owner: filterOf(list, "owner"),
    });
    return buildListDocument(this.localized(page.items, language, ctx), list, page.total, { basePath: ctx.path });
  }

  @Post("processes")
  @Authorize(can("workflow.processes.manage"))
  async create(ctx: HttpContext) {
    const request = await body(ctx);
    const key = requiredString(request.key, "key", 64);
    const folder = optionalString(request.folder, "folder", 500) ?? null;
    const { actor, request: from, language } = await callerOf(ctx, "workflow.processes.manage", { process: key, folder });
    const process = await this.definitions.create({
      key,
      title: optionalText(request.title) as LocalizedText,
      description: optionalText(request.description) ?? null,
      folder,
      owner: optionalString(request.owner, "owner") ?? null,
      retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null,
    }, actor, { request: from });
    return Created(`${ctx.path}/${process.key}`, withTitleText(process, language, defaultLanguage(ctx)));
  }

  @Get("processes/:key")
  @Authorize(can("workflow.processes.read"))
  async get(ctx: HttpContext) {
    const key = param(ctx, "key");
    const { language } = await callerOf(ctx, "workflow.processes.read", await this.objectOf(key));
    return withTitleText(await this.definitions.get(key), language, defaultLanguage(ctx));
  }

  @Patch("processes/:key")
  @Authorize(can("workflow.processes.manage"))
  async update(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const { actor, request: from, language } = await callerOf(ctx, "workflow.processes.manage", await this.objectOf(key));
    if (request.archived !== undefined && typeof request.archived !== "boolean") throw new WorkflowError("invalid_input", "archived must be a boolean");
    const folder = optionalString(request.folder, "folder", 500) ?? null;
    // Moving a process needs the right in the folder it goes to as well.
    if (request.folder !== undefined) await callerOf(ctx, "workflow.processes.manage", { process: key, folder });
    const process = await this.definitions.update(key, {
      ...(request.title === undefined ? {} : { title: optionalText(request.title) as LocalizedText }),
      ...(request.description === undefined ? {} : { description: optionalText(request.description) ?? null }),
      ...(request.folder === undefined ? {} : { folder }),
      ...(request.owner === undefined ? {} : { owner: optionalString(request.owner, "owner") ?? null }),
      ...(request.retentionDays === undefined ? {} : { retentionDays: optionalInteger(request.retentionDays, "retentionDays") ?? null }),
      ...(request.archived === undefined ? {} : { archived: request.archived as boolean }),
    }, actor, { request: from });
    return withTitleText(process, language, defaultLanguage(ctx));
  }

  @Put("processes/:key/draft")
  @Authorize(can("workflow.processes.manage"))
  async saveDraft(ctx: HttpContext) {
    const key = param(ctx, "key");
    const request = await body(ctx);
    const { actor, request: from, language } = await callerOf(ctx, "workflow.processes.manage", await this.objectOf(key));
    const expected = optionalString(request.expected, "expected");
    const expectedAt = expected === undefined ? undefined : new Date(expected);
    if (expectedAt !== undefined && Number.isNaN(expectedAt.getTime())) throw new WorkflowError("invalid_input", "expected must be the draftUpdatedAt that was read");
    return await this.definitions.saveDraft(key, request.document, actor, { request: from, language, ...(expectedAt === undefined ? {} : { expected: expectedAt }) });
  }

  @Post("processes/:key/publish")
  @Authorize(can("workflow.processes.publish"))
  async publish(ctx: HttpContext) {
    const key = param(ctx, "key");
    const { actor, request, language } = await callerOf(ctx, "workflow.processes.publish", await this.objectOf(key));
    const version = await this.definitions.publish(key, actor, { request, language });
    return Created(`${ctx.path.replace(/\/publish$/, "")}/versions/${version.version}`, version);
  }

  @Get("processes/:key/versions")
  @Authorize(can("workflow.processes.read"))
  async versions(ctx: HttpContext) {
    const key = param(ctx, "key");
    await callerOf(ctx, "workflow.processes.read", await this.objectOf(key));
    return { data: await this.definitions.versions(key) };
  }

  @Get("processes/:key/versions/:version")
  @Authorize(can("workflow.processes.read"))
  async version(ctx: HttpContext) {
    const key = param(ctx, "key");
    await callerOf(ctx, "workflow.processes.read", await this.objectOf(key));
    const version = optionalInteger(param(ctx, "version"), "version");
    if (version === undefined) throw new WorkflowError("invalid_input", "version must be an integer");
    return await this.definitions.version(key, version);
  }

  /** Checks a document without storing it: every finding, as a save and a publication would give them. */
  @Post("validate")
  @Authorize(can("workflow.processes.read"))
  async validate(ctx: HttpContext) {
    const request = await body(ctx);
    const { actor, language } = await callerOf(ctx);
    const key = optionalString(request.key, "key", 64);
    return { issues: await this.definitions.validate(request.document, { actor, language, ...(key === undefined ? {} : { processes: [key] }) }) };
  }

  /** What a designer builds its forms from (WORKFLOW-002 §4.2). */
  @Get("palette")
  @Authorize(can("workflow.processes.read"))
  async palette() {
    return this.definitions.palette();
  }

  @Get("tools")
  @Authorize(can("workflow.processes.read"))
  async tools() {
    return { data: this.definitions.tools() };
  }

  /** A process as the object of a permission. */
  private async objectOf(key: string): Promise<AccessObject> {
    return { process: key, folder: await this.definitions.folderOf(key) };
  }

  private localized(items: readonly ProcessSummary[], language: string, ctx: HttpContext) {
    return items.map((item) => withTitleText(item, language, defaultLanguage(ctx)));
  }
}
contextOnlyController(ProcessesController);
