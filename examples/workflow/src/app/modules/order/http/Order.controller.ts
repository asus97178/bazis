import { can, IAccess } from "bazis/core/access";
import { Authorize, Controller, Created, Get, NotFoundError, Post, type HttpContext } from "bazis/core/http";
import type { IOrderService } from "../services/IOrder.service";
import { PlaceOrderRequest } from "./contracts/Order.requests";

@Controller("orders")
export class OrderController {
  constructor(private readonly orders: IOrderService) {}

  @Post()
  @Authorize(can("orders.create"))
  async place(body: PlaceOrderRequest, ctx: HttpContext) {
    const access = await ctx.services.resolve(IAccess).for(ctx);
    const [id = access.subject.sub] = await access.ownerIds();
    const order = await this.orders.place(body.amount, { kind: "user", id });
    return Created(`${ctx.path}/${order.id}`, order);
  }

  @Get()
  @Authorize(can("orders.read"))
  async list(ctx: HttpContext) {
    const access = await ctx.services.resolve(IAccess).for(ctx);
    return { data: await this.orders.list(await access.filter("orders.read")) };
  }

  /** Another person's order answers 404, as if it did not exist. */
  @Get(":id(uuid)")
  @Authorize(can("orders.read"))
  async get(id: string, ctx: HttpContext) {
    const order = await this.orders.get(id);
    const access = await ctx.services.resolve(IAccess).for(ctx);
    if (order === null || !await access.can("orders.read", { ...order })) throw new NotFoundError();
    return order;
  }
}
