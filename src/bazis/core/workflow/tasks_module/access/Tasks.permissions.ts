import { definePermissions } from "../../../access";

/**
 * The right to work on tasks (WORKFLOW-002 §6.2). Which tasks are the
 * subject's is decided by their addressees, not by an owner column.
 */
export const tasksPermissions = definePermissions({
  "workflow.tasks.work": {
    title: { en: "Work on tasks", ru: "Работать с задачами" },
    scope: { column: "partition" },
    on: { process: { ref: "workflow.process", column: "processKey" } },
  },
});
