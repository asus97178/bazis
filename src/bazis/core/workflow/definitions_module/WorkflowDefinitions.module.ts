import { AccessModule } from "../../access";
import { HOSTED_SERVICE, Module, scoped, singleton } from "../../di";
import { SystemWorkflowClock, WorkflowClock } from "../contracts/WorkflowClock";
import { WorkflowEvents } from "../internal/WorkflowEvents";
import { WorkflowTools } from "../internal/WorkflowTools";
import { definitionsPermissions } from "./access/Definitions.permissions";
import { ProcessReferences } from "./access/Process.references";
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
  imports: [AccessModule],
  permissions: definitionsPermissions,
  references: { "workflow.process": ProcessReferences },
  ormBazis: { context: DefinitionsDbContext, entities: [WfProcess, WfVersion], ownedStore: definitionsStore, registerRepositories: false },
  providers: [
    singleton(WorkflowClock, SystemWorkflowClock),
    singleton(WorkflowTools),
    singleton(CodeProcessCatalog),
    scoped(WorkflowEvents),
    scoped(IWorkflowDefinitions, WorkflowDefinitions),
    scoped(ProcessReferences),
    singleton(HOSTED_SERVICE, CodeProcessPublisher),
  ],
  controllers: [ProcessesController],
  exports: [IWorkflowDefinitions, WorkflowTools, WorkflowClock, WorkflowEvents],
})
export class WorkflowDefinitionsModule {}
