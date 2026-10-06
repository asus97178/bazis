import { Module } from "bazis/core/di";
import { ProjectModule } from "../project/Project.module";
import { TaskModule } from "../task/Task.module";
import { ReportController } from "./Report.controller";

/** Read-only summary over other modules; owns no data of its own. */
@Module({
  imports: [ProjectModule, TaskModule],
  controllers: [ReportController],
  exports: [],
})
export class ReportModule {}
