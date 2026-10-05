import { Filterable, ListOptions, ListRequest, Sortable } from "osnv/core/http";
import type { Project } from "../../model/Project.model";

@ListOptions({ defaultSize: 20, maxSize: 100 })
export class ProjectListQuery extends ListRequest<Project> {
  @Sortable()
  @Filterable("eq", "contains", "startsWith")
  name!: string;

  @Sortable()
  createdAt!: Date;
}
