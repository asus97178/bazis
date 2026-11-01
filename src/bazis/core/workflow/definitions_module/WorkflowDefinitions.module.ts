import { AccessModule } from "../../access";
import { HOSTED_SERVICE, Module, scoped, singleton } from "../../di";
import { SystemWorkflowClock, WorkflowClock } from "../contracts/WorkflowClock";
import { workflowConfig } from "../contracts/Workflow.config";
import { DefaultWorkflowExtensions, WorkflowExtensions } from "../contracts/WorkflowExtensions";
import { WorkflowEvents } from "../internal/WorkflowEvents";
import { WorkflowLanguages } from "../internal/WorkflowLanguages";
import { WorkflowTools } from "../internal/WorkflowTools";
import { definitionsPermissions } from "./access/Definitions.permissions";
import { FolderReferences } from "./access/Folder.references";
import { ProcessReferences } from "./access/Process.references";
import { ProcessFolderLookup } from "./access/ProcessFolder.lookup";
import { CatalogImport } from "./code/CatalogImport";
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
 * declared in code ([passport](MODULE.md)). The application checks its own
 * `extensions` by registering its `WorkflowExtensions`.
 */
@Module({
  imports: [AccessModule],
  permissions: definitionsPermissions,
  references: { "workflow.process": ProcessReferences, "workflow.folder": FolderReferences },
  config: [workflowConfig],
  ormBazis: { context: DefinitionsDbContext, entities: [WfProcess, WfVersion], ownedStore: definitionsStore, registerRepositories: false },
  providers: [
    singleton(WorkflowClock, SystemWorkflowClock),
    singleton(WorkflowTools),
    singleton(CodeProcessCatalog),
    singleton(WorkflowLanguages),
    singleton(WorkflowExtensions, DefaultWorkflowExtensions),
    scoped(WorkflowEvents),
    scoped(CatalogImport),
    scoped(IWorkflowDefinitions, WorkflowDefinitions),
    scoped(ProcessReferences),
    scoped(FolderReferences),
    scoped(ProcessFolderLookup),
    singleton(HOSTED_SERVICE, CodeProcessPublisher),
  ],
  controllers: [ProcessesController],
  exports: [IWorkflowDefinitions, WorkflowTools, WorkflowClock, WorkflowEvents, WorkflowLanguages, WorkflowExtensions, ProcessFolderLookup],
})
export class WorkflowDefinitionsModule {}
