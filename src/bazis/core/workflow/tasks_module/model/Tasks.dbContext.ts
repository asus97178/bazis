import { DbContext, defineOrmOwnedStoreV1 } from "../../../orm";
import { WfTask } from "./WfTask.model";

export class TasksDbContext extends DbContext {
  readonly tasks = this.set(WfTask);
}

/** The table of the Tasks part: bazis creates and checks it in the application database. */
export const tasksStore = defineOrmOwnedStoreV1({
  contract: "bazis.orm-owned-store/v1",
  storeKey: "bazis.workflow.tasks.v2",
  formatVersion: 1,
  ownedScope: { schema: "public", tablePrefix: "bazis_wf2_task_" },
});
