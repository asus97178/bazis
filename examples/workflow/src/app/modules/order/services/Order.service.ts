import { grantsToWhere, type AccessFilter } from "bazis/core/access";
import { IWorkflowRuntime, type WorkflowActor } from "bazis/core/workflow";
import { OrderDbContext } from "../model/Order.dbContext";
import { Order, type OrderStatus } from "../model/Order.model";
import { IOrderService } from "./IOrder.service";

export class OrderService extends IOrderService {
  constructor(private readonly db: OrderDbContext, private readonly workflow: IWorkflowRuntime) {
    super();
  }

  async place(amount: number, customer: WorkflowActor): Promise<Order> {
    const order = Object.assign(new Order(), { amount, customerId: customer.id });
    this.db.orders.add(order);
    await this.db.saveChanges();
    await this.workflow.start("order-approval", {
      input: { orderId: order.id, amount },
      businessKey: `order:${order.id}`,
      actor: customer,
    });
    return order;
  }

  async get(id: string): Promise<Order | null> {
    return await this.db.orders.asNoTracking().firstOrDefault((order) => order.id.eq(id));
  }

  async list(access: AccessFilter): Promise<readonly Order[]> {
    const where = grantsToWhere(access);
    if (where === "none") return [];
    let source = this.db.orders.asNoTracking();
    if (where !== "all") source = source.where(() => where);
    return await source.orderByDescending((order) => order.createdAt).take(100).toList();
  }

  async setStatus(id: string, status: OrderStatus): Promise<void> {
    await this.db.orders.asNoTracking().where((order) => order.id.eq(id)).executeUpdate({ status });
  }
}
