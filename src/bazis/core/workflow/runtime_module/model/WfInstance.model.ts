import { Column, Entity, Index, UUID, Nullable } from "../../../orm";

/**
 * `completed`, `cancelled` and `timedOut` are finished: retention deletes them.
 * `failed` waits for retry or cancel, `pending` for a free place (`maxConcurrent`, `sameKey: "queue"`).
 */
export type InstanceStatus = "pending" | "running" | "completed" | "cancelled" | "failed" | "timedOut";

export type StartedVia = "manual" | "event" | "schedule" | "callProcess" | "errorHandler";

/**
 * One run of a process. Bound to the version it started with: a new publication
 * does not touch it. Its data: the input, the variables and the result of each
 * step by node id.
 */
@Index(["partition", "status"])
@Index(["processKey", "status"])
@Index(["status", "endedAt"])
@Index(["test", "createdAt"])
@Entity({ table: "bazis_wf2_run_instances" })
export class WfInstance {
  @UUID({ version: "v7" })
  id = "";

  /** The version (a Definitions row: a reference without a foreign key). */
  @Nullable()
  @Column({ type: "text" })
  versionId = "";

  @Nullable()
  @Column({ type: "text" })
  processKey = "";

  @Nullable()
  @Column({ type: "integer" })
  version = 0;

  /** The application's scope: a space, an organization. Never interpreted. */
  @Nullable()
  @Column({ type: "text" })
  partition: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  status: InstanceStatus = "running";

  @Nullable()
  @Column({ type: "json" })
  input: Record<string, unknown> = {};

  @Nullable()
  @Column({ type: "json" })
  vars: Record<string, unknown> = {};

  /** The result of every passed step by node id: `$nodes.<node>.<field>`. */
  @Nullable()
  @Column({ type: "json" })
  nodes: Record<string, unknown> = {};

  /** What the process gave back: its `out` variables when it completed. */
  @Nullable()
  @Column({ type: "json" })
  output: Record<string, unknown> | null = null;

  /** `$event`: the data of the event that started or last continued it. */
  @Nullable()
  @Column({ type: "json" })
  event: unknown = null;

  /** `$trigger`: how it was started. */
  @Nullable()
  @Column({ type: "json" })
  trigger: Record<string, unknown> | null = null;

  /** A trial run (WORKFLOW-002 §5.4, stage 5). */
  @Nullable()
  @Column({ type: "boolean" })
  test = false;

  /** The instance whose `callProcess` started this one, and the waiting token there. */
  @Index()
  @Nullable()
  @Column({ type: "text" })
  parentInstanceId: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  parentTokenId: string | null = null;

  @Index()
  @Nullable()
  @Column({ type: "text" })
  businessKey: string | null = null;

  @Nullable()
  @Column({ type: "text" })
  startedVia: StartedVia = "manual";

  @Nullable()
  @Column({ type: "text" })
  startedByKind: "user" | "system" = "user";

  @Nullable()
  @Column({ type: "text" })
  startedById = "";

  /** Why the instance failed: node, code and message. */
  @Nullable()
  @Column({ type: "json" })
  error: { readonly node: string; readonly code: string; readonly message: string } | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Nullable()
  @Column({ type: "datetime" })
  endedAt: Date | null = null;
}
