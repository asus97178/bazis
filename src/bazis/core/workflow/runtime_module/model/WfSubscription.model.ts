import { Column, Entity, ForeignKey, Index, UUID } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

/** A token waiting for an event: `eventWait` or `boundaryEvent`. Matched by key and correlation. */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Index(["eventKey", "correlation"])
@Entity({ table: "bazis_wf_run_subscriptions" })
export class WfSubscription {
  @UUID({ version: "v7" })
  id = "";

  @Column({ type: "text" })
  instanceId = "";

  @Index()
  @Column({ type: "text" })
  tokenId = "";

  @Column({ type: "text" })
  eventKey = "";

  @Column({ type: "text", nullable: true })
  correlation: string | null = null;

  @Column({ type: "text", nullable: true })
  partition: string | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
