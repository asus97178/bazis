import { Filterable, ListOptions, ListRequest, Sortable } from "bazis/core/http";
import type { Task } from "../../model/Task.model";

/** `GET /tasks?filter[projectId]=<id>&filter[done]=false&sort=-createdAt` */
@ListOptions({ defaultSize: 20, maxSize: 100 })
export class TaskListQuery extends ListRequest<Task> {
  @Filterable("eq")
  projectId!: string;

  @Sortable()
  @Filterable("eq", "contains")
  title!: string;

  @Filterable("eq")
  done!: boolean;

  @Sortable()
  createdAt!: Date;
}
