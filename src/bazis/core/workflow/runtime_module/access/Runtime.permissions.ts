import { definePermissions } from "../../../access";

const process = { ref: "workflow.process", column: "processKey" };

/** The rights of running processes (WORKFLOW-002 §6.2). */
export const runtimePermissions = definePermissions({
  "workflow.instances.start": {
    title: { en: "Start processes", ru: "Запускать процессы" },
    scope: "request",
    on: { process },
  },
  "workflow.instances.read": {
    title: { en: "See instances", ru: "Видеть экземпляры" },
    scope: { column: "partition" },
    on: { process },
    owner: "startedById",
  },
  "workflow.instances.manage": {
    title: { en: "Cancel and retry instances", ru: "Отменять и повторять экземпляры" },
    scope: { column: "partition" },
    on: { process },
  },
  "workflow.events.emit": {
    title: { en: "Send events to processes", ru: "Отправлять события процессам" },
    scope: "request",
    on: { event: { type: "string" } },
  },
});
