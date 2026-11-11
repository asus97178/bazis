import { Column, Entity, Index, UUID, Nullable } from "../../../orm";
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
  @Nullable()
  @Column({ type: "text" })
  key = "";

  @Nullable()
  @Column({ type: "json" })
  title: LocalizedText = "";

  /** Every text of `title`, the default language first: what a list searches and sorts by. */
  @Nullable()
  @Column({ type: "text" })
  titleText = "";

  @Nullable()
  @Column({ type: "json" })
  description: LocalizedText | null = null;

  /** A path, `Sales/Orders`: there is no folder entity. */
  @Index()
  @Nullable()
  @Column({ type: "text" })
  folder: string | null = null;

  /** Whose process it is: an opaque id of the application. */
  @Nullable()
  @Column({ type: "text" })
  owner: string | null = null;

  /** The draft document; kept with validation errors too. */
  @Nullable()
  @Column({ type: "json" })
  draft: unknown = null;

  @Nullable()
  @Column({ type: "datetime" })
  draftUpdatedAt: Date | null = null;

  @Nullable()
  @Column({ type: "text" })
  draftUpdatedByKind: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  draftUpdatedById: string | null = null;

  @Nullable()
  @Column({ type: "integer" })
  latestVersion: number | null = null;

  /** Days to keep completed and cancelled instances; `null` keeps them. */
  @Nullable()
  @Column({ type: "integer" })
  retentionDays: number | null = null;

  /** An archived process is not started. */
  @Nullable()
  @Column({ type: "datetime" })
  archivedAt: Date | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
