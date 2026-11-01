import { Module, scoped, singleton } from "../../di";
import { DefaultWorkflowInputValidator, WorkflowInputValidator } from "../contracts/WorkflowInputValidator";
import { WorkflowDefinitionsModule } from "../definitions_module/WorkflowDefinitions.module";
import { WorkflowRetention } from "./background/WorkflowRetention";
import { WorkflowWorker } from "./background/WorkflowWorker";
import { workflowRuntimeConfig } from "./config/Runtime.config";
import { EventsController } from "./http/Events.controller";
import { InstancesController } from "./http/Instances.controller";
import { GraphCache } from "./internal/GraphCache";
import { Schedules } from "./internal/Schedules";
import { TimerStep } from "./internal/TimerStep";
import { ToolStep } from "./internal/ToolStep";
import { WorkflowEngine } from "./internal/WorkflowEngine";
import { RUNTIME_ENTITIES, RuntimeDbContext, runtimeStore } from "./model/Runtime.dbContext";
import { IWorkflowRuntime } from "./services/IWorkflowRuntime.service";
import { WorkflowRuntime } from "./services/WorkflowRuntime.service";

/**
 * Runs published versions: instances, tokens, jobs, history, the worker and
 * retention ([passport](MODULE.md)). The application replaces the input
 * validator by registering its own `WorkflowInputValidator`.
 */
@Module({
  imports: [WorkflowDefinitionsModule],
  config: [workflowRuntimeConfig],
  ormBazis: { context: RuntimeDbContext, entities: [...RUNTIME_ENTITIES], ownedStore: runtimeStore, registerRepositories: false },
  providers: [
    singleton(GraphCache),
    scoped(WorkflowEngine),
    scoped(ToolStep),
    scoped(TimerStep),
    scoped(Schedules),
    singleton(WorkflowInputValidator, DefaultWorkflowInputValidator),
    scoped(IWorkflowRuntime, WorkflowRuntime),
  ],
  controllers: [InstancesController, EventsController],
  background: [WorkflowWorker, WorkflowRetention],
  exports: [IWorkflowRuntime, WorkflowInputValidator],
})
export class WorkflowRuntimeModule {}
