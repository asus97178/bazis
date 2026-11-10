import { AccessModule } from "../../access";
import { HOSTED_SERVICE, Module, scoped, singleton } from "../../di";
import { SystemWorkflowClock, WorkflowClock } from "../contracts/WorkflowClock";
import { workflowConfig } from "../contracts/Workflow.config";
import { DefaultWorkflowExtensions, WorkflowExtensions } from "../contracts/WorkflowExtensions";
import { DefaultWorkflowPartitions, WorkflowPartitions } from "../contracts/WorkflowPartitions";
import { WorkflowEvents } from "../internal/WorkflowEvents";
import { WorkflowLanguages } from "../internal/WorkflowLanguages";
import { WorkflowReferences } from "../internal/WorkflowReferences";
import { WorkflowTools } from "../internal/WorkflowTools";
import { definitionsPermissions } from "./access/Definitions.permissions";
import { FolderReferences } from "./access/Folder.references";
import { ProcessReferences } from "./access/Process.references";
import { ProcessFolderLookup } from "./access/ProcessFolder.lookup";
import { CatalogImport } from "./code/CatalogImport";
import { CodeProcessCatalog } from "./code/CodeProcessCatalog";
import { CodeProcessPublisher } from "./code/CodeProcessPublisher";
import { ProcessesController } from "./http/Processes.controller";
import { PublishedVersions } from "./internal/PublishedVersions";
import { DefinitionsDbContext, definitionsStore } from "./model/Definitions.dbContext";
import { WfProcess } from "./model/WfProcess.model";
import { WfVersion } from "./model/WfVersion.model";
import { IWorkflowDefinitions } from "./services/IWorkflowDefinitions.service";
import { WorkflowDefinitions } from "./services/WorkflowDefinitions.service";

/**
 * The process catalog: drafts and published versions, and the processes
 * declared in code ([passport](MODULE.md)). The application checks its own
 * `extensions` by registering its `WorkflowExtensions` and says where processes
 * work by registering its `WorkflowPartitions`.
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
    singleton(PublishedVersions),
    singleton(WorkflowLanguages),
    singleton(WorkflowExtensions, DefaultWorkflowExtensions),
    singleton(WorkflowPartitions, DefaultWorkflowPartitions),
    scoped(WorkflowEvents),
    scoped(WorkflowReferences),
    scoped(CatalogImport),
    scoped(IWorkflowDefinitions, WorkflowDefinitions),
    // Shared with the Runtime and Tasks parts: owned and exported here.
    scoped(ProcessFolderLookup),
    singleton(HOSTED_SERVICE, CodeProcessPublisher),
  ],
  controllers: [ProcessesController],
  exports: [IWorkflowDefinitions, WorkflowReferences, WorkflowTools, WorkflowClock, WorkflowEvents, WorkflowLanguages, WorkflowExtensions, WorkflowPartitions, ProcessFolderLookup],
})
export class WorkflowDefinitionsModule {}
