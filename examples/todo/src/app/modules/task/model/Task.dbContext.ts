import { DbContext } from "bazis/core/orm";
import { Task } from "./Task.model";

export class TaskDbContext extends DbContext {
  readonly tasks = this.set(Task);
}
