import { grantsToWhere } from "../../../access";
import { createHash } from "node:crypto";
import { paginate, UniqueViolationError } from "../../../orm";
import type { AgentToolContract } from "../../../agent";
import { emptyProcess, hasErrors, validateProcess, type ProcessDocument, type ProcessIssue } from "../../../../library/workflow";
import { isUuid, pageQueryOf, type WorkflowActor, type WorkflowAuditOptions, type WorkflowPage } from "../../contracts/types";
import type { WorkflowClock } from "../../contracts/WorkflowClock";
import { WorkflowError } from "../../contracts/WorkflowError";
import type { WorkflowEvents } from "../../internal/WorkflowEvents";
import type { WorkflowTools } from "../../internal/WorkflowTools";
import type { CodeProcessCatalog } from "../code/CodeProcessCatalog";
import type { OwnedCodeProcess } from "../code/codeProcesses";
import { WORKFLOW_PROCESS_CHANGED, type ProcessChange } from "../events/Definitions.events";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";
import { WfProcess } from "../model/WfProcess.model";
import { WfVersion } from "../model/WfVersion.model";
import {
  IWorkflowDefinitions,
  type CreateProcess,
  type ProcessDetails,
  type ProcessListQuery,
  type ProcessSummary,
  type SavedDraft,
  type SaveDraftOptions,
  type UpdateProcess,
  type VersionDetails,
  type VersionSummary,
} from "./IWorkflowDefinitions.service";

const KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
/** Who publishes the processes declared in code. */
const CODE_ACTOR: WorkflowActor = { kind: "system", id: "code" };

export class WorkflowDefinitions extends IWorkflowDefinitions {
  constructor(
    private readonly db: DefinitionsDbContext,
    private readonly workflowTools: WorkflowTools,
    private readonly code: CodeProcessCatalog,
    private readonly clock: WorkflowClock,
    private readonly events: WorkflowEvents,
  ) {
    super();
  }

  async list(query: ProcessListQuery = {}): Promise<WorkflowPage<ProcessSummary>> {
    const where = query.access === undefined ? "all" : grantsToWhere(query.access);
    if (where === "none") return { items: [], total: 0 };
    let source = this.db.processes.asNoTracking();
    if (where !== "all") source = source.where(() => where);
    if (query.archived === true) source = source.where((p) => p.archivedAt.isNotNull());
    if (query.archived === false) source = source.where((p) => p.archivedAt.isNull());
    if (query.search !== undefined && query.search.trim() !== "") {
      const text = query.search.trim();
      source = source.where((p) => p.key.contains(text, { ignoreCase: true }).or(p.title.contains(text, { ignoreCase: true })));
    }
    const { items, total } = await paginate(source, pageQueryOf(query, { field: "key", dir: "asc" }));
    return { items: items.map((row) => this.summaryOf(row)), total };
  }

  async get(key: string): Promise<ProcessDetails> {
    return this.detailsOf(await this.process(key, false));
  }

  async create(process: CreateProcess, actor: WorkflowActor, options: WorkflowAuditOptions = {}): Promise<ProcessDetails> {
    if (typeof process.key !== "string" || !KEY.test(process.key)) throw new WorkflowError("invalid_input", "key must match ^[a-z][a-z0-9_.-]{0,63}$");
    const row = Object.assign(new WfProcess(), {
      key: process.key,
      title: title(process.title),
      description: description(process.description),
      retentionDays: retention(process.retentionDays),
      draft: emptyProcess(),
      draftUpdatedAt: this.clock.now(),
      draftUpdatedByKind: actor.kind,
      draftUpdatedById: actor.id,
    });
    this.db.processes.add(row);
    try {
      await this.db.saveChanges();
    } catch (error) {
      if (error instanceof UniqueViolationError) throw new WorkflowError("conflict", `Process ${process.key} already exists`);
      throw error;
    }
    await this.changed("created", row.key, actor, options);
    return this.detailsOf(row);
  }

  async update(key: string, changes: UpdateProcess, actor: WorkflowActor, options: WorkflowAuditOptions = {}): Promise<ProcessDetails> {
    const row = await this.process(key, true);
    const { archived, ...fields } = changes;
    if (Object.values(fields).some((value) => value !== undefined)) this.assertNotCode(key);
    const before = { title: row.title, description: row.description, retentionDays: row.retentionDays, archived: row.archivedAt !== null };
    if (changes.title !== undefined) row.title = title(changes.title);
    if (changes.description !== undefined) row.description = description(changes.description);
    if (changes.retentionDays !== undefined) row.retentionDays = retention(changes.retentionDays);
    if (archived !== undefined) row.archivedAt = archived ? row.archivedAt ?? this.clock.now() : null;
    await this.db.saveChanges();
    if (row.title !== before.title || row.description !== before.description || row.retentionDays !== before.retentionDays) await this.changed("updated", key, actor, options);
    if (archived !== undefined && archived !== before.archived) await this.changed(archived ? "archived" : "restored", key, actor, options);
    return this.detailsOf(row);
  }

  async saveDraft(key: string, document: unknown, actor: WorkflowActor, options: SaveDraftOptions = {}): Promise<SavedDraft> {
    const issues = this.validate(document);
    if (issues.some((issue) => issue.code === "too_large")) throw new WorkflowError("invalid_document", "The document is too large", issues);
    return await this.db.transactionScope(async (transaction) => {
      const row = await this.db.processes.where((p) => p.key.eq(key)).forUpdate().firstOrDefault();
      if (!row) throw notFound(key);
      this.assertNotCode(key);
      const previous = row.draftUpdatedAt?.getTime();
      if (options.expected !== undefined && previous !== options.expected.getTime()) throw new WorkflowError("conflict", `The draft of ${key} was saved by someone else`);
      // Later than the last save even within a millisecond: `expected` tells any two saves apart.
      const draftUpdatedAt = new Date(Math.max(this.clock.now().getTime(), (previous ?? 0) + 1));
      row.draft = document;
      row.draftUpdatedAt = draftUpdatedAt;
      row.draftUpdatedByKind = actor.kind;
      row.draftUpdatedById = actor.id;
      await this.db.saveChanges();
      transaction.afterCommit(() => this.changed("draftSaved", key, actor, options));
      return { issues, draftUpdatedAt };
    });
  }

  async publish(key: string, actor: WorkflowActor, options: WorkflowAuditOptions = {}): Promise<VersionDetails> {
    return await this.db.transactionScope(async (transaction) => {
      const row = await this.db.processes.where((p) => p.key.eq(key)).forUpdate().firstOrDefault();
      if (!row) throw notFound(key);
      this.assertNotCode(key);
      if (row.archivedAt !== null) throw new WorkflowError("archived", `Process ${key} is archived`);
      const issues = this.validate(row.draft);
      if (hasErrors(issues)) throw new WorkflowError("invalid_document", `Process ${key} has errors and cannot be published`, issues);
      const { version, created } = await this.publishDraft(row, actor);
      if (created) transaction.afterCommit(() => this.changed("published", key, actor, options, version.version));
      return version;
    });
  }

  /**
   * Brings the processes declared in code into the catalog (WORKFLOW-001 §14):
   * creates or updates each, puts its document into the draft and publishes it,
   * under one lock across application instances. Archived ones stay archived
   * and unpublished. The caller has checked the documents with the Tools.
   */
  async publishCode(entries: readonly OwnedCodeProcess[]): Promise<readonly { readonly key: string; readonly version: number | null; readonly published: boolean }[]> {
    return await this.db.transactionScope(async (transaction) => {
      await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext('bazis.workflow.code'))");
      const results: { key: string; version: number | null; published: boolean }[] = [];
      for (const { process } of [...entries].sort((a, b) => a.process.key.localeCompare(b.process.key))) {
        let row = await this.db.processes.where((p) => p.key.eq(process.key)).forUpdate().firstOrDefault();
        if (!row) {
          row = Object.assign(new WfProcess(), { key: process.key });
          this.db.processes.add(row);
          transaction.afterCommit(() => this.changed("created", process.key, CODE_ACTOR));
        }
        const fields = { title: title(process.title), description: description(process.description), retentionDays: retention(process.retentionDays) };
        if (row.title !== fields.title) row.title = fields.title;
        if (row.description !== fields.description) row.description = fields.description;
        if (row.retentionDays !== fields.retentionDays) row.retentionDays = fields.retentionDays;
        if (row.draft === null || canonicalJson(row.draft) !== canonicalJson(process.document)) {
          row.draft = process.document;
          row.draftUpdatedAt = this.clock.now();
          row.draftUpdatedByKind = CODE_ACTOR.kind;
          row.draftUpdatedById = CODE_ACTOR.id;
        }
        await this.db.saveChanges();
        if (row.archivedAt !== null) {
          results.push({ key: row.key, version: row.latestVersion, published: false });
          continue;
        }
        const { version, created } = await this.publishDraft(row, CODE_ACTOR);
        if (created) transaction.afterCommit(() => this.changed("published", process.key, CODE_ACTOR, {}, version.version));
        results.push({ key: row.key, version: version.version, published: created });
      }
      return results;
    });
  }

  /** Stores the draft of a locked row as the next version, unless it is the latest one already. */
  private async publishDraft(row: WfProcess, actor: WorkflowActor): Promise<{ readonly version: VersionDetails; readonly created: boolean }> {
    const hash = createHash("sha256").update(canonicalJson(row.draft)).digest("hex");
    if (row.latestVersion !== null) {
      const latest = await this.db.versions.asNoTracking().firstOrDefault((v) => v.processId.eq(row.id).and(v.version.eq(row.latestVersion!)));
      if (latest?.documentHash === hash) return { version: versionOf(row.key, latest), created: false };
    }
    const version = Object.assign(new WfVersion(), {
      processId: row.id,
      version: (row.latestVersion ?? 0) + 1,
      document: row.draft,
      documentHash: hash,
      publishedByKind: actor.kind,
      publishedById: actor.id,
    });
    this.db.versions.add(version);
    row.latestVersion = version.version;
    await this.db.saveChanges();
    return { version: versionOf(row.key, version), created: true };
  }

  async versions(key: string): Promise<readonly VersionSummary[]> {
    const row = await this.process(key, false);
    const rows = await this.db.versions.asNoTracking().where((v) => v.processId.eq(row.id)).orderByDescending((v) => v.version).toList();
    return rows.map((version) => {
      const { document: _document, ...summary } = versionOf(row.key, version);
      return summary;
    });
  }

  async version(key: string, version: number): Promise<VersionDetails> {
    const row = await this.process(key, false);
    const found = await this.db.versions.asNoTracking().firstOrDefault((v) => v.processId.eq(row.id).and(v.version.eq(version)));
    if (!found) throw new WorkflowError("not_found", `Process ${key} has no version ${version}`);
    return versionOf(row.key, found);
  }

  async latest(key: string): Promise<VersionDetails> {
    const row = await this.process(key, false);
    if (row.archivedAt !== null) throw new WorkflowError("archived", `Process ${key} is archived`);
    if (row.latestVersion === null) throw new WorkflowError("not_found", `Process ${key} has no published version`);
    return await this.version(key, row.latestVersion);
  }

  async published(): Promise<readonly VersionDetails[]> {
    const processes = await this.db.processes.asNoTracking().where((p) => p.archivedAt.isNull().and(p.latestVersion.isNotNull())).toList();
    if (processes.length === 0) return [];
    const byId = new Map(processes.map((process) => [process.id, process]));
    const versions = await this.db.versions.asNoTracking().where((v) => v.processId.in([...byId.keys()])).toList();
    return versions
      .filter((version) => byId.get(version.processId)?.latestVersion === version.version)
      .map((version) => versionOf(byId.get(version.processId)!.key, version));
  }

  async versionById(id: string): Promise<VersionDetails | undefined> {
    if (!isUuid(id)) return undefined;
    const version = await this.db.versions.asNoTracking().firstOrDefault((v) => v.id.eq(id));
    if (!version) return undefined;
    const process = await this.db.processes.asNoTracking().firstOrDefault((p) => p.id.eq(version.processId));
    return process ? versionOf(process.key, version) : undefined;
  }

  async retentionPolicies(): Promise<readonly { readonly key: string; readonly retentionDays: number }[]> {
    const rows = await this.db.processes.asNoTracking().where((p) => p.retentionDays.isNotNull()).toList();
    return rows.map((row) => ({ key: row.key, retentionDays: row.retentionDays! }));
  }

  tools(): readonly AgentToolContract[] {
    return this.workflowTools.list();
  }

  private async changed(change: ProcessChange, key: string, actor: WorkflowActor, options: WorkflowAuditOptions = {}, version: number | null = null): Promise<void> {
    await this.events.publish(WORKFLOW_PROCESS_CHANGED, { change, key, version, actor, request: options.request ?? null });
  }

  /** A process declared in code changes only through the code. */
  private assertNotCode(key: string): void {
    const module = this.code.moduleOf(key);
    if (module !== undefined) throw new WorkflowError("conflict", `Process ${key} is declared in code by ${module} and changes only there`);
  }

  private summaryOf(row: WfProcess): ProcessSummary {
    return {
      key: row.key,
      title: row.title,
      description: row.description,
      latestVersion: row.latestVersion,
      retentionDays: row.retentionDays,
      archived: row.archivedAt !== null,
      module: this.code.moduleOf(row.key) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private detailsOf(row: WfProcess): ProcessDetails {
    return {
      ...this.summaryOf(row),
      draft: row.draft,
      draftUpdatedAt: row.draftUpdatedAt,
      draftUpdatedBy: row.draftUpdatedById === null ? null : { kind: row.draftUpdatedByKind === "system" ? "system" : "user", id: row.draftUpdatedById },
    };
  }

  private validate(document: unknown): ProcessIssue[] {
    return validateProcess(document, { tools: (name) => this.workflowTools.has(name) });
  }

  private async process(key: string, tracked: boolean): Promise<WfProcess> {
    const source = tracked ? this.db.processes : this.db.processes.asNoTracking();
    const row = await source.firstOrDefault((p) => p.key.eq(key));
    if (!row) throw notFound(key);
    return row;
  }
}

function notFound(key: string): WorkflowError {
  return new WorkflowError("not_found", `Process ${key} does not exist`);
}

function title(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) throw new WorkflowError("invalid_input", "title must be 1–200 characters");
  return value;
}

function description(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2000) throw new WorkflowError("invalid_input", "description must be up to 2000 characters");
  return value;
}

function retention(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 36_500) throw new WorkflowError("invalid_input", "retentionDays must be an integer 1–36500");
  return value as number;
}

function versionOf(key: string, row: WfVersion): VersionDetails {
  return {
    id: row.id,
    key,
    version: row.version,
    publishedAt: row.publishedAt,
    publishedBy: { kind: row.publishedByKind === "system" ? "system" : "user", id: row.publishedById },
    document: row.document as ProcessDocument,
  };
}

/** JSON with sorted keys: the same document gives the same hash whatever the key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
