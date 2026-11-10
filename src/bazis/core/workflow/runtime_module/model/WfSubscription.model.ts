import { Column, Entity, ForeignKey, Index, UUID, Nullable } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

/** A token waiting for an event: `eventWait` or `boundaryEvent`. Matched by key and correlation. */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Index(["eventKey", "correlation"])
@Entity({ table: "bazis_wf2_run_subscriptions" })
export class WfSubscription {
  @UUID({ version: "v7" })
  id = "";

  @Nullable()
  @Column({ type: "text" })
  instanceId = "";

  @Index()
  @Nullable()
  @Column({ type: "text" })
  tokenId = "";

  @Nullable()
  @Column({ type: "text" })
  eventKey = "";

  @Nullable()
  @Column({ type: "text" })
  correlation: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  partition: string | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
