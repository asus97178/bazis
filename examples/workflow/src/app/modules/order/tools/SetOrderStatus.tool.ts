import { Tool, type AgentToolExecutionContext } from "bazis/core/agent";
import { Validator } from "bazis/library/validation";
import type { OrderStatus } from "../model/Order.model";
import { IOrderService } from "../services/IOrder.service";

export class SetOrderStatusInput {
  /** `ref` tells a designer that the value is an order, not any string. */
  @Validator({ required: true, ref: "orders.order" })
  orderId!: string;

  @Validator({ required: true })
  status!: OrderStatus;
}

/** A step of the approval: what happens to the order is the module's own operation. */
@Tool({ name: "orders.set-status", description: "Sets the status of an order.", input: SetOrderStatusInput, sideEffect: "write", callers: ["workflow"] })
export class SetOrderStatusTool {
  constructor(private readonly orders: IOrderService) {}

  /** The context says on whose behalf the step runs; the result stays in the instance. */
  async execute(input: SetOrderStatusInput, context: AgentToolExecutionContext): Promise<{ status: OrderStatus; by: string | null }> {
    await this.orders.setStatus(input.orderId, input.status);
    return { status: input.status, by: context.actor?.id ?? null };
  }
}
