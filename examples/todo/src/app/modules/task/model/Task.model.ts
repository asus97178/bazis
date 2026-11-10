import { Column, Entity, Index, UUID, Required } from "bazis/core/orm";

@Entity({ table: "tasks" })
export class Task {
  @UUID()
  id = "";

  /** Id of the owning project (owned by the Project module, checked on create). */
  @Index()
  @Required()
  @Column({ type: "text" })
  projectId = "";

  @Required()
  @Column({ type: "text" })
  title = "";

  @Required()
  @Column({ type: "boolean" })
  done = false;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
