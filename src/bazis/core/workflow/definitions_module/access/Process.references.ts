import { References, type ReferenceItem, type ReferencePage } from "../../../access";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";

/** Reference kind `workflow.process`: what an administrator picks in a condition. */
export class ProcessReferences extends References {
  constructor(private readonly db: DefinitionsDbContext) {
    super();
  }

  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set((await this.describe(ids)).map((item) => item.id));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.processes.asNoTracking().where((p) => p.key.in([...ids])).toList();
    return rows.map((row) => ({ id: row.key, title: row.title }));
  }

  async search(text: string, _context: unknown, page: ReferencePage): Promise<readonly ReferenceItem[]> {
    const found = text.trim();
    let source = this.db.processes.asNoTracking();
    if (found !== "") source = source.where((p) => p.key.contains(found, { ignoreCase: true }).or(p.title.contains(found, { ignoreCase: true })));
    const rows = await source.orderBy((p) => p.key).skip(page.offset).take(page.limit).toList();
    return rows.map((row) => ({ id: row.key, title: row.title }));
  }
}
