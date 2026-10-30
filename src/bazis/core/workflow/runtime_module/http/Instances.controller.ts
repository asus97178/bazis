import { Controller, Created, Get, Post, type HttpContext } from "../../../http";
import { WorkflowError } from "../../contracts/WorkflowError";
import { authorize, body, optionalString, pagingQuery, param, requiredString } from "../../internal/http";
import type { InstanceStatus } from "../model/WfInstance.model";
import { IWorkflowRuntime } from "../services/IWorkflowRuntime.service";

/** Instances over HTTP (WORKFLOW-001 §4); rights come from `WorkflowAccess` with the instance's partition. */
@Controller("workflow/instances")
export class InstancesController {
  constructor(private readonly runtime: IWorkflowRuntime) {}

  @Post()
  async start(ctx: HttpContext) {
    const request = await body(ctx);
    const processKey = requiredString(request.processKey, "processKey", 64);
    const partition = optionalString(request.partition, "partition") ?? null;
    const actor = await authorize(ctx, "instances.start", { processKey, partition });
    const instance = await this.runtime.start(processKey, {
      input: request.input,
      partition,
      businessKey: optionalString(request.businessKey, "businessKey") ?? null,
      actor,
    });
    return Created(`${ctx.path}/${instance.id}`, instance);
  }

  @Get()
  async list(ctx: HttpContext) {
    const partition = optionalString(ctx.query("partition"), "partition");
    const processKey = optionalString(ctx.query("processKey"), "processKey");
    await authorize(ctx, "instances.read", { partition: partition ?? null, ...(processKey === undefined ? {} : { processKey }) });
    const page = await this.runtime.instances({
      ...pagingQuery(ctx),
      partition,
      processKey,
      status: optionalString(ctx.query("status"), "status") as InstanceStatus | undefined,
      businessKey: optionalString(ctx.query("businessKey"), "businessKey"),
      startedById: optionalString(ctx.query("startedById"), "startedById"),
    });
    return { data: page.items, meta: { total: page.total } };
  }

  @Get(":id")
  async get(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    await authorize(ctx, "instances.read", { processKey: instance.processKey, partition: instance.partition, instanceId: instance.id });
    return instance;
  }

  @Get(":id/history")
  async history(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    await authorize(ctx, "instances.read", { processKey: instance.processKey, partition: instance.partition, instanceId: instance.id });
    return { data: await this.runtime.history(instance.id) };
  }

  @Post(":id/cancel")
  async cancel(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    const request = await body(ctx);
    const actor = await authorize(ctx, "instances.manage", { processKey: instance.processKey, partition: instance.partition, instanceId: instance.id });
    return await this.runtime.cancel(instance.id, { reason: optionalString(request.reason, "reason", 1000) ?? null, actor });
  }

  @Post(":id/retry")
  async retry(ctx: HttpContext) {
    const instance = await this.runtime.instance(param(ctx, "id"));
    const actor = await authorize(ctx, "instances.manage", { processKey: instance.processKey, partition: instance.partition, instanceId: instance.id });
    return await this.runtime.retry(instance.id, { actor });
  }
}

