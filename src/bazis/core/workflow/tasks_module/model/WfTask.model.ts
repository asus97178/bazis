import { Column, Entity, Index, UUID, Nullable } from "../../../orm";
import type { FormSpec, LocalizedText } from "../../../../library/workflow";

/** `open` waits for someone, `claimed` is taken by one person, `completed` and `cancelled` are done. */
export type TaskStatus = "open" | "claimed" | "completed" | "cancelled";

/**
 * A task for a person: a `userTask` step of an instance waiting for its form.
 * Created from `WORKFLOW_TASK_REQUESTED`; references are text (other stores).
 */
@Index(["assignee", "status"])
@Index(["partition", "status"])
@Entity({ table: "bazis_wf2_task_items" })
export class WfTask {
  @UUID({ version: "v7" })
  id = "";

  /** The waiting token: one task per token. */
  @Index({ unique: true })
  @Nullable()
  @Column({ type: "text" })
  tokenId = "";

  @Index()
  @Nullable()
  @Column({ type: "text" })
  instanceId = "";

  @Nullable()
  @Column({ type: "text" })
  processKey = "";

  @Nullable()
  @Column({ type: "text" })
  nodeId = "";

  @Nullable()
  @Column({ type: "text" })
  partition: string | null = null;

  @Nullable()
  @Column({ type: "json" })
  title: LocalizedText = "";

  /** The task of a trial run (WORKFLOW-002 §5.4, stage 5). */
  @Nullable()
  @Column({ type: "boolean" })
  test = false;

  /** `role:<code>` or `user:<id>`. */
  @Nullable()
  @Column({ type: "text" })
  assignee = "";

  @Nullable()
  @Column({ type: "json" })
  form: FormSpec | null = null;

  @Nullable()
  @Column({ type: "datetime" })
  dueAt: Date | null = null;

  @Nullable()
  @Column({ type: "text" })
  status: TaskStatus = "open";

  @Nullable()
  @Column({ type: "text" })
  claimedById: string | null = null;

  @Nullable()
  @Column({ type: "datetime" })
  claimedAt: Date | null = null;

  @Nullable()
  @Column({ type: "text" })
  completedById: string | null = null;

  @Nullable()
  @Column({ type: "datetime" })
  completedAt: Date | null = null;

  @Nullable()
  @Column({ type: "json" })
  output: Record<string, unknown> | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
