import { describe, expect, test } from "bun:test";
import { fromStructure, isStructured, parseExpression, personalPaths, printExpression, processToMermaid, toStructure, validateProcess, type ProcessDocument, type ProcessFlow, type ProcessNode } from "../index";

const step = (title: string, more: Partial<ProcessNode> = {}): ProcessNode => ({ kind: "assign", title, config: { assignments: [{ var: "total", value: 1 }] }, ...more });
const process = (nodes: Record<string, unknown>, flows: Record<string, ProcessFlow>, extra: Partial<ProcessDocument> = {}): ProcessDocument => ({
  schemaVersion: "bazis.workflow/v2",
  variables: [{ name: "items", type: "list", direction: "in" }, { name: "total", type: "number", direction: "out" }],
  nodes: { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" }, ...nodes } as ProcessDocument["nodes"],
  flows,
  ...extra,
});

/** Start → Loop → End; the body is Inner → BodyEnd. */
const looped = (config: Record<string, unknown> = {}, inner: ProcessNode = step("Inner", { parent: "Loop" }), extra: Partial<ProcessDocument> = {}): ProcessDocument => process(
  {
    Loop: { kind: "loop", title: "Loop", config: { over: { path: "$input.items" }, maxIterations: 10, ...config } },
    Inner: inner,
    BodyEnd: { kind: "end", title: "Done", parent: "Loop" },
  },
  { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" }, c: { source: "Inner", target: "BodyEnd" } },
  extra,
);

const errors = (document: unknown, options = {}) => validateProcess(document, options).filter((issue) => issue.severity === "error").map((issue) => issue.code);
const messages = (document: unknown) => validateProcess(document).filter((issue) => issue.severity === "error").map((issue) => issue.message).join("\n");

describe("the loop in a document", () => {
  test("a body with one entry and an end of its own is valid", () => {
    expect(errors(looped())).toEqual([]);
    expect(errors(looped({ over: undefined, times: 3 }))).toEqual([]);
    expect(errors(looped({ over: undefined, while: { op: "lt", args: [{ path: "$index" }, 3] } }))).toEqual([]);
    expect(errors(looped({ parallel: { limit: 5 }, onItemError: "skip", collect: { from: { path: "$item" }, to: "total" } }))).toEqual([]);
  });

  test("the config is checked", () => {
    expect(messages(looped({ times: 2 }))).toContain("exactly one of over, while or times");
    expect(messages(looped({ over: undefined }))).toContain("exactly one of over, while or times");
    expect(messages(looped({ maxIterations: undefined }))).toContain("maxIterations");
    expect(messages(looped({ maxIterations: 10_001 }))).toContain("maxIterations");
    expect(messages(looped({ over: undefined, times: 11 }))).toContain("config.times");
    expect(messages(looped({ parallel: { limit: 0 } }))).toContain("config.parallel.limit");
    expect(messages(looped({ over: undefined, while: true, parallel: { limit: 2 } }))).toContain("does not go with while");
    expect(messages(looped({ onItemError: "retry" }))).toContain("config.onItemError");
    expect(messages(looped({ collect: { to: "total" } }))).toContain("config.collect.from");
    expect(messages(looped({ collect: { from: 1, to: "nowhere" } }))).toContain("not a declared local or out variable");
    expect(messages(looped({ item: "items" }))).toContain("already a variable");
    expect(messages(looped({ item: "same", index: "same" }))).toContain("must differ");
  });

  test("the body: one entry, its own end, no flow across its border", () => {
    const noEnd = process(
      { Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } }, Inner: step("I", { parent: "Loop" }) },
      { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" } },
    );
    expect(errors(noEnd)).toContain("loop_body");

    const empty = process(
      { Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } } },
      { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" } },
    );
    expect(errors(empty)).toContain("loop_body");

    const twoEntries = process(
      { Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } }, A: step("A", { parent: "Loop" }), B: step("B", { parent: "Loop" }), E: { kind: "end", title: "E", parent: "Loop" } },
      { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" }, c: { source: "A", target: "E" }, d: { source: "B", target: "E" } },
    );
    expect(errors(twoEntries)).toContain("loop_body");

    const across = process(
      { Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } }, A: step("A", { parent: "Loop" }), E: { kind: "end", title: "E", parent: "Loop" } },
      { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" }, c: { source: "A", target: "E" }, d: { source: "Start", target: "A" } },
    );
    expect(errors(across)).toContain("flow_across_container");
  });

  test("parent names a loop, and loops do not contain each other", () => {
    expect(errors(looped({}, step("Inner", { parent: "End" })))).toContain("container_invalid");
    const circle = process(
      {
        A: { kind: "loop", title: "A", parent: "B", config: { times: 1, maxIterations: 1 } },
        B: { kind: "loop", title: "B", parent: "A", config: { times: 1, maxIterations: 1 } },
      },
      { a: { source: "Start", target: "End" } },
    );
    expect(errors(circle)).toContain("container_invalid");
    const start = looped({}, { kind: "manualStart", title: "S", parent: "Loop" } as ProcessNode);
    expect(errors(start)).toContain("container_invalid");
  });

  test("a boundary lives in the container of its step; an error boundary hangs on what can fail", () => {
    const onLoop = process(
      {
        Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } },
        Inner: step("I", { parent: "Loop" }),
        BodyEnd: { kind: "end", title: "E", parent: "Loop" },
        Late: { kind: "boundaryError", title: "Err", attachedTo: "Loop" },
      },
      { a: { source: "Start", target: "Loop" }, b: { source: "Loop", target: "End" }, c: { source: "Inner", target: "BodyEnd" }, d: { source: "Late", target: "End" } },
    );
    expect(errors(onLoop)).toEqual([]);
    const inside = { ...onLoop, nodes: { ...onLoop.nodes, Late: { kind: "boundaryTimer", title: "T", attachedTo: "Loop", parent: "Loop", config: { duration: "PT1H" } } } } as ProcessDocument;
    expect(errors(inside)).toContain("boundary_attach");
  });

  test("$item and $index exist only in a body; what a body saves stays in it", () => {
    const outside = process({ S: { kind: "assign", title: "S", config: { assignments: [{ var: "total", value: { path: "$index" } }] } } }, { a: { source: "Start", target: "S" }, b: { source: "S", target: "End" } });
    expect(messages(outside)).toContain("$index exists only inside a loop body");

    const inBody = looped({ item: "order" }, { kind: "assign", title: "I", parent: "Loop", config: { assignments: [{ var: "total", value: { op: "add", args: [{ path: "$item.price" }, { path: "$vars.order.tax" }, { path: "$index" }] } }] } });
    expect(errors(inBody)).toEqual([]);

    const saved = process(
      {
        Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } },
        Call: { kind: "serviceTask", title: "C", parent: "Loop", config: { tool: "a.b", saveTo: "local" } },
        Use: { kind: "assign", title: "U", parent: "Loop", config: { assignments: [{ var: "total", value: { path: "$vars.local" } }, { var: "total", value: { path: "$nodes.Call.x" } }] } },
        BodyEnd: { kind: "end", title: "E", parent: "Loop" },
        After: { kind: "assign", title: "A", config: { assignments: [{ var: "total", value: { path: "$vars.local" } }] } },
        Node: { kind: "assign", title: "N", config: { assignments: [{ var: "total", value: { path: "$nodes.Call.x" } }] } },
      },
      {
        a: { source: "Start", target: "Loop" },
        b: { source: "Loop", target: "After" },
        c: { source: "After", target: "Node" },
        d: { source: "Node", target: "End" },
        e: { source: "Call", target: "Use" },
        f: { source: "Use", target: "BodyEnd" },
      },
    );
    const found = validateProcess(saved).filter((issue) => issue.severity === "error");
    expect(found.map((issue) => issue.node).sort()).toEqual(["After", "Node"]);
  });

  test("a called process and an error handler must be published when the catalog is known", () => {
    const calling = process({ Call: { kind: "callProcess", title: "C", config: { process: "other", input: { a: { path: "$input.items" } }, saveTo: "result" } } }, { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" } });
    expect(errors(calling)).toEqual([]);
    expect(errors(calling, { processes: () => false })).toEqual(["unknown_process"]);
    expect(errors(calling, { processes: () => true })).toEqual([]);
    expect(errors(process({}, { a: { source: "Start", target: "End" } }, { settings: { errorHandler: "gone" } }), { processes: () => false })).toEqual(["unknown_process"]);
    const bad = process({ Call: { kind: "callProcess", title: "C", config: { process: "Not A Key" } } }, { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" } });
    expect(errors(bad)).toEqual(["config_invalid"]);
    const missing = process({ Call: { kind: "callProcess", title: "C", config: { process: "other", input: { a: { path: "$input.nothing" } } } } }, { a: { source: "Start", target: "Call" }, b: { source: "Call", target: "End" } });
    expect(messages(missing)).toContain("the input has no field nothing");
  });
});

describe("the loop in a designer", () => {
  test("a list with a loop goes to a tree and back", () => {
    const document = looped();
    expect(isStructured(document)).toBe(true);
    const structure = toStructure(document)!;
    const loop = structure.steps[0]!;
    expect(loop.type).toBe("loop");
    if (loop.type !== "loop") return;
    expect(loop.body.map((item) => item.id)).toEqual(["Inner"]);
    expect(loop.bodyEnd.id).toBe("BodyEnd");
    const back = fromStructure(structure);
    expect(back.nodes).toEqual(document.nodes);
    expect(back.flows).toEqual(document.flows);
  });

  test("a body that is not a list makes the process read only", () => {
    const document = process(
      {
        Loop: { kind: "loop", title: "L", config: { times: 1, maxIterations: 1 } },
        Split: { kind: "exclusiveGateway", title: "S", parent: "Loop" },
        A: step("A", { parent: "Loop" }),
        E1: { kind: "end", title: "E1", parent: "Loop" },
        E2: { kind: "end", title: "E2", parent: "Loop" },
      },
      {
        a: { source: "Start", target: "Loop" },
        b: { source: "Loop", target: "End" },
        c: { source: "Split", target: "A", condition: true },
        d: { source: "Split", target: "E1", isDefault: true },
        e: { source: "A", target: "E2" },
      },
    );
    expect(errors(document)).toEqual([]);
    expect(isStructured(document)).toBe(false);
    expect(validateProcess(document).map((issue) => issue.code)).toContain("not_structured");
  });

  test("Mermaid draws the body inside a subgraph", () => {
    const text = processToMermaid(looped());
    expect(text).toContain('subgraph Loop["Loop<br/><small>for each</small>"]');
    expect(text).toContain("    Inner");
    expect(text).toContain("Start --> Loop");
  });
});

describe("the element of a loop in the text of an expression", () => {
  test("$item and $index read and print like other paths", () => {
    const parsed = parseExpression("{$item.price} * {$index}");
    expect(parsed).toEqual({ op: "mul", args: [{ path: "$item.price" }, { path: "$index" }] });
    expect(printExpression(parsed)).toBe("{$item.price} * {$index}");
  });
});

describe("personal data in a loop", () => {
  test("the element of a loop over personal data is personal too, through nested loops", () => {
    const document = {
      variables: [{ name: "people", type: "list", direction: "in", personal: true }],
      nodes: {
        Inner: { kind: "loop", title: "I", parent: "Outer", config: { over: { path: "$item.phones" }, item: "phone" } },
        Outer: { kind: "loop", title: "O", config: { over: { path: "$input.people" }, item: "person" } },
      },
    } as unknown as ProcessDocument;
    expect([...personalPaths(document)].sort()).toEqual(["$input.people", "$item", "$vars.person", "$vars.phone"]);
  });
});
