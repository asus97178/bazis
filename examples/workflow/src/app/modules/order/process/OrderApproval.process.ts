import { defineProcess } from "bazis/core/workflow";

/**
 * A small order is approved at once; a manager decides on a big one within two
 * days, else it is rejected. The process gives back how it ended.
 */
export const orderApproval = defineProcess({
  key: "order-approval",
  title: { en: "Order approval", ru: "Согласование заказа" },
  folder: "Sales/Orders",
  retentionDays: 90,
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "orderId", type: "string", direction: "in", required: true },
      { name: "amount", type: "number", direction: "in", required: true },
      { name: "needsReview", type: "boolean", direction: "local", default: false },
      { name: "decision", type: "enum", values: ["approved", "rejected"], direction: "out" },
    ],
    settings: { stepTimeout: "PT30S", log: { variables: true } },
    nodes: {
      Start: { kind: "manualStart", title: { en: "Start", ru: "Старт" } },
      Classify: { kind: "assign", title: { en: "Classify", ru: "Оценить" }, config: { assignments: [{ var: "needsReview", value: { op: "gt", args: [{ path: "$input.amount" }, 1000] } }] } },
      Big: { kind: "exclusiveGateway", title: { en: "Big order?", ru: "Большой заказ?" } },
      Review: {
        kind: "userTask",
        title: { en: "Approve the order", ru: "Согласовать заказ" },
        config: {
          assignee: { role: "manager" },
          form: { fields: [{ name: "approved", type: "boolean", required: true, title: { en: "Approved", ru: "Согласован" } }] },
          saveTo: "review",
        },
      },
      Late: { kind: "boundaryTimer", title: { en: "Two days", ru: "Два дня" }, attachedTo: "Review", config: { duration: "P2D" } },
      Decision: { kind: "exclusiveGateway", title: { en: "Approved?", ru: "Согласован?" } },
      Approved: { kind: "assign", title: { en: "Approved", ru: "Согласован" }, config: { assignments: [{ var: "decision", value: "approved" }] } },
      Approve: { kind: "serviceTask", title: { en: "Approve", ru: "Подтвердить" }, config: { tool: "orders.set-status", input: { orderId: "$input.orderId", status: "approved" } } },
      Rejected: { kind: "assign", title: { en: "Rejected", ru: "Отклонён" }, config: { assignments: [{ var: "decision", value: "rejected" }] } },
      Reject: { kind: "serviceTask", title: { en: "Reject", ru: "Отклонить" }, config: { tool: "orders.set-status", input: { orderId: "$input.orderId", status: "rejected" } } },
      End: { kind: "end", title: { en: "End", ru: "Конец" } },
    },
    flows: {
      f1: { source: "Start", target: "Classify" },
      f2: { source: "Classify", target: "Big" },
      f3: { source: "Big", target: "Review", condition: { path: "$vars.needsReview" } },
      f4: { source: "Big", target: "Approved", isDefault: true },
      f5: { source: "Review", target: "Decision" },
      f6: { source: "Decision", target: "Approved", condition: { op: "eq", args: [{ path: "$vars.review.approved" }, true] } },
      f7: { source: "Decision", target: "Rejected", isDefault: true },
      f8: { source: "Late", target: "Rejected" },
      f9: { source: "Approved", target: "Approve" },
      f10: { source: "Rejected", target: "Reject" },
      f11: { source: "Approve", target: "End" },
      f12: { source: "Reject", target: "End" },
    },
  },
});
