import { definePermissions } from "../../../access";
import { ProcessFolderLookup } from "../../definitions_module/access/ProcessFolder.lookup";

const process = { ref: "workflow.process", column: "processKey" };
const folder = { ref: "workflow.folder", lookup: ProcessFolderLookup };

/** The rights of running processes (WORKFLOW-002 §6.2). */
export const runtimePermissions = definePermissions({
  "workflow.instances.start": {
    title: { en: "Start processes", ru: "Запускать процессы" },
    scope: "request",
    on: { process, folder },
  },
  "workflow.instances.read": {
    title: { en: "See instances", ru: "Видеть экземпляры" },
    scope: { column: "partition" },
    on: { process, folder },
    owner: "startedById",
  },
  "workflow.instances.manage": {
    title: { en: "Cancel and retry instances", ru: "Отменять и повторять экземпляры" },
    scope: { column: "partition" },
    on: { process, folder },
  },
  "workflow.events.emit": {
    title: { en: "Send events to processes", ru: "Отправлять события процессам" },
    scope: "request",
    on: { event: { type: "string" } },
  },
});
