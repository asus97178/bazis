import { AccessModule } from "bazis/core/access";
import { Module, scoped } from "bazis/core/di";
import { StandardToolsModule } from "bazis/core/tools";
import { WorkflowRuntimeModule } from "bazis/core/workflow";
import { orderPermissions } from "./access/Order.permissions";
import { OrderReferences } from "./access/Order.references";
import { OrderController } from "./http/Order.controller";
import { OrderDbContext } from "./model/Order.dbContext";
import { bigOrderAlert } from "./process/BigOrderAlert.process";
import { orderApproval } from "./process/OrderApproval.process";
import { orderBatch } from "./process/OrderBatch.process";
import { orderDigest } from "./process/OrderDigest.process";
import { IOrderService } from "./services/IOrder.service";
import { OrderService } from "./services/Order.service";
import { orderTools } from "./tools/Order.tools";
import { SetOrderStatusTool } from "./tools/SetOrderStatus.tool";

@Module({
  imports: [AccessModule, WorkflowRuntimeModule, StandardToolsModule],
  ormBazis: {
    context: OrderDbContext,
    migrateOnStart: true,
  },
  permissions: orderPermissions,
  references: { "orders.order": OrderReferences },
  processes: [orderApproval, orderBatch, orderDigest, bigOrderAlert],
  tools: [SetOrderStatusTool, orderTools],
  controllers: [OrderController],
  providers: [
    scoped(IOrderService, OrderService),
  ],
  exports: [IOrderService],
})
export class OrderModule {}
