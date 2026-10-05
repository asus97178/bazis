import { Module, scoped } from "osnv/core/di";
import { ProjectModule } from "../project/Project.module";
import { TaskController } from "./http/TaskController";
import { Task } from "./model/Task.model";
import { TaskDbContext } from "./model/TaskDbContext";
import { ITaskService } from "./services/ITask.service";
import { TaskService } from "./services/Task.service";

@Module({
  // A task belongs to a project: TaskService checks it through IProjectService.
  imports: [ProjectModule],
  ormOsnova: {
    context: TaskDbContext,
    entities: [Task],
    migrateOnStart: true,
  },
  controllers: [TaskController],
  providers: [
    scoped(ITaskService, TaskService),
  ],
  exports: [ITaskService],
})
export class TaskModule {}
