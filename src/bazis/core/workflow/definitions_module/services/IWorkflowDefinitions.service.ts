import type { AccessFilter } from "../../../access";
import type { AgentToolContract } from "../../../agent";
import type { ProcessDocument, ProcessIssue } from "../../../../library/workflow";
import type { WorkflowActor, WorkflowAuditOptions, WorkflowPage, WorkflowPaging } from "../../contracts/types";
import type { OwnedCodeProcess } from "../code/codeProcesses";

export interface ProcessSummary {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly latestVersion: number | null;
  readonly retentionDays: number | null;
  readonly archived: boolean;
  /**
   * The module whose `@Module({ processes })` declares it; such a process
   * changes only through the code (WORKFLOW-001 §14). `null` for the catalog's own.
   */
  readonly module: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProcessDetails extends ProcessSummary {
  /** The draft a designer edits; may hold validation errors. */
  readonly draft: unknown;
  readonly draftUpdatedAt: Date | null;
  readonly draftUpdatedBy: WorkflowActor | null;
}

export interface VersionSummary {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly publishedAt: Date;
  readonly publishedBy: WorkflowActor;
}

export interface VersionDetails extends VersionSummary {
  readonly document: ProcessDocument;
}

export interface CreateProcess {
  readonly key: string;
  readonly title: string;
  readonly description?: string | null;
  readonly retentionDays?: number | null;
}

export interface UpdateProcess {
  readonly title?: string;
  readonly description?: string | null;
  readonly retentionDays?: number | null;
  readonly archived?: boolean;
}

export interface ProcessListQuery extends WorkflowPaging {
  /** Which processes the caller may see, from `IAccess`; without it the calling code has decided. */
  readonly access?: AccessFilter;
  readonly archived?: boolean;
  /** Part of the key or title, case-insensitive. */
  readonly search?: string;
}

export interface SaveDraftOptions extends WorkflowAuditOptions {
  /** The `draftUpdatedAt` the caller read: another save since then is `conflict`. Without it the last save wins. */
  readonly expected?: Date;
}

export interface SavedDraft {
  /** Every validation finding: a draft is stored with errors too. */
  readonly issues: readonly ProcessIssue[];
  /** Goes to `expected` of the next save. */
  readonly draftUpdatedAt: Date;
}

/**
 * The process catalog: drafts and immutable published versions
 * (WORKFLOW-001 §3). Errors are {@link WorkflowError}: `not_found`, `conflict`,
 * `invalid_document` with the issues, `invalid_input`.
 */
export abstract class IWorkflowDefinitions {
  abstract list(query?: ProcessListQuery): Promise<WorkflowPage<ProcessSummary>>;
  abstract get(key: string): Promise<ProcessDetails>;
  abstract create(process: CreateProcess, actor: WorkflowActor, options?: WorkflowAuditOptions): Promise<ProcessDetails>;
  /** A process declared in code takes only `archived`; other fields give `conflict`. */
  abstract update(key: string, changes: UpdateProcess, actor: WorkflowActor, options?: WorkflowAuditOptions): Promise<ProcessDetails>;
  /** Stores the draft even with errors; `conflict` for a process declared in code and when `expected` is out of date. */
  abstract saveDraft(key: string, document: unknown, actor: WorkflowActor, options?: SaveDraftOptions): Promise<SavedDraft>;
  /**
   * Validates the draft and stores it as the next version; the same document
   * again returns the latest version. `conflict` for a process declared in code.
   */
  abstract publish(key: string, actor: WorkflowActor, options?: WorkflowAuditOptions): Promise<VersionDetails>;
  abstract versions(key: string): Promise<readonly VersionSummary[]>;
  abstract version(key: string, version: number): Promise<VersionDetails>;
  /** The latest published version of a process that is not archived. */
  abstract latest(key: string): Promise<VersionDetails>;
  /** The latest version of every process that is not archived: where event and scheduled starts come from. */
  abstract published(): Promise<readonly VersionDetails[]>;
  /** A version by id, for the engine; `undefined` if there is none. */
  abstract versionById(id: string): Promise<VersionDetails | undefined>;
  /** Processes with a retention period: what the retention service deletes. */
  abstract retentionPolicies(): Promise<readonly { readonly key: string; readonly retentionDays: number }[]>;
  /** The Tools a service task may call, with their input and output schemas. */
  abstract tools(): readonly AgentToolContract[];
  /**
   * Publishes the processes of `@Module({ processes })` as `{ kind: "system", id: "code" }`
   * (WORKFLOW-001 §14): called once at start by the framework, not by the application.
   */
  abstract publishCode(entries: readonly OwnedCodeProcess[]): Promise<readonly { readonly key: string; readonly version: number | null; readonly published: boolean }[]>;
}
