import { Column, Entity, Index, UUID } from "bazis/core/orm";

export type OrderStatus = "new" | "approved" | "rejected";

@Entity({ table: "orders" })
export class Order {
  @UUID()
  id = "";

  /** Who placed the order: the owner column of `orders.read`. */
  @Index()
  @Column({ type: "text" })
  customerId = "";

  @Column({ type: "integer" })
  amount = 0;

  @Column({ type: "text" })
  status: OrderStatus = "new";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
