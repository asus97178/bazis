import { Column, Entity, ForeignKey, Index, UUID } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

export type HistoryType = "started" | "entered" | "left" | "tool" | "timer" | "event" | "error" | "retried" | "cancelled" | "completed";

/** The journal of an instance, append only. Its v7 ids give the order. */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Index(["instanceId", "id"])
@Entity({ table: "bazis_wf_run_history" })
export class WfHistory {
  @UUID({ version: "v7" })
  id = "";

  @Column({ type: "text" })
  instanceId = "";

  @Column({ type: "text", nullable: true })
  tokenId: string | null = null;

  @Column({ type: "text", nullable: true })
  nodeId: string | null = null;

  @Column({ type: "text" })
  type: HistoryType = "entered";

  @Column({ type: "json", nullable: true })
  data: Record<string, unknown> | null = null;

  /** Who did it: cancel, retry, task completion; `null` for engine steps. */
  @Column({ type: "text", nullable: true })
  actorKind: string | null = null;

  @Column({ type: "text", nullable: true })
  actorId: string | null = null;

  @Column({ type: "createdAt" })
  at = new Date(0);
}
