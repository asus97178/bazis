import { contextOnlyController } from "../../../http/Routing/contextOnlyControllers";
import { Controller, Post, type HttpContext } from "../../../http";
import { authorize, body, optionalString, param } from "../../internal/http";
import { IWorkflowRuntime } from "../services/IWorkflowRuntime.service";

/** Events from outside — a webhook, another service — over HTTP (WORKFLOW-001 §4). */
@Controller("workflow/events")
export class EventsController {
  constructor(private readonly runtime: IWorkflowRuntime) {}

  @Post(":eventKey")
  async emit(ctx: HttpContext) {
    const eventKey = param(ctx, "eventKey");
    const request = await body(ctx);
    const partition = optionalString(request.partition, "partition") ?? null;
    const actor = await authorize(ctx, "events.emit", { partition });
    const result = await this.runtime.emit(eventKey, request.payload ?? {}, {
      correlation: optionalString(request.correlation, "correlation") ?? null,
      partition,
      actor,
    });
    ctx.res.status(202);
    return result;
  }
}
contextOnlyController(EventsController);
