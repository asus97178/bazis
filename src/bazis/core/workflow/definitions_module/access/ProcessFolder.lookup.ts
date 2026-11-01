import { AttributeLookup, type AccessValue, type LookupColumn } from "../../../access";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";

/** `folder` of rows that only know their process: folder → the keys of its processes (WORKFLOW-002 §6.2). */
export class ProcessFolderLookup extends AttributeLookup {
  constructor(private readonly db: DefinitionsDbContext) {
    super();
  }

  async toColumn(values: readonly AccessValue[]): Promise<LookupColumn> {
    const folders = values.filter((value): value is string => typeof value === "string");
    const withoutFolder = values.includes(null);
    if (folders.length === 0 && !withoutFolder) return { column: "processKey", in: [] };
    const rows = await this.db.processes.asNoTracking()
      .where((p) => (folders.length === 0 ? p.folder.isNull() : withoutFolder ? p.folder.isNull().or(p.folder.in(folders)) : p.folder.in(folders)))
      .select((p) => ({ key: p.key }))
      .toList();
    return { column: "processKey", in: rows.map((row) => row.key) };
  }
}
