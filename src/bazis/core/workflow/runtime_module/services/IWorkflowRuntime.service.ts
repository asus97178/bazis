import type { FormIssue } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowPage, WorkflowPaging } from "../../contracts/types";
import type { HistoryType } from "../model/WfHistory.model";
import type { InstanceStatus, StartedVia } from "../model/WfInstance.model";
import type { TokenStatus } from "../model/WfToken.model";

export interface StartInstance {
  readonly input?: unknown;
  /** The application's scope: a space, an organization. */
  readonly partition?: string | null;
  /** The application's own key of what the instance is about: `order:42`. */
  readonly businessKey?: string | null;
  /** On whose behalf the steps run. */
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
  readonly error: { readonly node: string; readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface TokenDetails {
  readonly id: string;
  readonly nodeId: string;
  readonly viaFlowId: string | null;
  readonly status: TokenStatus;
  readonly output: unknown;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface InstanceDetails extends InstanceSummary {
  readonly input: Record<string, unknown>;
  readonly vars: Record<string, unknown>;
  readonly nodes: Record<string, unknown>;
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

export interface EmitOptions {
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
  /** Instances whose `eventWait` or `boundaryEvent` took the event. */
  readonly continued: readonly string[];
  /** Processes with an `eventStart` whose input the payload did not pass. */
  readonly rejected: readonly { readonly processKey: string; readonly issues: readonly FormIssue[] }[];
}

export interface InstanceListQuery extends WorkflowPaging {
  readonly partition?: string;
  readonly status?: InstanceStatus;
  readonly processKey?: string;
  readonly businessKey?: string;
  readonly startedById?: string;
}

/**
 * Runs published versions (WORKFLOW-001 §4). Errors are {@link WorkflowError}:
 * `not_found`, `archived`, `invalid_input` with the issues, `wrong_status`.
 */
export abstract class IWorkflowRuntime {
  /** Starts the latest version of a process from its manual start. */
  abstract start(processKey: string, options: StartInstance): Promise<InstanceDetails>;
  abstract cancel(instanceId: string, options: { readonly reason?: string | null; readonly actor: WorkflowActor }): Promise<InstanceDetails>;
  /** Retries the failed steps of a `failed` instance. */
  abstract retry(instanceId: string, options: { readonly actor: WorkflowActor }): Promise<InstanceDetails>;
  /** Finishes a user task's wait with the form output and moves on; `wrong_status` when the token no longer waits. */
  abstract completeToken(tokenId: string, output: unknown, actor: WorkflowActor): Promise<InstanceDetails>;
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
