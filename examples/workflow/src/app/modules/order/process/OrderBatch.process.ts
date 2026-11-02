import { defineProcess } from "bazis/core/workflow";

/**
 * Approves several orders: the approval of each is a process of its own, two at a
 * time. The batch acts for itself, gives up after a week and gives back the
 * decisions in the order of the list.
 */
export const orderBatch = defineProcess({
  key: "order-batch",
  title: { en: "Batch approval", ru: "Согласование партии" },
  folder: "Sales/Orders",
  retentionDays: 90,
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "orders", type: "list", direction: "in", required: true },
      { name: "decisions", type: "list", direction: "out", default: [] },
    ],
    settings: { runAs: "process", runTimeout: "P7D" },
    nodes: {
      Start: { kind: "manualStart", title: { en: "Start", ru: "Старт" } },
      Each: {
        kind: "loop",
        title: { en: "Each order", ru: "Каждый заказ" },
        config: {
          over: { path: "$input.orders" },
          maxIterations: 100,
          parallel: { limit: 2 },
          collect: { from: { path: "$vars.result.decision" }, to: "decisions" },
        },
      },
      Approval: {
        kind: "callProcess",
        title: { en: "Approve", ru: "Согласовать" },
        parent: "Each",
        config: { process: "order-approval", input: { orderId: { path: "$item.orderId" }, amount: { path: "$item.amount" } }, saveTo: "result" },
      },
      Done: { kind: "end", title: { en: "Done", ru: "Готово" }, parent: "Each" },
      End: { kind: "end", title: { en: "End", ru: "Конец" } },
    },
    flows: {
      begin: { source: "Start", target: "Each" },
      finish: { source: "Each", target: "End" },
      body: { source: "Approval", target: "Done" },
    },
  },
});
