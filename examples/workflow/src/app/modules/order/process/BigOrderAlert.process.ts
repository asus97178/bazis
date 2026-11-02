import { defineProcess } from "bazis/core/workflow";

/**
 * A word about big orders: starts by the event the order service writes in its own
 * transaction. What is small does not start it, and several big orders of one
 * customer within ten minutes make one alert about the last of them.
 */
export const bigOrderAlert = defineProcess({
  key: "big-order-alert",
  title: { en: "Big order alert", ru: "Сигнал о крупном заказе" },
  folder: "Sales/Orders",
  retentionDays: 30,
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "orderId", type: "string", direction: "in", required: true },
      { name: "about", type: "string", direction: "out" },
    ],
    nodes: {
      Start: {
        kind: "eventStart",
        title: "An order is placed",
        config: {
          event: "orders.placed",
          filter: { op: "gte", args: [{ path: "$event.amount" }, 100000] },
          debounce: { key: { path: "$event.customerId" }, window: "PT10M" },
        },
      },
      Note: { kind: "assign", title: "Note", config: { assignments: [{ var: "about", value: { path: "$input.orderId" } }] } },
      End: { kind: "end", title: "Done" },
    },
    flows: {
      a: { source: "Start", target: "Note" },
      b: { source: "Note", target: "End" },
    },
  },
});
