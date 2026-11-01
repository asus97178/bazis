import { AccessModule } from "bazis/core/access";
import { Module, scoped } from "bazis/core/di";
import { WorkflowRuntimeModule } from "bazis/core/workflow";
import { orderPermissions } from "./access/Order.permissions";
import { OrderController } from "./http/Order.controller";
import { OrderDbContext } from "./model/Order.dbContext";
import { Order } from "./model/Order.model";
import { orderApproval } from "./process/OrderApproval.process";
import { IOrderService } from "./services/IOrder.service";
import { OrderService } from "./services/Order.service";
import { SetOrderStatusTool } from "./tools/SetOrderStatus.tool";

@Module({
  imports: [AccessModule, WorkflowRuntimeModule],
  ormBazis: {
    context: OrderDbContext,
    entities: [Order],
    migrateOnStart: true,
  },
  permissions: orderPermissions,
  processes: [orderApproval],
  tools: [SetOrderStatusTool],
  controllers: [OrderController],
  providers: [
    scoped(IOrderService, OrderService),
  ],
  exports: [IOrderService],
})
export class OrderModule {}
