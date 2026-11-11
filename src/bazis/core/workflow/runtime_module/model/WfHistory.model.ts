import { Column, Entity, ForeignKey, Index, UUID, Nullable } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

export type HistoryType = "started" | "queued" | "released" | "entered" | "left" | "tool" | "assigned" | "iteration" | "called" | "returned" | "skipped" | "timer" | "event" | "error" | "retried" | "cancelled" | "timedOut" | "handler" | "completed";

/** The journal of an instance, append only. Its v7 ids give the order. */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Index(["instanceId", "id"])
@Entity({ table: "bazis_wf2_run_history" })
export class WfHistory {
  @UUID({ version: "v7" })
  id = "";

  @Nullable()
  @Column({ type: "text" })
  instanceId = "";

  @Nullable()
  @Column({ type: "text" })
  tokenId: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  nodeId: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  type: HistoryType = "entered";

  @Nullable()
  @Column({ type: "json" })
  data: Record<string, unknown> | null = null;

  /** Who did it: cancel, retry, task completion; `null` for engine steps. */
  @Nullable()
  @Column({ type: "text" })
  actorKind: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  actorId: string | null = null;

  @Column({ type: "createdAt" })
  at = new Date(0);
}
