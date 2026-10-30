import { Column, Entity, ForeignKey, Index, UUID } from "../../../orm";
import { WfProcess } from "./WfProcess.model";

/** A published version of a process: an immutable snapshot of its document. */
@ForeignKey(() => WfProcess, { properties: ["processId"], onDelete: "cascade" })
@Index(["processId", "version"], { unique: true })
@Entity({ table: "bazis_wf_def_versions" })
export class WfVersion {
  @UUID({ version: "v7" })
  id = "";

  @Column({ type: "uuid" })
  processId = "";

  @Column({ type: "integer" })
  version = 0;

  @Column({ type: "json" })
  document: unknown = null;

  /** sha-256 of the document: publishing the same document again adds no version. */
  @Column({ type: "text" })
  documentHash = "";

  @Column({ type: "createdAt" })
  publishedAt = new Date(0);

  @Column({ type: "text" })
  publishedByKind = "";

  @Column({ type: "text" })
  publishedById = "";
}
