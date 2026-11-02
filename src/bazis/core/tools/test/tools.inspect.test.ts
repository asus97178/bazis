import { expect, test } from "bun:test";
import { Module } from "@/core/di";
import { Column, DbContext, Entity, UUID } from "@/core/orm";
import { ormEntityTools, StandardToolsModule } from "@/core/tools";
import { WorkflowModule } from "@/core/workflow";
import { inspectProcesses } from "@/core/workflow/definitions_module/code/inspectProcesses";

@Entity({ table: "inspect_notes" })
class Note {
  @UUID()
  id = "";

  @Column({ type: "text" })
  text = "";
}

class NotesDbContext extends DbContext {
  readonly notes = this.set(Note);
}

const tools = ormEntityTools(Note, { context: NotesDbContext, ops: ["find"], fields: ["text"] });

test("bazis workflow check tells of a kind no module owns", () => {
  @Module({ imports: [WorkflowModule], tools })
  class Without {}
  expect(inspectProcesses(Without).errors).toEqual(expect.arrayContaining([expect.stringContaining("orm.field")]));

  @Module({ imports: [WorkflowModule, StandardToolsModule], tools })
  class With {}
  const inspection = inspectProcesses(With);
  expect(inspection.errors).toEqual([]);
  expect(inspection.tools).toEqual(["orm.note.find"]);
});
