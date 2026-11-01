import { AccessModule } from "bazis/core/access";
import { Module, scoped } from "bazis/core/di";
import { withEventSubscribers } from "bazis/core/kernel";
import { auditPermissions } from "./access/Audit.permissions";
import { AuditLog } from "./events/AuditLog";
import { AuditController } from "./http/Audit.controller";
import { AuditDbContext } from "./model/Audit.dbContext";
import { AuditEntry } from "./model/AuditEntry.model";

@Module({
  imports: [AccessModule],
  ormBazis: {
    context: AuditDbContext,
    entities: [AuditEntry],
    migrateOnStart: true,
  },
  permissions: auditPermissions,
  controllers: [AuditController],
  providers: [
    scoped(AuditLog),
    ...withEventSubscribers(AuditLog),
  ],
  exports: [],
})
export class AuditModule {}
