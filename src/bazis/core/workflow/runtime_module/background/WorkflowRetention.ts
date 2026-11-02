import { BackgroundService, delay } from "../../../background";
import type { ServiceProvider } from "../../../di";
import { EventBus, type ConfigView } from "../../../kernel";
import { WorkflowClock } from "../../contracts/WorkflowClock";
import { IWorkflowDefinitions } from "../../definitions_module/services/IWorkflowDefinitions.service";
import { WORKFLOW_INSTANCES_DELETED } from "../events/Runtime.events";
import type { EntityQuery } from "../../../orm";
import { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfInstance } from "../model/WfInstance.model";
import type { WorkflowSettings } from "../../contracts/Workflow.config";

const DAY_MS = 86_400_000;

/**
 * Deletes `completed`, `cancelled` and `timedOut` instances older than their process's
 * `retentionDays`, with tokens, jobs, subscriptions and history (by cascade),
 * `retention.batchSize` at a time. `failed` instances wait for a person and stay.
 * Trial runs are gone after a day, whatever their status and process.
 * Each deleted batch is published as `WORKFLOW_INSTANCES_DELETED`, so parts
 * with their own data (tasks) drop theirs.
 */
export class WorkflowRetention extends BackgroundService {
  constructor(
    private readonly services: ServiceProvider,
    private readonly config: ConfigView<WorkflowSettings>,
  ) {
    super();
  }

  protected override async execute(signal: AbortSignal): Promise<void> {
    if (!this.config.get("retention.enabled") || this.services.resolve(WorkflowClock).manual === true) return;
    const intervalMs = this.config.get("retention.intervalMs");
    while (!signal.aborted) {
      try {
        await this.sweep(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.reportFailure("retention sweep failed", error);
      }
      await delay(intervalMs, signal);
    }
  }

  /** One pass over every process with a retention period; returns how many instances went. */
  async sweep(signal?: AbortSignal): Promise<number> {
    const batchSize = this.config.get("retention.batchSize");
    const scope = this.services.createScope();
    let deleted = 0;
    try {
      const definitions = scope.resolve(IWorkflowDefinitions);
      const db = scope.resolve(RuntimeDbContext);
      const now = scope.resolve(WorkflowClock).now().getTime();
      const drop = async (select: () => EntityQuery<WfInstance>): Promise<boolean> => {
        for (;;) {
          if (signal?.aborted) return false;
          const ids = (await select().orderBy((i) => i.id).take(batchSize).select((i) => ({ id: i.id })).toList()).map((row) => row.id);
          if (ids.length === 0) return true;
          await db.instances.asNoTracking().where((i) => i.id.in(ids)).executeDelete();
          deleted += ids.length;
          await scope.resolve(EventBus).publishScoped(scope, WORKFLOW_INSTANCES_DELETED, { instanceIds: ids });
          if (ids.length < batchSize) return true;
        }
      };
      const dayAgo = new Date(now - DAY_MS);
      if (!await drop(() => db.instances.asNoTracking().where((i) => i.test.eq(true).and(i.createdAt.lt(dayAgo))))) return deleted;
      for (const policy of await definitions.retentionPolicies()) {
        const cutoff = new Date(now - policy.retentionDays * DAY_MS);
        const kept = await drop(() => db.instances.asNoTracking().where((i) => i.processKey.eq(policy.key).and(i.status.in(["completed", "cancelled", "timedOut"])).and(i.endedAt.lt(cutoff))));
        if (!kept) return deleted;
      }
    } finally {
      await scope.dispose();
    }
    return deleted;
  }
}
