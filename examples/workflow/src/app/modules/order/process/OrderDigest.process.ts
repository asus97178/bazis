import { defineProcess } from "bazis/core/workflow";

/**
 * On weekdays at 9:00 in Moscow counts the orders that wait: a schedule with its
 * own clocks, and a run that has not ended takes the place of the next one. The
 * step is a Tool made from the entity.
 */
export const orderDigest = defineProcess({
  key: "order-digest",
  title: { en: "Morning digest", ru: "Утренняя сводка" },
  folder: "Sales/Orders",
  retentionDays: 30,
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "found", type: "object", direction: "local" },
      { name: "waiting", type: "integer", direction: "out" },
    ],
    nodes: {
      Start: { kind: "scheduleStart", title: "Weekdays at 9:00", config: { cron: "0 9 * * 1-5", timezone: "Europe/Moscow", overlap: "skip" } },
      Find: { kind: "serviceTask", title: "Find waiting orders", config: { tool: "orm.order.find", input: { where: { status: "new" }, limit: 1 }, saveTo: "found" } },
      Count: { kind: "assign", title: "Count", config: { assignments: [{ var: "waiting", value: { path: "$vars.found.total" } }] } },
      End: { kind: "end", title: "Done" },
    },
    flows: {
      a: { source: "Start", target: "Find" },
      b: { source: "Find", target: "Count" },
      c: { source: "Count", target: "End" },
    },
  },
});
