import { Column, Entity, ForeignKey, Index, UUID } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

/**
 * `active` passes a node, `waiting` waits for a Tool, a task or a join, `done`
 * moved on, `cancelled` was closed by a cancel, `failed` waits for a retry.
 */
export type TokenStatus = "active" | "waiting" | "done" | "cancelled" | "failed";

/** Where execution is. After a parallel gateway an instance has several. Its id is the idempotency key of a Tool call. */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Index(["instanceId", "status"])
@Entity({ table: "bazis_wf2_run_tokens" })
export class WfToken {
  @UUID({ version: "v7" })
  id = "";

  @Column({ type: "text" })
  instanceId = "";

  @Column({ type: "text" })
  nodeId = "";

  /** The flow the token came by; `null` on a start node. */
  @Column({ type: "text", nullable: true })
  viaFlowId: string | null = null;

  @Column({ type: "text" })
  status: TokenStatus = "active";

  @Column({ type: "json", nullable: true })
  output: unknown = null;

  /** The loop token this one runs inside, with its iteration and what only the body sees (stage 3). */
  @Column({ type: "text", nullable: true })
  parentTokenId: string | null = null;

  @Column({ type: "integer", nullable: true })
  iteration: number | null = null;

  @Column({ type: "json", nullable: true })
  locals: Record<string, unknown> | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "datetime", nullable: true })
  endedAt: Date | null = null;
}
