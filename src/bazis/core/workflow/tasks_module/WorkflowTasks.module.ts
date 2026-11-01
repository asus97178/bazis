import { Module, scoped } from "../../di";
import { WorkflowDefinitionsModule } from "../definitions_module/WorkflowDefinitions.module";
import { withEventSubscribers } from "../../kernel";
import { WorkflowRuntimeModule } from "../runtime_module/WorkflowRuntime.module";
import { TaskEvents } from "./events/TaskEvents";
import { TasksController } from "./http/Tasks.controller";
import { TasksDbContext, tasksStore } from "./model/Tasks.dbContext";
import { WfTask } from "./model/WfTask.model";
import { IWorkflowTasks } from "./services/IWorkflowTasks.service";
import { WorkflowTasks } from "./services/WorkflowTasks.service";

/**
 * Tasks for people: the inbox of `userTask` steps ([passport](MODULE.md)).
 */
@Module({
  imports: [WorkflowDefinitionsModule, WorkflowRuntimeModule],
  ormBazis: { context: TasksDbContext, entities: [WfTask], ownedStore: tasksStore, registerRepositories: false },
  providers: [
    scoped(IWorkflowTasks, WorkflowTasks),
    scoped(TaskEvents),
    ...withEventSubscribers(TaskEvents),
  ],
  controllers: [TasksController],
  exports: [IWorkflowTasks],
})
export class WorkflowTasksModule {}
