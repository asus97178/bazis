import { DbContext } from "osnv/core/orm";
import { Project } from "./Project.model";

export class ProjectDbContext extends DbContext {
  readonly projects = this.set(Project);
}
