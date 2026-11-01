import { defineProcess } from "bazis/core/workflow";

/** A small order is approved at once; a manager decides on a big one within two days, else it is rejected. */
export const orderApproval = defineProcess({
  key: "order-approval",
  title: "Order approval",
  retentionDays: 90,
  document: {
    schemaVersion: "bazis.workflow/v1",
    input: {
      fields: [
        { code: "orderId", type: "string", required: true },
        { code: "amount", type: "number", required: true },
      ],
    },
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Big: { kind: "exclusiveGateway", title: "Big order?" },
      Review: {
        kind: "userTask",
        title: "Approve the order",
        config: {
          assignee: { role: "manager" },
          form: { fields: [{ code: "approved", type: "boolean", required: true }] },
          saveTo: "review",
        },
      },
      Late: { kind: "boundaryTimer", title: "Two days", attachedTo: "Review", config: { duration: "P2D" } },
      Decision: { kind: "exclusiveGateway", title: "Approved?" },
      Approve: { kind: "serviceTask", title: "Approve", config: { tool: "orders.set-status", input: { orderId: "$input.orderId", status: "approved" } } },
      Reject: { kind: "serviceTask", title: "Reject", config: { tool: "orders.set-status", input: { orderId: "$input.orderId", status: "rejected" } } },
      End: { kind: "end", title: "End" },
    },
    flows: {
      f1: { source: "Start", target: "Big" },
      f2: { source: "Big", target: "Review", condition: { path: "$input.amount", op: "gt", value: 1000 } },
      f3: { source: "Big", target: "Approve", isDefault: true },
      f4: { source: "Review", target: "Decision" },
      f5: { source: "Decision", target: "Approve", condition: { path: "$vars.review.approved", op: "eq", value: true } },
      f6: { source: "Decision", target: "Reject", isDefault: true },
      f7: { source: "Late", target: "Reject" },
      f8: { source: "Approve", target: "End" },
      f9: { source: "Reject", target: "End" },
    },
  },
});
