import { createHash } from "node:crypto";
import { upgradeDocument, type LocalizedText } from "../../../../library/workflow";
import { canonicalJson } from "../../internal/canonicalJson";
import type { WorkflowLanguages } from "../../internal/WorkflowLanguages";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";
import { WfProcess } from "../model/WfProcess.model";
import { WfVersion } from "../model/WfVersion.model";


/**
 * Brings the catalog of the store before WORKFLOW-002 into the new one, once, at
 * start (§9): processes and versions, documents through `upgradeDocument`,
 * a title into the default language. Nothing happens without the old tables or
 * when the new catalog has processes. Instances are not brought over. The old
 * tables stay until they are dropped by hand (`upgrading.md`). Goes away with
 * reading of version 1.
 */
export class CatalogImport {
  constructor(
    private readonly db: DefinitionsDbContext,
    private readonly languages: WorkflowLanguages,
  ) {}

  /** How many processes came over. */
  async run(): Promise<number> {
    return await this.db.transactionScope(async () => {
      // One importer at a time across application instances.
      await this.db.database.querySqlRaw("SELECT pg_advisory_xact_lock(hashtext('bazis.workflow.import'))");
      const [{ old } = { old: null }] = await this.db.database.querySqlRaw("SELECT to_regclass('public.bazis_wf_def_processes')::text AS old");
      if (old === null || await this.db.processes.asNoTracking().count() > 0) return 0;
      const processes = await this.db.database.querySqlRaw('SELECT * FROM "bazis_wf_def_processes"');
      const versions = await this.db.database.querySqlRaw('SELECT * FROM "bazis_wf_def_versions"');
      const stamps: { readonly table: string; readonly column: string; readonly id: string; readonly at: Date }[] = [];
      for (const row of processes) {
        const title = text(row.title);
        const process = Object.assign(new WfProcess(), {
          id: String(row.id),
          key: text(row.key),
          title: { [this.languages.default]: title } satisfies LocalizedText,
          titleText: title,
          description: row.description === null ? null : { [this.languages.default]: text(row.description) } satisfies LocalizedText,
          draft: upgradeDocument(json(row.draft)),
          draftUpdatedAt: date(row.draftUpdatedAt),
          draftUpdatedByKind: row.draftUpdatedByKind as string | null,
          draftUpdatedById: row.draftUpdatedById as string | null,
          latestVersion: row.latestVersion as number | null,
          retentionDays: row.retentionDays as number | null,
          archivedAt: date(row.archivedAt),
        });
        this.db.processes.add(process);
        stamps.push({ table: "bazis_wf2_def_processes", column: "createdAt", id: process.id, at: date(row.createdAt)! });
      }
      await this.db.saveChanges();
      for (const row of versions) {
        const document = upgradeDocument(json(row.document));
        const version = Object.assign(new WfVersion(), {
          id: String(row.id),
          processId: String(row.processId),
          version: row.version as number,
          document,
          documentHash: createHash("sha256").update(canonicalJson(document)).digest("hex"),
          publishedByKind: text(row.publishedByKind),
          publishedById: text(row.publishedById),
        });
        this.db.versions.add(version);
        stamps.push({ table: "bazis_wf2_def_versions", column: "publishedAt", id: version.id, at: date(row.publishedAt)! });
      }
      await this.db.saveChanges();
      // These columns fill themselves on insert: the history keeps its dates.
      for (const { table, column, id, at } of stamps) {
        await this.db.database.executeSqlRaw(`UPDATE "${table}" SET "${column}" = {0} WHERE "id" = {1}::uuid`, at, id);
      }
      return processes.length;
    });
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function date(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | Date);
}

/** A raw `json` column may come parsed or as text, depending on the driver. */
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

