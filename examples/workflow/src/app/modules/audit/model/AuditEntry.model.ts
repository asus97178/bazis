import { Column, Entity, UUID } from "bazis/core/orm";

/** Who did what to which process or instance, and from where. */
@Entity({ table: "audit_entries" })
export class AuditEntry {
  @UUID({ version: "v7" })
  id = "";

  /** `process.published`, `instance.started`, `task.completed`… */
  @Column({ type: "text" })
  action = "";

  /** The process key or the id of the instance or task. */
  @Column({ type: "text" })
  target = "";

  @Column({ type: "text" })
  actorId = "";

  /** `null` for an action of code, a schedule or the worker. */
  @Column({ type: "text", nullable: true })
  ip: string | null = null;

  @Column({ type: "text", nullable: true })
  userAgent: string | null = null;

  @Column({ type: "createdAt" })
  at = new Date(0);
}
