import { definePermissions } from "../../../access";
import { ProcessPartitionLookup } from "./ProcessPartition.lookup";

const process = { ref: "workflow.process", column: "key" };
const folder = { ref: "workflow.folder", column: "folder" };

/**
 * The rights of the process catalog (WORKFLOW-002 §6.2). A process is one per
 * application: only reading it has partitions, those `WorkflowPartitions`
 * connects it to.
 */
export const definitionsPermissions = definePermissions({
  "workflow.processes.read": {
    title: { en: "See processes", ru: "Видеть процессы" },
    scope: { lookup: ProcessPartitionLookup },
    on: { process, folder },
  },
  "workflow.processes.manage": {
    title: { en: "Edit processes", ru: "Редактировать процессы" },
    on: { process, folder },
  },
  "workflow.processes.publish": {
    title: { en: "Publish processes", ru: "Публиковать процессы" },
    on: { process, folder },
  },
});
