import { Module, scoped } from "osnv/core/di";
import { ProjectController } from "./http/Project.controller";
import { Project } from "./model/Project.model";
import { ProjectDbContext } from "./model/Project.dbContext";
import { IProjectService } from "./services/IProject.service";
import { ProjectService } from "./services/Project.service";

@Module({
  ormOsnv: {
    context: ProjectDbContext,
    entities: [Project],
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
