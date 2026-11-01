import { Tool } from "bazis/core/agent";
import type { OrderStatus } from "../model/Order.model";
import { IOrderService } from "../services/IOrder.service";

/** A step of the approval: what happens to the order is the module's own operation. */
@Tool({ name: "orders.set-status", description: "Sets the status of an order.", sideEffect: "write", callers: ["workflow"] })
export class SetOrderStatusTool {
  constructor(private readonly orders: IOrderService) {}

  async execute(input: { orderId: string; status: OrderStatus }): Promise<{ status: OrderStatus }> {
    await this.orders.setStatus(input.orderId, input.status);
    return { status: input.status };
  }
}
