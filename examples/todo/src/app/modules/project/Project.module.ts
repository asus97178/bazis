import { Module, scoped } from "bazis/core/di";
import { ProjectController } from "./http/Project.controller";
import { ProjectDbContext } from "./model/Project.dbContext";
import { IProjectService } from "./services/IProject.service";
import { ProjectService } from "./services/Project.service";

@Module({
  ormBazis: {
    context: ProjectDbContext,
    // The module decides schema creation: additive migration of its tables on start.
    migrateOnStart: true,
  },
  controllers: [ProjectController],
  providers: [
    scoped(IProjectService, ProjectService),
  ],
  exports: [IProjectService],
})
export class ProjectModule {}
