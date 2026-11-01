import { DbContext, defineOrmOwnedStoreV1 } from "../../../orm";
import { WfHistory } from "./WfHistory.model";
import { WfInstance } from "./WfInstance.model";
import { WfJob } from "./WfJob.model";
import { WfSubscription } from "./WfSubscription.model";
import { WfToken } from "./WfToken.model";

/** The five tables change together: one engine step is one transaction over them. */
export class RuntimeDbContext extends DbContext {
  readonly instances = this.set(WfInstance);
  readonly tokens = this.set(WfToken);
  readonly jobs = this.set(WfJob);
  readonly subscriptions = this.set(WfSubscription);
  readonly history = this.set(WfHistory);
}

export const RUNTIME_ENTITIES = [WfInstance, WfToken, WfJob, WfSubscription, WfHistory] as const;

/** The tables of the Runtime part: bazis creates and checks them in the application database. */
export const runtimeStore = defineOrmOwnedStoreV1({
  contract: "bazis.orm-owned-store/v1",
  storeKey: "bazis.workflow.runtime.v2",
  formatVersion: 1,
  ownedScope: { schema: "public", tablePrefix: "bazis_wf2_run_" },
});
