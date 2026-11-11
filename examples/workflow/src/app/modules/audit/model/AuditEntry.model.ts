import { Column, Entity, UUID, Nullable, Required } from "bazis/core/orm";

/** Who did what to which process or instance, and from where. */
@Entity({ table: "audit_entries" })
export class AuditEntry {
  @UUID({ version: "v7" })
  id = "";

  /** `process.published`, `instance.started`, `task.completed`… */
  @Required()
  @Column({ type: "text" })
  action = "";

  /** The process key or the id of the instance or task. */
  @Required()
  @Column({ type: "text" })
  target = "";

  @Required()
  @Column({ type: "text" })
  actorId = "";

  /** `null` for an action of code, a schedule or the worker. */
  @Nullable()
  @Column({ type: "text" })
  ip: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  userAgent: string | null = null;

  @Column({ type: "createdAt" })
  at = new Date(0);
}
