import type { AccessFilter } from "bazis/core/access";
import type { WorkflowActor } from "bazis/core/workflow";
import type { Order, OrderStatus } from "../model/Order.model";

export abstract class IOrderService {
  /** Places an order and starts its approval on behalf of the customer. */
  abstract place(amount: number, customer: WorkflowActor): Promise<Order>;
  abstract get(id: string): Promise<Order | null>;
  /** The orders the filter of the caller lets through, newest first. */
  abstract list(access: AccessFilter): Promise<readonly Order[]>;
  abstract setStatus(id: string, status: OrderStatus): Promise<void>;
}
