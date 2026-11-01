import { HOSTED_SERVICE, Module, scoped, singleton } from "../../di";
import { SystemWorkflowClock, WorkflowClock } from "../contracts/WorkflowClock";
import { WorkflowTools } from "../internal/WorkflowTools";
import { CodeProcessCatalog } from "./code/CodeProcessCatalog";
import { CodeProcessPublisher } from "./code/CodeProcessPublisher";
import { ProcessesController } from "./http/Processes.controller";
import { DefinitionsDbContext, definitionsStore } from "./model/Definitions.dbContext";
import { WfProcess } from "./model/WfProcess.model";
import { WfVersion } from "./model/WfVersion.model";
import { IWorkflowDefinitions } from "./services/IWorkflowDefinitions.service";
import { WorkflowDefinitions } from "./services/WorkflowDefinitions.service";

/**
 * The process catalog: drafts and published versions, and the processes
 * declared in code ([passport](MODULE.md)).
 */
@Module({
  ormBazis: { context: DefinitionsDbContext, entities: [WfProcess, WfVersion], ownedStore: definitionsStore, registerRepositories: false },
  providers: [
    singleton(WorkflowClock, SystemWorkflowClock),
    singleton(WorkflowTools),
    singleton(CodeProcessCatalog),
    scoped(IWorkflowDefinitions, WorkflowDefinitions),
    singleton(HOSTED_SERVICE, CodeProcessPublisher),
  ],
  controllers: [ProcessesController],
  exports: [IWorkflowDefinitions, WorkflowTools, WorkflowClock],
})
export class WorkflowDefinitionsModule {}
