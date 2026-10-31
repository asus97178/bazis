import { DI, HOSTED_SERVICE, Module, SERVICE_PROVIDER, scoped } from "../../di";
import { SystemWorkflowClock, WorkflowClock } from "../contracts/WorkflowClock";
import { WorkflowTools } from "../internal/WorkflowTools";
import { CodeProcessCatalog } from "./code/CodeProcessCatalog";
import { CodeProcessPublisher } from "./code/CodeProcessPublisher";
import { codeProcessesOf } from "./code/codeProcesses";
import { ProcessesController } from "./http/Processes.controller";
import { DefinitionsDbContext, definitionsStore } from "./model/Definitions.dbContext";
import { WfProcess } from "./model/WfProcess.model";
import { WfVersion } from "./model/WfVersion.model";
import { IWorkflowDefinitions } from "./services/IWorkflowDefinitions.service";
import { WorkflowDefinitions } from "./services/WorkflowDefinitions.service";

/**
 * The process catalog: drafts and published versions, and the processes
 * declared in code ([passport](MODULE.md)). Dependencies are explicit: the
 * framework's classes are not covered by the application's codegen.
 */
@Module({
  ormBazis: { context: DefinitionsDbContext, entities: [WfProcess, WfVersion], ownedStore: definitionsStore, registerRepositories: false },
  providers: [
    DI.singleton(DI.factoryProvider(WorkflowClock, [], () => new SystemWorkflowClock())),
    DI.singleton(DI.factoryProviderWithResolver(WorkflowTools, [], (resolver) => new WorkflowTools(resolver.resolve(SERVICE_PROVIDER)))),
    DI.singleton(DI.factoryProviderWithResolver(CodeProcessCatalog, [], (resolver) => new CodeProcessCatalog(codeProcessesOf(resolver.resolve(SERVICE_PROVIDER))))),
    scoped(WorkflowDefinitions, WorkflowDefinitions, [DefinitionsDbContext, WorkflowTools, CodeProcessCatalog, WorkflowClock] as const),
    DI.scoped(DI.factoryProviderWithResolver(IWorkflowDefinitions, [], (resolver) => resolver.resolve(WorkflowDefinitions))),
    DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => new CodeProcessPublisher(resolver.resolve(SERVICE_PROVIDER)))),
  ],
  controllers: [DI.bindDeps(ProcessesController, IWorkflowDefinitions)],
  exports: [IWorkflowDefinitions, WorkflowTools, WorkflowClock],
})
export class WorkflowDefinitionsModule {}
