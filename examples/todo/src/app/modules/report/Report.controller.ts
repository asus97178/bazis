import { Controller, Get } from "bazis/core/http";
import type { IProjectService } from "../project/services/IProject.service";
import type { ITaskService } from "../task/services/ITask.service";

@Controller("report")
export class ReportController {
  constructor(
    private readonly projects: IProjectService,
    private readonly tasks: ITaskService,
  ) {}

  /** `GET /report` → `{ projects, tasks, done }` */
  @Get()
  async get() {
    const [projects, tasks, done] = await Promise.all([
      this.projects.count(),
      this.tasks.count(),
      this.tasks.count(true),
    ]);
    return { projects, tasks, done };
  }
}
