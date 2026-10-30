import { createHash } from "node:crypto";
import { UniqueViolationError } from "../../../orm";
import type { AgentToolContract } from "../../../agent";
import { emptyProcess, hasErrors, validateProcess, type ProcessDocument, type ProcessIssue } from "../../../../library/workflow";
import { isUuid, pagingOf, type WorkflowActor, type WorkflowPage } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import type { WorkflowTools } from "../../internal/WorkflowTools";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";
import { WfProcess } from "../model/WfProcess.model";
import { WfVersion } from "../model/WfVersion.model";
import {
  IWorkflowDefinitions,
  type CreateProcess,
  type ProcessDetails,
  type ProcessListQuery,
  type ProcessSummary,
  type UpdateProcess,
  type VersionDetails,
  type VersionSummary,
} from "./IWorkflowDefinitions.service";

const KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

export class WorkflowDefinitions extends IWorkflowDefinitions {
  constructor(
    private readonly db: DefinitionsDbContext,
    private readonly workflowTools: WorkflowTools,
  ) {
    super();
  }

  async list(query: ProcessListQuery = {}): Promise<WorkflowPage<ProcessSummary>> {
    const { limit, offset } = pagingOf(query);
    let source = this.db.processes.asNoTracking();
    if (query.archived === true) source = source.where((p) => p.archivedAt.isNotNull());
    if (query.archived === false) source = source.where((p) => p.archivedAt.isNull());
    if (query.search !== undefined && query.search.trim() !== "") {
      const text = query.search.trim();
      source = source.where((p) => p.key.contains(text, { ignoreCase: true }).or(p.title.contains(text, { ignoreCase: true })));
    }
    const total = await source.count();
    const rows = await source.orderBy((p) => p.key).skip(offset).take(limit).toList();
    return { items: rows.map(summaryOf), total };
  }

  async get(key: string): Promise<ProcessDetails> {
    return detailsOf(await this.process(key, false));
  }

  async create(process: CreateProcess, actor: WorkflowActor): Promise<ProcessDetails> {
    if (typeof process.key !== "string" || !KEY.test(process.key)) throw new WorkflowError("invalid_input", "key must match ^[a-z][a-z0-9_.-]{0,63}$");
    const row = Object.assign(new WfProcess(), {
      key: process.key,
      title: title(process.title),
      description: description(process.description),
      retentionDays: retention(process.retentionDays),
      draft: emptyProcess(),
      draftUpdatedAt: new Date(),
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
    return detailsOf(row);
  }

  async update(key: string, changes: UpdateProcess, _actor: WorkflowActor): Promise<ProcessDetails> {
    const row = await this.process(key, true);
    if (changes.title !== undefined) row.title = title(changes.title);
    if (changes.description !== undefined) row.description = description(changes.description);
    if (changes.retentionDays !== undefined) row.retentionDays = retention(changes.retentionDays);
    if (changes.archived !== undefined) row.archivedAt = changes.archived ? row.archivedAt ?? new Date() : null;
    await this.db.saveChanges();
    return detailsOf(row);
  }

  async saveDraft(key: string, document: unknown, actor: WorkflowActor): Promise<{ readonly issues: readonly ProcessIssue[] }> {
    const issues = this.validate(document);
    if (issues.some((issue) => issue.code === "too_large")) throw new WorkflowError("invalid_document", "The document is too large", issues);
    const row = await this.process(key, true);
    row.draft = document;
    row.draftUpdatedAt = new Date();
    row.draftUpdatedByKind = actor.kind;
    row.draftUpdatedById = actor.id;
    await this.db.saveChanges();
    return { issues };
  }

  async publish(key: string, actor: WorkflowActor): Promise<VersionDetails> {
    return await this.db.transactionScope(async () => {
      const row = await this.db.processes.where((p) => p.key.eq(key)).forUpdate().firstOrDefault();
      if (!row) throw notFound(key);
      if (row.archivedAt !== null) throw new WorkflowError("archived", `Process ${key} is archived`);
      const issues = this.validate(row.draft);
      if (hasErrors(issues)) throw new WorkflowError("invalid_document", `Process ${key} has errors and cannot be published`, issues);
      const hash = createHash("sha256").update(canonicalJson(row.draft)).digest("hex");
      if (row.latestVersion !== null) {
        const latest = await this.db.versions.asNoTracking().firstOrDefault((v) => v.processId.eq(row.id).and(v.version.eq(row.latestVersion!)));
        if (latest?.documentHash === hash) return versionOf(row.key, latest);
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
      return versionOf(row.key, version);
    });
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

function summaryOf(row: WfProcess): ProcessSummary {
  return {
    key: row.key,
    title: row.title,
    description: row.description,
    latestVersion: row.latestVersion,
    retentionDays: row.retentionDays,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function detailsOf(row: WfProcess): ProcessDetails {
  return {
    ...summaryOf(row),
    draft: row.draft,
    draftUpdatedAt: row.draftUpdatedAt,
    draftUpdatedBy: row.draftUpdatedById === null ? null : { kind: row.draftUpdatedByKind === "system" ? "system" : "user", id: row.draftUpdatedById },
  };
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
