import { DI, Module, SERVICE_PROVIDER, scoped } from "../../di";
import { EventBus, LOGGER } from "../../kernel";
import { DefaultWorkflowInputValidator, WorkflowInputValidator } from "../contracts/WorkflowInputValidator";
import { WorkflowDefinitionsModule } from "../definitions_module/WorkflowDefinitions.module";
import { IWorkflowDefinitions } from "../definitions_module/services/IWorkflowDefinitions.service";
import { WorkflowTools } from "../internal/WorkflowTools";
import { WorkflowRetention } from "./background/WorkflowRetention";
import { WorkflowWorker } from "./background/WorkflowWorker";
import { workflowRuntimeConfig } from "./config/Runtime.config";
import { InstancesController } from "./http/Instances.controller";
import { GraphCache } from "./internal/GraphCache";
import { ToolStep } from "./internal/ToolStep";
import { WorkflowEngine } from "./internal/WorkflowEngine";
import { RUNTIME_ENTITIES, RuntimeDbContext, runtimeStore } from "./model/Runtime.dbContext";
import { IWorkflowRuntime } from "./services/IWorkflowRuntime.service";
import { WorkflowRuntime } from "./services/WorkflowRuntime.service";

/**
 * Runs published versions: instances, tokens, jobs, history, the worker and
 * retention ([passport](MODULE.md)). Dependencies are explicit: the framework's
 * classes are not covered by the application's codegen.
 */
@Module({
  imports: [WorkflowDefinitionsModule],
  config: [workflowRuntimeConfig],
  ormBazis: { context: RuntimeDbContext, entities: [...RUNTIME_ENTITIES], ownedStore: runtimeStore, registerRepositories: false },
  providers: [
    DI.singleton(DI.factoryProvider(GraphCache, [], () => new GraphCache())),
    DI.scoped(DI.factoryProviderWithResolver(WorkflowEngine, [], (resolver) => new WorkflowEngine(
      resolver.resolve(RuntimeDbContext),
      resolver.resolve(IWorkflowDefinitions),
      resolver.resolve(GraphCache),
      resolver.resolve(EventBus),
      resolver,
      resolver.tryResolve(LOGGER),
    ))),
    scoped(ToolStep, ToolStep, [RuntimeDbContext, WorkflowEngine, WorkflowTools] as const),
    // The application's input validator, if it registered one anywhere; the built-in one otherwise.
    DI.scoped(DI.factoryProviderWithResolver(IWorkflowRuntime, [], (resolver) => new WorkflowRuntime(
      resolver.resolve(RuntimeDbContext),
      resolver.resolve(WorkflowEngine),
      resolver.resolve(IWorkflowDefinitions),
      resolver.resolve(SERVICE_PROVIDER).tryResolve(WorkflowInputValidator) ?? new DefaultWorkflowInputValidator(),
    ))),
  ],
  controllers: [DI.bindDeps(InstancesController, IWorkflowRuntime)],
  background: [
    DI.bindDeps(WorkflowWorker, SERVICE_PROVIDER, workflowRuntimeConfig.token),
    DI.bindDeps(WorkflowRetention, SERVICE_PROVIDER, workflowRuntimeConfig.token),
  ],
  exports: [IWorkflowRuntime],
})
export class WorkflowRuntimeModule {}
