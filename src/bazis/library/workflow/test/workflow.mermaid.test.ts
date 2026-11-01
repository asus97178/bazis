import { expect, test } from "bun:test";
import { processToMermaid, type ProcessDocument } from "@/library/workflow";

test("a process becomes a Mermaid flowchart with shapes by kind, details, conditions and boundary links", () => {
  const document: ProcessDocument = {
    schemaVersion: "bazis.workflow/v2",
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Pay: { kind: "serviceTask", title: "Pay \"now\"", config: { tool: "payments.charge" } },
      Paid: { kind: "exclusiveGateway", title: "Paid?" },
      Review: { kind: "userTask", title: "Call", config: { assignee: { role: "support" } } },
      Late: { kind: "boundaryTimer", title: "Two hours", attachedTo: "Review", config: { duration: "PT2H" } },
      "end-1": { kind: "end", title: "Done" },
      end: { kind: "end", title: "Late" },
    },
    flows: {
      a: { source: "Start", target: "Pay" },
      b: { source: "Pay", target: "Paid" },
      c: { source: "Paid", target: "end-1", condition: { op: "and", args: [{ op: "eq", args: [{ path: "$vars.paid" }, true] }, { op: "notEmpty", args: [{ path: "$input.note" }] }] } },
      d: { source: "Paid", target: "Review", isDefault: true },
      e: { source: "Review", target: "end-1", title: "called" },
      f: { source: "Late", target: "end" },
    },
  };
  expect(processToMermaid(document)).toBe(`flowchart LR
  Start(["Start"])
  Pay[["Pay #quot;now#quot;<br/><small>payments.charge</small>"]]
  Paid{"Paid?"}
  Review["Call<br/><small>role support</small>"]
  Late(("Two hours<br/><small>PT2H</small>"))
  n_end_1(("Done"))
  n_end(("Late"))
  Review -.- Late
  Start --> Pay
  Pay --> Paid
  Paid -->|"{paid} == true and notEmpty({$input.note})"| n_end_1
  Paid -->|"default"| Review
  Review -->|"called"| n_end_1
  Late --> n_end
`);
});
