import { WorkflowProcessUsage } from "../../contracts/WorkflowProcessUsage";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";

/** Unfinished instances of a process: they stop it from being deleted. */
export class RuntimeProcessUsage extends WorkflowProcessUsage {
  constructor(private readonly db: RuntimeDbContext) {
    super();
  }

  async liveInstances(processKey: string): Promise<number> {
    return await this.db.instances.asNoTracking().where((i) => i.processKey.eq(processKey).and(i.status.in(["pending", "running", "failed"]))).count();
  }
}
