import { Column, Entity, Index, UUID, Required } from "bazis/core/orm";

@Entity({ table: "projects" })
export class Project {
  @UUID()
  id = "";

  /** Two concurrent requests cannot both take a name: the index decides, and a taken one answers 409 with this text. */
  @Index({ unique: true, conflict: "A project with this name already exists" })
  @Required()
  @Column({ type: "text" })
  name = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
