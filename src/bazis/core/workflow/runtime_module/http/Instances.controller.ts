import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { can, type AccessObject } from "../../../access";
import { Authorize, Controller, Created, Get, Post, type HttpContext } from "../../../http";
import { body, callerOf, optionalString, pagingQuery, param, requiredString } from "../../internal/http";
import type { InstanceStatus } from "../model/WfInstance.model";
import { IWorkflowRuntime, type InstanceSummary } from "../services/IWorkflowRuntime.service";

/** Instances over HTTP (WORKFLOW-001 §4); rights are `workflow.instances.*` (WORKFLOW-002 §6.2). */
@Controller("workflow/instances")
export class InstancesController {
  constructor(private readonly runtime: IWorkflowRuntime) {}

  @Post()
  @Authorize(can("workflow.instances.start"))
  async start(ctx: HttpContext) {
    const request = await body(ctx);
    const processKey = requiredString(request.processKey, "processKey", 64);
    const partition = optionalString(request.partition, "partition") ?? null;
    const { actor } = await callerOf(ctx, "workflow.instances.start", { scope: partition, process: processKey });
    const instance = await this.runtime.start(processKey, {
      input: request.input,
      partition,
      businessKey: optionalString(request.businessKey, "businessKey") ?? null,
      actor,
    });
    return Created(`${ctx.path}/${instance.id}`, instance);
  }

  @Get()
  @Authorize(can("workflow.instances.read"))
  async list(ctx: HttpContext) {
    const { access } = await callerOf(ctx);
    const page = await this.runtime.instances({
      ...pagingQuery(ctx),
      access: await access.filter("workflow.instances.read"),
      partition: optionalString(ctx.query("partition"), "partition"),
      processKey: optionalString(ctx.query("processKey"), "processKey"),
      status: optionalString(ctx.query("status"), "status") as InstanceStatus | undefined,
      businessKey: optionalString(ctx.query("businessKey"), "businessKey"),
      startedById: optionalString(ctx.query("startedById"), "startedById"),
    });
    return { data: page.items, meta: { total: page.total } };
  }

  @Get(":id")
  @Authorize(can("workflow.instances.read"))
  async get(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    await callerOf(ctx, "workflow.instances.read", objectOf(instance));
    return instance;
  }

  @Get(":id/history")
  @Authorize(can("workflow.instances.read"))
  async history(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    await callerOf(ctx, "workflow.instances.read", objectOf(instance));
    return { data: await this.runtime.history(instance.id) };
  }

  @Post(":id/cancel")
  @Authorize(can("workflow.instances.manage"))
  async cancel(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    const request = await body(ctx);
    const { actor } = await callerOf(ctx, "workflow.instances.manage", objectOf(instance));
    return await this.runtime.cancel(instance.id, { reason: optionalString(request.reason, "reason", 1000) ?? null, actor });
  }

  @Post(":id/retry")
  @Authorize(can("workflow.instances.manage"))
  async retry(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    const { actor } = await callerOf(ctx, "workflow.instances.manage", objectOf(instance));
    return await this.runtime.retry(instance.id, { actor });
  }
}
contextOnlyController(InstancesController);

/** The instance as the object of a permission. */
function objectOf(instance: InstanceSummary): AccessObject {
  return { scope: instance.partition, process: instance.processKey, startedById: instance.startedBy.id };
}

