import { AccessModule, defineRoles } from "bazis/core/access";
import { TOOL_EXECUTION_OPTIONS } from "bazis/core/agent";
import { Module, singleton } from "bazis/core/di";
import { WorkflowModule } from "bazis/core/workflow";
import { AuthTokens } from "../auth/AuthTokens";
import { authConfig } from "../config/auth.config";
import { AuditModule } from "./audit/Audit.module";
import { OrderModule } from "./order/Order.module";
import { ToolOptions } from "./order/tools/ToolOptions";

/**
 * The rights of the application, as data: a role → its permissions. `:own` is
 * «only one's own». The roles come from the `role` claim of the token.
 */
export const appRoles = defineRoles({
  admin: "all",
  manager: [
    "orders.read",
    "workflow.processes.read",
    "workflow.instances.read",
    "workflow.instances.manage",
    "workflow.tasks.work",
  ],
  customer: ["orders.create", "orders.read:own", "workflow.instances.read:own"],
});

@Module({
  imports: [AccessModule, WorkflowModule, OrderModule, AuditModule],
  config: [authConfig],
  roles: appRoles,
  providers: [
    singleton(AuthTokens),
    singleton(TOOL_EXECUTION_OPTIONS, ToolOptions),
  ],
  exports: [],
})
export class AppModule {}
