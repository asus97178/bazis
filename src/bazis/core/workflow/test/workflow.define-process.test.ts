import { expect, test } from "bun:test";
import { Tool, defineTool } from "@/core/agent";
import { defineProcess, type CodeProcess, type ProcessInput, type ProcessOutput } from "@/core/workflow";
import { hasErrors, validateProcess, type ProcessDocument } from "@/library/workflow";

// 0.138.0: a process written in code is checked while it is written. The lines
// under `@ts-expect-error` are the mistakes the compiler now names; `tsc` fails
// if one of them stops being an error.
class SetStatusInput {
  orderId!: string;
  status!: "approved" | "rejected";
  note?: string;
}

@Tool({ name: "orders.set-status", description: "Sets the status of an order.", input: SetStatusInput, sideEffect: "write", callers: ["workflow"] })
class SetStatusTool {
  execute(input: SetStatusInput): { ok: true } {
    void input;
    return { ok: true };
  }
}

@Tool({ name: "orders.touch", description: "Takes anything.", sideEffect: "read", callers: ["workflow"] })
class LooseTool {
  execute(): object { return {}; }
}

class NotATool {
  execute(): object { return {}; }
}

const findOrders = defineTool({
  name: "orm.order.find",
  description: "Finds orders.",
  sideEffect: "read",
  callers: ["workflow"],
  execute: (input: { where?: object; limit?: number }) => ({ items: [], total: 0, limit: input.limit }),
});

const approval = defineProcess({
  key: "order-approval",
  title: { en: "Order approval", ru: "Согласование заказа" },
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [
      { name: "orderId", type: "string", direction: "in", required: true },
      { name: "amount", type: "number", direction: "in" },
      { name: "needsReview", type: "boolean", direction: "local", default: false },
      { name: "decision", type: "enum", values: ["approved", "rejected"], direction: "out" },
    ],
    settings: { stepTimeout: "PT30S" },
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Review: { kind: "userTask", title: "Review", config: { assignee: { role: "manager" }, saveTo: "review" } },
      Late: { kind: "boundaryTimer", title: "Two days", attachedTo: "Review", config: { duration: "P2D" } },
      Approve: { kind: "serviceTask", title: "Approve", config: { tool: SetStatusTool, input: { orderId: "$input.orderId", status: "approved" } } },
      Reject: { kind: "serviceTask", title: "Reject", config: { tool: "orders.set-status", input: { orderId: "$input.orderId", status: "rejected" } } },
      Count: { kind: "serviceTask", title: "Count", config: { tool: findOrders, input: { limit: 1 }, saveTo: "found" } },
      Touch: { kind: "serviceTask", title: "Touch", config: { tool: LooseTool, input: { anything: 1 } } },
      End: { kind: "end", title: "End" },
    },
    flows: {
      a: { source: "Start", target: "Review" },
      b: { source: "Review", target: "Approve" },
      c: { source: "Late", target: "Reject" },
      d: { source: "Approve", target: "Count" },
      e: { source: "Count", target: "Touch" },
      f: { source: "Touch", target: "End" },
      g: { source: "Reject", target: "End" },
    },
  },
});

const batch = defineProcess({
  key: "order-batch",
  title: "Batch",
  document: {
    schemaVersion: "bazis.workflow/v2",
    variables: [{ name: "orders", type: "list", direction: "in", required: true }],
    settings: { errorHandler: approval },
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Each: { kind: "loop", title: "Each", config: { over: { path: "$input.orders" }, maxIterations: 100 } },
      Call: { kind: "callProcess", title: "Call", parent: "Each", config: { process: approval, input: { orderId: { path: "$item.orderId" } }, saveTo: "result" } },
      Done: { kind: "end", title: "Done", parent: "Each" },
      End: { kind: "end", title: "End" },
    },
    flows: {
      a: { source: "Start", target: "Each" },
      b: { source: "Each", target: "End" },
      c: { source: "Call", target: "Done" },
    },
  },
});

test("references become what the engine stores: a Tool by name, a process by key", () => {
  const nodes = approval.document.nodes;
  expect(nodes.Approve!.config).toEqual({ tool: "orders.set-status", input: { orderId: "$input.orderId", status: "approved" } });
  expect(nodes.Reject!.config!.tool).toBe("orders.set-status");
  expect(nodes.Count!.config!.tool).toBe("orm.order.find");
  expect(batch.document.nodes.Call!.config!.process).toBe("order-approval");
  expect(batch.document.settings).toEqual({ errorHandler: "order-approval" });
  // What is stored is plain JSON and passes the checks of a document.
  expect(JSON.parse(JSON.stringify(approval.document))).toEqual(approval.document);
  const known = new Set(["orders.set-status", "orm.order.find", "orders.touch"]);
  expect(hasErrors(validateProcess(approval.document, { tools: (name) => known.has(name) }))).toBe(false);
  expect(hasErrors(validateProcess(batch.document, { tools: () => true, processes: (key) => key === "order-approval" }))).toBe(false);
});

test("a class that is not a Tool and a value that is not a process are refused where they are written", () => {
  expect(() => defineProcess({
    key: "bad-tool",
    title: "Bad",
    document: {
      schemaVersion: "bazis.workflow/v2",
      nodes: { Start: { kind: "manualStart", title: "Start" }, Step: { kind: "serviceTask", title: "Step", config: { tool: NotATool } }, End: { kind: "end", title: "End" } },
      flows: { a: { source: "Start", target: "Step" }, b: { source: "Step", target: "End" } },
    },
  })).toThrow('defineProcess("bad-tool"): node "Step" names NotATool as its Tool, but it is neither a class with @Tool nor a Tool made by defineTool.');

  const document = { schemaVersion: "bazis.workflow/v2", nodes: { Start: { kind: "manualStart", title: "Start" }, Call: { kind: "callProcess", title: "Call", config: { process: 42 } } }, flows: {} } as unknown as ProcessDocument;
  expect(() => defineProcess({ key: "bad-call", title: "Bad", document })).toThrow('defineProcess("bad-call"): node "Call" must name a process by its key or by its defineProcess(...) result.');
});

test("a document that exists as data is taken as it is", () => {
  const stored: ProcessDocument = JSON.parse(JSON.stringify(approval.document));
  const again = defineProcess({ key: "order-approval-copy", title: "Copy", document: stored });
  expect(again.document).toEqual(stored);
});

test("the variables give the types of a start and of the result", () => {
  type Input = typeof approval extends CodeProcess<infer I, unknown> ? I : never;
  const input: Input = { orderId: "o-1" };
  const full: Input = { orderId: "o-1", amount: 10 };
  // @ts-expect-error orderId is required
  const missing: Input = { amount: 10 };
  // @ts-expect-error amount is a number
  const wrong: Input = { orderId: "o-1", amount: "10" };
  // @ts-expect-error needsReview is local, not a part of the input
  const local: Input = { orderId: "o-1", needsReview: true };
  type Output = typeof approval extends CodeProcess<never, infer O> ? O : never;
  const output: Output = { decision: "approved" };
  // @ts-expect-error decision is one of the enum values
  const other: Output = { decision: "maybe" };
  expect([input, full, missing, wrong, local, output, other]).toHaveLength(7);

  const loose: ProcessInput<readonly []> = {};
  const out: ProcessOutput<readonly []> = {};
  expect([loose, out]).toEqual([{}, {}]);
});

test("the mistakes the compiler names", () => {
  const wrong = () => [
    defineProcess({
      key: "flows",
      title: "Flows",
      document: {
        schemaVersion: "bazis.workflow/v2",
        nodes: { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" } },
        // @ts-expect-error there is no node Finish
        flows: { a: { source: "Start", target: "Finish" } },
      },
    }),
    defineProcess({
      key: "kinds",
      title: "Kinds",
      document: {
        schemaVersion: "bazis.workflow/v2",
        nodes: {
          Start: { kind: "manualStart", title: "Start" },
          // @ts-expect-error a timer takes duration, not delay
          Wait: { kind: "timerCatch", title: "Wait", config: { delay: "PT1H" } },
          // @ts-expect-error a user task needs its assignee
          Ask: { kind: "userTask", title: "Ask", config: { saveTo: "answer" } },
          // @ts-expect-error a boundary node is attached to a step of the document
          Late: { kind: "boundaryTimer", title: "Late", attachedTo: "Nowhere", config: { duration: "P1D" } },
          // @ts-expect-error saveTo is misspelled
          Typo: { kind: "userTask", title: "Typo", config: { assignee: { role: "manager" }, savTo: "answer" } },
          // @ts-expect-error retry has no field attempts
          Retry: { kind: "serviceTask", title: "Retry", config: { tool: "orders.touch", retry: { maxAttempts: 2, attempts: 3 } } },
          // @ts-expect-error only a boundary node is attached to a step
          Loose: { kind: "assign", title: "Loose", attachedTo: "Start", config: { assignments: [{ var: "x", value: 1 }] } },
          // @ts-expect-error a loop body names a node of the document
          Lost: { kind: "end", title: "Lost", parent: "Missing" },
          End: { kind: "end", title: "End" },
        },
        flows: {},
      },
    }),
    defineProcess({
      key: "unknown-kind",
      title: "Unknown kind",
      document: {
        schemaVersion: "bazis.workflow/v2",
        nodes: {
          Start: { kind: "manualStart", title: "Start" },
          // @ts-expect-error there is no such kind
          Odd: { kind: "scriptTask", title: "Odd" },
        },
        flows: {},
      },
    }),
    defineProcess({
      key: "inputs",
      title: "Inputs",
      document: {
        schemaVersion: "bazis.workflow/v2",
        nodes: {
          Start: { kind: "manualStart", title: "Start" },
          // @ts-expect-error the Tool takes no parameter orderID
          Typo: { kind: "serviceTask", title: "Typo", config: { tool: SetStatusTool, input: { orderID: "$input.orderId", status: "approved" } } },
          // @ts-expect-error the Tool needs status
          Short: { kind: "serviceTask", title: "Short", config: { tool: SetStatusTool, input: { orderId: "$input.orderId" } } },
          // @ts-expect-error the Tool needs its input
          Bare: { kind: "serviceTask", title: "Bare", config: { tool: SetStatusTool } },
          // @ts-expect-error the process takes no parameter order
          Call: { kind: "callProcess", title: "Call", config: { process: approval, input: { order: "$input.orderId" } } },
          // @ts-expect-error a process is named by its key or its defineProcess result
          Other: { kind: "callProcess", title: "Other", config: { process: SetStatusTool } },
          End: { kind: "end", title: "End" },
        },
        flows: {},
      },
    }),
  ];
  expect(typeof wrong).toBe("function");
});
