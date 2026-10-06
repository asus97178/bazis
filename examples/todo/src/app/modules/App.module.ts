import { Module } from "bazis/core/di";
import { ProjectModule } from "./project/Project.module";
import { TaskModule } from "./task/Task.module";
import { ReportModule } from "./report/Report.module";

@Module({ imports: [ProjectModule, TaskModule, ReportModule], exports: [] })
export class AppModule {}
