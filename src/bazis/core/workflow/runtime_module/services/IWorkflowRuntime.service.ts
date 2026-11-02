import type { AccessFilter } from "../../../access";
import type { FormIssue } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowAuditOptions, WorkflowPage, WorkflowPaging } from "../../contracts/types";
import type { HistoryType } from "../model/WfHistory.model";
import type { InstanceStatus, StartedVia } from "../model/WfInstance.model";
import type { TokenStatus } from "../model/WfToken.model";

export interface StartInstance extends WorkflowAuditOptions {
  readonly input?: unknown;
  /** The application's scope: a space, an organization. */
  readonly partition?: string | null;
  /** The application's own key of what the instance is about: `order:42`. */
  readonly businessKey?: string | null;
  /** On whose behalf the steps run. */
  readonly actor: WorkflowActor;
  /** The language of the request, for the application's validator; `workflow.language` by default. */
  readonly language?: string;
}

/** One element of a mass start. */
export interface StartManyItem {
  readonly input?: unknown;
  /** What the instance is about: required, it is what `sameKey` compares. */
  readonly businessKey: string;
}

export interface StartMany extends WorkflowAuditOptions {
  readonly items: readonly StartManyItem[];
  readonly partition?: string | null;
  readonly actor: WorkflowActor;
  readonly language?: string;
}

/**
 * What became of one element: `started` (the instance may wait as `pending`),
 * `skipped` (`sameKey: "skip"` and `instanceId` is the unfinished one) or `rejected`
 * (no `businessKey`, invalid input).
 */
export type StartManyResult =
  | { readonly status: "started"; readonly businessKey: string; readonly instanceId: string; readonly instanceStatus: InstanceStatus }
  | { readonly status: "skipped"; readonly businessKey: string; readonly instanceId: string; readonly reason: "same_key" }
  | { readonly status: "rejected"; readonly businessKey: string | null; readonly reason: "business_key_required" | "invalid_input"; readonly issues?: readonly FormIssue[] };

export interface CancelInstance extends WorkflowAuditOptions {
  readonly reason?: string | null;
  readonly actor: WorkflowActor;
}

export interface RetryInstance extends WorkflowAuditOptions {
  readonly actor: WorkflowActor;
}

export interface InstanceSummary {
  readonly id: string;
  readonly processKey: string;
  readonly version: number;
  readonly partition: string | null;
  readonly status: InstanceStatus;
  readonly businessKey: string | null;
  readonly startedVia: StartedVia;
  readonly startedBy: WorkflowActor;
  /** The instance whose `callProcess` started this one. */
  readonly parentInstanceId: string | null;
  readonly error: { readonly node: string; readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface TokenDetails {
  readonly id: string;
  readonly nodeId: string;
  readonly viaFlowId: string | null;
  /** Inside a loop body: the token of the loop and the number of the iteration. */
  readonly parentTokenId: string | null;
  readonly iteration: number | null;
  readonly status: TokenStatus;
  readonly output: unknown;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface InstanceDetails extends InstanceSummary {
  readonly input: Record<string, unknown>;
  readonly vars: Record<string, unknown>;
  readonly nodes: Record<string, unknown>;
  /** What the process gave back: its `out` variables; `null` until it completes. */
  readonly output: Record<string, unknown> | null;
  /** Every token, oldest first. */
  readonly tokens: readonly TokenDetails[];
}

export interface HistoryEntry {
  readonly id: string;
  readonly tokenId: string | null;
  readonly nodeId: string | null;
  readonly type: HistoryType;
  readonly data: Record<string, unknown> | null;
  readonly actor: WorkflowActor | null;
  readonly at: Date;
}

export interface EmitOptions extends WorkflowAuditOptions {
  /** Which waits it is for: `order:42`. Waits without a correlation take any event of the key. */
  readonly correlation?: string | null;
  /** Only the waits of this partition; it is also the partition of instances the event starts. */
  readonly partition?: string | null;
  /** On whose behalf started instances run; `{ kind: "system", id: "event:<key>" }` by default. */
  readonly actor?: WorkflowActor;
}

export interface EmitResult {
  /** Instances started by an `eventStart`. */
  readonly started: readonly string[];
  /** Processes with `sameKey: "skip"` that did not start: an instance with the key is not finished. */
  readonly skipped: readonly { readonly processKey: string; readonly instanceId: string }[];
  /** Instances whose `eventWait` or `boundaryEvent` took the event. */
  readonly continued: readonly string[];
  /** Processes with an `eventStart` whose input the payload did not pass. */
  readonly rejected: readonly { readonly processKey: string; readonly issues: readonly FormIssue[] }[];
}

export interface InstanceListQuery extends WorkflowPaging {
  /** Which instances the caller may see, from `IAccess`; without it the calling code has decided. */
  readonly access?: AccessFilter;
  readonly partition?: string;
  readonly status?: InstanceStatus;
  readonly processKey?: string;
  readonly businessKey?: string;
  readonly startedById?: string;
  readonly parentInstanceId?: string;
}

/**
 * Runs published versions (WORKFLOW-001 §4). Errors are {@link WorkflowError}:
 * `not_found`, `archived`, `invalid_input` with the issues, `wrong_status`,
 * `conflict` when `sameKey: "skip"` refuses a start.
 */
export abstract class IWorkflowRuntime {
  /** Starts the latest version of a process from its manual start. It may wait as `pending` (`maxConcurrent`, `sameKey: "queue"`). */
  abstract start(processKey: string, options: StartInstance): Promise<InstanceDetails>;
  /** Starts an instance per element, each in its own transaction, and says what became of each. */
  abstract startMany(processKey: string, options: StartMany): Promise<readonly StartManyResult[]>;
  abstract cancel(instanceId: string, options: CancelInstance): Promise<InstanceDetails>;
  /** Retries the failed steps of a `failed` instance. An instance called by another one is retried through its caller. */
  abstract retry(instanceId: string, options: RetryInstance): Promise<InstanceDetails>;
  /** Finishes a user task's wait with the form output and moves on; `wrong_status` when the token no longer waits. */
  abstract completeToken(tokenId: string, output: unknown, actor: WorkflowActor, options?: { readonly language?: string }): Promise<InstanceDetails>;
  /**
   * Delivers an event: starts processes whose latest version has an
   * `eventStart` for the key, and moves the instances waiting for it.
   */
  abstract emit(eventKey: string, payload?: unknown, options?: EmitOptions): Promise<EmitResult>;
  /** Instances, newest first. */
  abstract instances(query?: InstanceListQuery): Promise<WorkflowPage<InstanceSummary>>;
  abstract instance(instanceId: string): Promise<InstanceDetails>;
  abstract history(instanceId: string): Promise<readonly HistoryEntry[]>;
}
