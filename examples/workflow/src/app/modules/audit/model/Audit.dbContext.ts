import { DbContext } from "bazis/core/orm";
import { AuditEntry } from "./AuditEntry.model";

export class AuditDbContext extends DbContext {
  readonly entries = this.set(AuditEntry);
}
