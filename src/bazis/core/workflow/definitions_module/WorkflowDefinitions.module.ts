import { DI, Module, SERVICE_PROVIDER, scoped } from "../../di";
import { WorkflowTools } from "../internal/WorkflowTools";
import { ProcessesController } from "./http/Processes.controller";
import { DefinitionsDbContext, definitionsStore } from "./model/Definitions.dbContext";
import { WfProcess } from "./model/WfProcess.model";
import { WfVersion } from "./model/WfVersion.model";
import { IWorkflowDefinitions } from "./services/IWorkflowDefinitions.service";
import { WorkflowDefinitions } from "./services/WorkflowDefinitions.service";

/**
 * The process catalog: drafts and published versions ([passport](MODULE.md)).
 * Dependencies are explicit: the framework's classes are not covered by the
 * application's codegen.
 */
@Module({
  ormBazis: { context: DefinitionsDbContext, entities: [WfProcess, WfVersion], ownedStore: definitionsStore, registerRepositories: false },
  providers: [
    DI.singleton(DI.factoryProviderWithResolver(WorkflowTools, [], (resolver) => new WorkflowTools(resolver.resolve(SERVICE_PROVIDER)))),
    scoped(IWorkflowDefinitions, WorkflowDefinitions, [DefinitionsDbContext, WorkflowTools] as const),
  ],
  controllers: [DI.bindDeps(ProcessesController, IWorkflowDefinitions)],
  exports: [IWorkflowDefinitions, WorkflowTools],
})
export class WorkflowDefinitionsModule {}
