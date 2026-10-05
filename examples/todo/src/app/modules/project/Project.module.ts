import { Module, scoped } from "osnv/core/di";
import { ProjectController } from "./http/Project.controller";
import { Project } from "./model/Project.model";
import { ProjectDbContext } from "./model/Project.dbContext";
import { IProjectService } from "./services/IProject.service";
import { ProjectService } from "./services/Project.service";

@Module({
  ormOsnova: {
    context: ProjectDbContext,
    entities: [Project],
    // Creates or extends the `projects` table on start (`@Entity({ migrate: true })`).
    migrateOnStart: true,
  },
  controllers: [ProjectController],
  providers: [
    scoped(IProjectService, ProjectService),
  ],
  exports: [IProjectService],
})
export class ProjectModule {}
