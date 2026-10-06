import { Column, Entity, Index, UUID } from "bazis/core/orm";

@Entity({ table: "projects" })
export class Project {
  @UUID()
  id = "";

  @Index({ unique: true })
  @Column({ type: "text" })
  name = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
