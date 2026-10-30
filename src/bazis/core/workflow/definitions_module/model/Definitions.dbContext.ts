import { DbContext, defineOrmOwnedStoreV1 } from "../../../orm";
import { WfProcess } from "./WfProcess.model";
import { WfVersion } from "./WfVersion.model";

export class DefinitionsDbContext extends DbContext {
  readonly processes = this.set(WfProcess);
  readonly versions = this.set(WfVersion);
}

/** The tables of the Definitions part: bazis creates and checks them in the application database. */
export const definitionsStore = defineOrmOwnedStoreV1({
  contract: "bazis.orm-owned-store/v1",
  storeKey: "bazis.workflow.definitions",
  formatVersion: 1,
  ownedScope: { schema: "public", tablePrefix: "bazis_wf_def_" },
});
