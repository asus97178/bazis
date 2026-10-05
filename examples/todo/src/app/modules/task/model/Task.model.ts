import { Column, Entity, Index, UUID } from "osnv/core/orm";

@Entity({ table: "tasks" })
export class Task {
  @UUID()
  id = "";

  /** Id of the owning project (owned by the Project module, checked on create). */
  @Index()
  @Column({ type: "text" })
  projectId = "";

  @Column({ type: "text" })
  title = "";

  @Column({ type: "boolean" })
  done = false;

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
