import { Column, Entity, Index, UUID } from "../../../orm";

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
  @Column({ type: "text" })
  versionId = "";

  @Column({ type: "text" })
  processKey = "";

  @Column({ type: "integer" })
  version = 0;

  /** The application's scope: a space, an organization. Never interpreted. */
  @Column({ type: "text", nullable: true })
  partition: string | null = null;

  @Column({ type: "text" })
  status: InstanceStatus = "running";

  @Column({ type: "json" })
  input: Record<string, unknown> = {};

  @Column({ type: "json" })
  vars: Record<string, unknown> = {};

  /** The result of every passed step by node id: `$nodes.<node>.<field>`. */
  @Column({ type: "json" })
  nodes: Record<string, unknown> = {};

  /** What the process gave back: its `out` variables when it completed. */
  @Column({ type: "json", nullable: true })
  output: Record<string, unknown> | null = null;

  /** `$event`: the data of the event that started or last continued it. */
  @Column({ type: "json", nullable: true })
  event: unknown = null;

  /** `$trigger`: how it was started. */
  @Column({ type: "json", nullable: true })
  trigger: Record<string, unknown> | null = null;

  /** A trial run (WORKFLOW-002 §5.4, stage 5). */
  @Column({ type: "boolean" })
  test = false;

  /** The instance whose `callProcess` started this one, and the waiting token there. */
  @Index()
  @Column({ type: "text", nullable: true })
  parentInstanceId: string | null = null;

  @Column({ type: "text", nullable: true })
  parentTokenId: string | null = null;

  @Index()
  @Column({ type: "text", nullable: true })
  businessKey: string | null = null;

  @Column({ type: "text" })
  startedVia: StartedVia = "manual";

  @Column({ type: "text" })
  startedByKind: "user" | "system" = "user";

  @Column({ type: "text" })
  startedById = "";

  /** Why the instance failed: node, code and message. */
  @Column({ type: "json", nullable: true })
  error: { readonly node: string; readonly code: string; readonly message: string } | null = null;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "datetime", nullable: true })
  endedAt: Date | null = null;
}
