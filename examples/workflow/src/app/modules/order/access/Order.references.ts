import { References, type ReferenceItem, type ReferencePage } from "bazis/core/access";
import type { OrderDbContext } from "../model/Order.dbContext";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reference kind `orders.order`: what a step that takes an order refers to. */
export class OrderReferences extends References {
  constructor(private readonly db: OrderDbContext) {
    super();
  }

  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set((await this.describe(ids)).map((item) => item.id));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    const rows = await this.db.orders.asNoTracking().where((order) => order.id.in(ids.filter((id) => UUID.test(id)))).toList();
    return rows.map((row) => ({ id: row.id, title: `Order ${row.id}` }));
  }

  async search(_text: string, _context: unknown, page: ReferencePage): Promise<readonly ReferenceItem[]> {
    const rows = await this.db.orders.asNoTracking().orderByDescending((order) => order.createdAt).skip(page.offset).take(page.limit).toList();
    return rows.map((row) => ({ id: row.id, title: `Order ${row.id}` }));
  }
}
