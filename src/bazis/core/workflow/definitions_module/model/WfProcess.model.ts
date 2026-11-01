import { Column, Entity, Index, UUID } from "../../../orm";
import type { LocalizedText } from "../../../../library/workflow";

/**
 * A process in the catalog: the key it is started by, its card (names, folder,
 * owner), the draft a designer edits and the retention of finished instances. Changes; the
 * published versions ({@link WfVersion}) do not.
 */
@Entity({ table: "bazis_wf2_def_processes" })
export class WfProcess {
  @UUID({ version: "v7" })
  id = "";

  @Index({ unique: true })
  @Column({ type: "text" })
  key = "";

  @Column({ type: "json" })
  title: LocalizedText = "";

  /** Every text of `title`, the default language first: what a list searches and sorts by. */
  @Column({ type: "text" })
  titleText = "";

  @Column({ type: "json", nullable: true })
  description: LocalizedText | null = null;

  /** A path, `Sales/Orders`: there is no folder entity. */
  @Index()
  @Column({ type: "text", nullable: true })
  folder: string | null = null;

  /** Whose process it is: an opaque id of the application. */
  @Column({ type: "text", nullable: true })
  owner: string | null = null;

  /** The draft document; kept with validation errors too. */
  @Column({ type: "json", nullable: true })
  draft: unknown = null;

  @Column({ type: "datetime", nullable: true })
  draftUpdatedAt: Date | null = null;

  @Column({ type: "text", nullable: true })
  draftUpdatedByKind: string | null = null;

  @Column({ type: "text", nullable: true })
  draftUpdatedById: string | null = null;

  @Column({ type: "integer", nullable: true })
  latestVersion: number | null = null;

  /** Days to keep completed and cancelled instances; `null` keeps them. */
  @Column({ type: "integer", nullable: true })
  retentionDays: number | null = null;

  /** An archived process is not started. */
  @Column({ type: "datetime", nullable: true })
  archivedAt: Date | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
