import { References, type ReferenceItem, type ReferencePage } from "../../../access";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";

/**
 * Reference kind `workflow.folder`: the folders of the catalog. A folder exists
 * while a process lies in it or below it: there is no folder entity.
 */
export class FolderReferences extends References {
  constructor(private readonly db: DefinitionsDbContext) {
    super();
  }

  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const folders = await this.folders();
    return new Set(ids.filter((id) => folders.has(id)));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    const folders = await this.folders();
    return ids.filter((id) => folders.has(id)).map((id) => ({ id, title: id }));
  }

  async search(text: string, _context: unknown, page: ReferencePage): Promise<readonly ReferenceItem[]> {
    const found = text.trim().toLowerCase();
    return [...await this.folders()].filter((folder) => folder.toLowerCase().includes(found)).sort().slice(page.offset, page.offset + page.limit).map((id) => ({ id, title: id }));
  }

  private async folders(): Promise<ReadonlySet<string>> {
    const rows = await this.db.processes.asNoTracking().where((p) => p.folder.isNotNull()).select((p) => ({ folder: p.folder })).toList();
    const all = new Set<string>();
    for (const { folder } of rows) {
      const parts = folder!.split("/");
      for (let length = 1; length <= parts.length; length += 1) all.add(parts.slice(0, length).join("/"));
    }
    return all;
  }
}
