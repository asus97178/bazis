import { ormEntityTools } from "bazis/core/tools";
import { OrderDbContext } from "../model/Order.dbContext";
import { Order } from "../model/Order.model";

/**
 * What a process may do with orders without a Tool written by hand: only find
 * them, and only by status and amount. A process names it as `orderTools.find`.
 */
export const orderTools = ormEntityTools(Order, {
  context: OrderDbContext,
  ops: ["find"],
  fields: ["status", "amount"],
});
