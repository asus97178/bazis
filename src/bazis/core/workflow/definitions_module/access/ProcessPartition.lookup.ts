import { AttributeLookup, type AccessValue, type LookupColumn } from "../../../access";
import type { ServiceProvider } from "../../../di";
import { WorkflowPartitions } from "../../contracts/WorkflowPartitions";
import type { WorkflowLanguages } from "../../internal/WorkflowLanguages";
import type { DefinitionsDbContext } from "../model/Definitions.dbContext";

/** The partitions of a process are not a column: partition → the keys of the processes connected to it (WORKFLOW-002 §6.2). */
export class ProcessPartitionLookup extends AttributeLookup {
  constructor(
    private readonly db: DefinitionsDbContext,
    private readonly languages: WorkflowLanguages,
    private readonly services: ServiceProvider,
  ) {
    super();
  }

  async toColumn(values: readonly AccessValue[]): Promise<LookupColumn> {
    const port = this.services.resolve(WorkflowPartitions);
    const rows = await this.db.processes.asNoTracking().select((p) => ({ key: p.key })).toList();
    const keys: string[] = [];
    for (const { key } of rows) {
      const partitions = await port.of(key, { partition: null, language: this.languages.default, actor: null });
      if (partitions.some((item) => item.enabled && values.includes(item.partition))) keys.push(key);
    }
    return { column: "key", in: keys };
  }
}
