import { DI, Module, scoped } from "../../di";
import { withEventSubscribers } from "../../kernel";
import { IWorkflowRuntime } from "../runtime_module/services/IWorkflowRuntime.service";
import { WorkflowRuntimeModule } from "../runtime_module/WorkflowRuntime.module";
import { TaskEvents } from "./events/TaskEvents";
import { TasksController } from "./http/Tasks.controller";
import { TasksDbContext, tasksStore } from "./model/Tasks.dbContext";
import { WfTask } from "./model/WfTask.model";
import { IWorkflowTasks } from "./services/IWorkflowTasks.service";
import { WorkflowTasks } from "./services/WorkflowTasks.service";

/**
 * Tasks for people: the inbox of `userTask` steps ([passport](MODULE.md)).
 * Dependencies are explicit: the framework's classes are not covered by the
 * application's codegen.
 */
@Module({
  imports: [WorkflowRuntimeModule],
  ormBazis: { context: TasksDbContext, entities: [WfTask], ownedStore: tasksStore, registerRepositories: false },
  providers: [
    scoped(WorkflowTasks, WorkflowTasks, [TasksDbContext, IWorkflowRuntime] as const),
    DI.scoped(DI.factoryProviderWithResolver(IWorkflowTasks, [], (resolver) => resolver.resolve(WorkflowTasks))),
    scoped(TaskEvents, TaskEvents, [WorkflowTasks] as const),
    ...withEventSubscribers(TaskEvents),
  ],
  controllers: [DI.bindDeps(TasksController, IWorkflowTasks)],
  exports: [IWorkflowTasks],
})
export class WorkflowTasksModule {}
