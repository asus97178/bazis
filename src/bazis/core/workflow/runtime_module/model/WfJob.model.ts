import { Column, Entity, ForeignKey, Index, UUID } from "../../../orm";
import { WfInstance } from "./WfInstance.model";

/** `tool` calls a service task's Tool; `timer`, `retry` and `schedule` come with their stages. */
export type JobKind = "tool" | "timer" | "retry" | "schedule";

/**
 * Deferred work of the worker, created in the same transaction as the waiting
 * token. Application instances claim it with `FOR UPDATE SKIP LOCKED`.
 */
@ForeignKey(() => WfInstance, { properties: ["instanceId"], onDelete: "cascade" })
@Entity({ table: "bazis_wf2_run_jobs" })
export class WfJob {
  @UUID({ version: "v7" })
  id = "";

  @Column({ type: "text" })
  kind: JobKind = "tool";

  /** `null` for a `schedule` job: its instance does not exist yet. */
  @Index()
  @Column({ type: "text", nullable: true })
  instanceId: string | null = null;

  @Index()
  @Column({ type: "text", nullable: true })
  tokenId: string | null = null;

  /** The version a `schedule` job starts. */
  @Column({ type: "text", nullable: true })
  versionId: string | null = null;

  @Index()
  @Column({ type: "datetime" })
  dueAt = new Date(0);

  /** What a job carries besides its token: an event to deliver (stage 4). */
  @Column({ type: "json", nullable: true })
  payload: unknown = null;

  /** Jobs with one key merge into the last: `debounce` of an event start (stage 4). */
  @Index()
  @Column({ type: "text", nullable: true })
  dedupeKey: string | null = null;

  /** The partition and the start node of a `schedule` job (stage 4). */
  @Column({ type: "text", nullable: true })
  partition: string | null = null;

  @Column({ type: "text", nullable: true })
  nodeId: string | null = null;

  @Column({ type: "integer" })
  attempts = 0;

  /** The worker holds the job until then; if it dies, the job becomes free again. */
  @Column({ type: "datetime", nullable: true })
  lockedUntil: Date | null = null;

  @Column({ type: "text", nullable: true })
  lastError: string | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
