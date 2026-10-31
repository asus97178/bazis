import { Column, Entity, Index, UUID } from "../../../orm";
import type { FormSpec } from "../../../../library/workflow";

/** `open` waits for someone, `claimed` is taken by one person, `completed` and `cancelled` are done. */
export type TaskStatus = "open" | "claimed" | "completed" | "cancelled";

/**
 * A task for a person: a `userTask` step of an instance waiting for its form.
 * Created from `WORKFLOW_TASK_REQUESTED`; references are text (other stores).
 */
@Index(["assignee", "status"])
@Index(["partition", "status"])
@Entity({ table: "bazis_wf_task_items" })
export class WfTask {
  @UUID({ version: "v7" })
  id = "";

  /** The waiting token: one task per token. */
  @Index({ unique: true })
  @Column({ type: "text" })
  tokenId = "";

  @Index()
  @Column({ type: "text" })
  instanceId = "";

  @Column({ type: "text" })
  processKey = "";

  @Column({ type: "text" })
  nodeId = "";

  @Column({ type: "text", nullable: true })
  partition: string | null = null;

  @Column({ type: "text" })
  title = "";

  /** `role:<code>` or `user:<id>`. */
  @Column({ type: "text" })
  assignee = "";

  @Column({ type: "json", nullable: true })
  form: FormSpec | null = null;

  @Column({ type: "datetime", nullable: true })
  dueAt: Date | null = null;

  @Column({ type: "text" })
  status: TaskStatus = "open";

  @Column({ type: "text", nullable: true })
  claimedById: string | null = null;

  @Column({ type: "datetime", nullable: true })
  claimedAt: Date | null = null;

  @Column({ type: "text", nullable: true })
  completedById: string | null = null;

  @Column({ type: "datetime", nullable: true })
  completedAt: Date | null = null;

  @Column({ type: "json", nullable: true })
  output: Record<string, unknown> | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
