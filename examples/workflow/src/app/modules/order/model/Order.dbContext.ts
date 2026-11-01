import { DbContext } from "bazis/core/orm";
import { Order } from "./Order.model";

export class OrderDbContext extends DbContext {
  readonly orders = this.set(Order);
}
