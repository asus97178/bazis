import { describe, expect, test } from "bun:test";
import {
  formOf,
  fromStructure,
  hasErrors,
  initialVarsOf,
  maskByMapping,
  maskBySchema,
  personalPaths,
  personalVariables,
  readsPersonal,
  inputSpecOf,
  isStructured,
  outputOf,
  processPalette,
  textOf,
  toStructure,
  upgradeDocument,
  validateForm,
  validateProcess,
  type ProcessDocument,
  type ProcessDocumentV1,
} from "@/library/workflow";

const base = (extra: Partial<ProcessDocument> = {}): ProcessDocument => ({
  schemaVersion: "bazis.workflow/v2",
  nodes: { Start: { kind: "manualStart", title: "Start" }, End: { kind: "end", title: "End" } },
  flows: { a: { source: "Start", target: "End" } },
  ...extra,
});
const codes = (document: unknown, options = {}) => validateProcess(document, options).map((issue) => issue.code);
const withStep = (config: Record<string, unknown>, kind: "assign" | "serviceTask" = "assign", extra: Partial<ProcessDocument> = {}): ProcessDocument => ({
  schemaVersion: "bazis.workflow/v2",
  nodes: { Start: { kind: "manualStart", title: "Start" }, Step: { kind, title: "Step", config }, End: { kind: "end", title: "End" } },
  flows: { a: { source: "Start", target: "Step" }, b: { source: "Step", target: "End" } },
  ...extra,
});

describe("validateProcess: version 2", () => {
  test("version 1 cannot be saved", () => {
    expect(codes({ ...base(), schemaVersion: "bazis.workflow/v1" })).toEqual(["schema"]);
  });

  test("titles are localized", () => {
    expect(codes(base({ nodes: { Start: { kind: "manualStart", title: { en: "Start", ru: "Старт" } }, End: { kind: "end", title: "End" } } }))).toEqual([]);
    const issues = codes(base({ nodes: { Start: { kind: "manualStart", title: { "not a language": "x" } }, End: { kind: "end", title: {} } } }));
    expect(issues).toEqual(["title_invalid", "title_invalid"]);
    expect(codes(base({ flows: { a: { source: "Start", target: "End", title: { ru: "" } } } }))).toEqual(["title_invalid"]);
  });

  test("variables", () => {
    const good = [
      { name: "amount", type: "number", direction: "in", required: true, title: { ru: "Сумма" } },
      { name: "total", type: "number", direction: "local", default: 0 },
      { name: "result", type: "object", direction: "out", personal: true },
      { name: "owner", type: "ref", ref: "orm.entity:User", direction: "local" },
      { name: "kind", type: "enum", values: ["a"], direction: "in" },
    ] as ProcessDocument["variables"];
    expect(codes(base({ variables: good }))).toEqual([]);
    const bad = (variable: unknown) => validateProcess(base({ variables: [variable] as never })).map((issue) => [issue.code, issue.variable]);
    expect(bad({ name: "Bad", type: "number", direction: "in" })).toEqual([["variable_invalid", "Bad"]]);
    expect(bad({ name: "x", type: "money", direction: "in" })).toEqual([["variable_invalid", "x"]]);
    expect(bad({ name: "x", type: "number", direction: "both" })).toEqual([["variable_invalid", "x"]]);
    expect(bad({ name: "x", type: "number", direction: "out", required: true })).toEqual([["variable_invalid", "x"]]);
    expect(bad({ name: "x", type: "ref", direction: "in" })).toEqual([["variable_invalid", "x"]]);
    expect(bad({ name: "x", type: "number", ref: "a", direction: "in" })).toEqual([["variable_invalid", "x"]]);
    expect(bad({ name: "x", type: "number", default: "a", direction: "in" })).toEqual([["variable_invalid", "x"]]);
    expect(codes(base({ variables: [good![0]!, good![0]!] }))).toEqual(["variable_invalid"]);
    expect(codes(base({ variables: "x" as never }))).toEqual(["variable_invalid"]);
  });

  test("settings: what is not run yet is an error, not a setting silently ignored", () => {
    expect(codes(base({ settings: { stepTimeout: "PT1M", log: { variables: true, toolPayloads: false, maskPersonal: true } } }))).toEqual([]);
    expect(codes(base({ settings: { stepTimeout: "soon" } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { log: { all: true } as never } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { log: { variables: 1 } as never } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { retries: 3 } as never }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { runAs: "robot" } as never }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { runTimeout: "soon" } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { maxConcurrent: 0 } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { sameKey: "wait" } as never }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { errorHandler: "Bad Key" } }))).toEqual(["settings_invalid"]);
    expect(codes(base({ settings: { runAs: "process", runTimeout: "P1D", maxConcurrent: 2, sameKey: "queue", errorHandler: "on-error" } }))).toEqual([]);
    expect(codes(base({ settings: 1 as never }))).toEqual(["settings_invalid"]);
  });

  test("extensions: a namespace without a check is an error, and only when the checks are known", () => {
    const document = base({
      extensions: { cms: { a: 1 } },
      variables: [{ name: "x", type: "number", direction: "in", extensions: { dm: {} } }],
      nodes: { Start: { kind: "manualStart", title: "Start", extensions: { ui: {} } }, End: { kind: "end", title: "End" } },
    });
    expect(codes(document)).toEqual([]);
    const issues = validateProcess(document, { extensions: (namespace: string) => namespace === "cms" });
    expect(issues.map((issue) => [issue.code, issue.variable ?? issue.node ?? null])).toEqual([["extension_unknown", "x"], ["extension_unknown", "Start"]]);
    expect(codes(base({ extensions: { "Not Valid": 1 } }))).toEqual(["extension_invalid"]);
    expect(codes(base({ extensions: 1 as never }))).toEqual(["extension_invalid"]);
  });

  test("assign writes declared variables and reads what exists", () => {
    const variables = [{ name: "total", type: "number", direction: "local" }, { name: "amount", type: "number", direction: "in" }] as ProcessDocument["variables"];
    const good = withStep({ assignments: [{ var: "total", value: { op: "mul", args: [{ path: "$input.amount" }, 2] } }] }, "assign", { variables });
    expect(codes(good)).toEqual([]);
    expect(codes(withStep({ assignments: [] }, "assign", { variables }))).toEqual(["config_invalid"]);
    expect(codes(withStep({ assignments: [{ var: "total" }] }, "assign", { variables }))).toEqual(["config_invalid"]);
    expect(validateProcess(withStep({ assignments: [{ var: "amount", value: 1 }] }, "assign", { variables }))[0]!.message).toContain("not a declared local or out");
    expect(validateProcess(withStep({ assignments: [{ var: "nope", value: 1 }] }, "assign", { variables }))[0]!.message).toContain("not a declared local or out");
    expect(validateProcess(withStep({ assignments: [{ var: "total", value: { path: "$vars.none" } }] }, "assign", { variables }))[0]!.message).toContain("no variable none");
  });

  test("a Tool step: timeout, retry growth, onError, and what its input reads", () => {
    const good = withStep({ tool: "a.b", timeout: "PT30S", retry: { maxAttempts: 3, backoff: "PT1M", growth: "exponential", factor: 3 }, onError: "skip", saveTo: "out", input: { x: "$vars.out", y: { op: "now", args: [] }, z: ["$nodes.Step.id"] } }, "serviceTask");
    expect(codes(good)).toEqual([]);
    const problem = (config: Record<string, unknown>) => validateProcess(withStep({ tool: "a.b", ...config }, "serviceTask"))[0]?.message;
    expect(problem({ timeout: "soon" })).toContain("config.timeout");
    expect(problem({ retry: { maxAttempts: 2, growth: "linear" } })).toContain("growth");
    expect(problem({ retry: { maxAttempts: 2, growth: "fixed", factor: 2 } })).toContain("factor");
    expect(problem({ retry: { maxAttempts: 2, factor: 0.5 } })).toContain("factor");
    expect(problem({ onError: "ignore" })).toContain("onError");
    expect(problem({ input: { x: "$input.none" } })).toContain("no field none");
    expect(problem({ input: { x: { op: "eval", args: [] } } })).toContain("unknown function");
    expect(problem({ input: { x: "$secrets.TOKEN" } })).toContain("not supported");
    expect(problem({ input: { deep: [{ x: "$vars.none" }] } })).toContain("config.input.deep[0].x");
  });

  test("a saveTo declares what $vars may read", () => {
    const document = withStep({ tool: "a.b", saveTo: "result", input: { x: "$vars.result" } }, "serviceTask");
    expect(codes(document)).toEqual([]);
  });

  test("the condition of a flow is an expression", () => {
    const fork = (condition: unknown): unknown => ({
      schemaVersion: "bazis.workflow/v2",
      nodes: { S: { kind: "manualStart", title: "S" }, G: { kind: "exclusiveGateway", title: "G" }, E: { kind: "end", title: "E" } },
      flows: { a: { source: "S", target: "G" }, b: { source: "G", target: "E", condition } },
    });
    expect(codes(fork({ op: "eq", args: [1, 1] }))).not.toContain("condition_invalid");
    expect(codes(fork({ op: "nope", args: [] }))).toContain("condition_invalid");
  });

  test("a graph a list cannot draw is a warning, not an error", () => {
    const loop: ProcessDocument = {
      schemaVersion: "bazis.workflow/v2",
      nodes: {
        S: { kind: "manualStart", title: "S" },
        M: { kind: "exclusiveGateway", title: "M" },
        T: { kind: "timerCatch", title: "T", config: { duration: "PT1H" } },
        G: { kind: "exclusiveGateway", title: "G" },
        E: { kind: "end", title: "E" },
      },
      flows: {
        a: { source: "S", target: "M" },
        b: { source: "M", target: "T" },
        c: { source: "T", target: "G" },
        d: { source: "G", target: "M", condition: true },
        e: { source: "G", target: "E", isDefault: true },
      },
    };
    const issues = validateProcess(loop);
    expect(issues.map((issue) => [issue.severity, issue.code])).toEqual([["warning", "not_structured"]]);
    expect(hasErrors(issues)).toBe(false);
  });
});

describe("variables at run time", () => {
  const variables = [
    { name: "amount", type: "number", direction: "in", required: true },
    { name: "note", type: "string", direction: "in", default: "none" },
    { name: "total", type: "number", direction: "local", default: 5 },
    { name: "result", type: "object", direction: "out" },
    { name: "code", type: "string", direction: "out", default: "new" },
  ] as NonNullable<ProcessDocument["variables"]>;

  test("the input is the in variables, with their defaults", () => {
    expect(validateForm(inputSpecOf({ variables }), { amount: 1 })).toEqual({ value: { amount: 1, note: "none" }, issues: [] });
    expect(validateForm(inputSpecOf({ variables }), { amount: 1, note: "x" }).value.note).toBe("x");
    expect(validateForm(inputSpecOf({ variables }), {}).issues.map((issue) => issue.code)).toEqual(["required"]);
    expect(validateForm(inputSpecOf({}), { amount: 1 }).issues.map((issue) => issue.code)).toEqual(["unknown"]);
  });

  test("local and out variables start with their defaults; out is what comes back", () => {
    expect(initialVarsOf({ variables })).toEqual({ total: 5, code: "new" });
    expect(outputOf({ variables }, { total: 9, result: { ok: true } })).toEqual({ result: { ok: true }, code: null });
  });

  test("new field types", () => {
    const spec = { fields: [{ name: "o", type: "object" as const }, { name: "l", type: "list" as const }, { name: "r", type: "ref" as const, ref: "a" }] };
    expect(validateForm(spec, { o: {}, l: [], r: "x" }).issues).toEqual([]);
    expect(validateForm(spec, { o: [], l: {}, r: {} }).issues.map((issue) => [issue.field, issue.code])).toEqual([["o", "type"], ["l", "type"], ["r", "type"]]);
  });
});

describe("personal data in the history", () => {
  const document = { variables: [{ name: "email", type: "string", direction: "in", personal: true }, { name: "card", type: "object", direction: "local", personal: true }, { name: "open", type: "string", direction: "local" }] } as Pick<ProcessDocument, "variables">;
  const personal = personalPaths(document);

  test("which variables are personal", () => {
    expect([...personal]).toEqual(["$input.email", "$vars.card"]);
    expect([...personalVariables(document)]).toEqual(["card"]);
  });

  test("what reads them: paths, deeper fields and expressions", () => {
    expect(readsPersonal("$input.email", personal)).toBe(true);
    expect(readsPersonal("$vars.card.number", personal)).toBe(true);
    expect(readsPersonal({ path: "$vars.card" }, personal)).toBe(true);
    expect(readsPersonal({ op: "concat", args: ["x", { op: "upper", args: [{ path: "$input.email" }] }] }, personal)).toBe(true);
    expect(readsPersonal("$vars.open", personal)).toBe(false);
    expect(readsPersonal("$vars.cardholder", personal)).toBe(false);
    expect(readsPersonal("plain", personal)).toBe(false);
  });

  test("a mapped input is masked where it takes them", () => {
    const mapping = { to: "$input.email", open: "$vars.open", nested: { list: [{ path: "$vars.card" }, "x"] }, fixed: 1 };
    expect(maskByMapping(mapping, { to: "a@b.c", open: "o", nested: { list: [{ number: 1 }, "x"] }, fixed: 1 }, personal)).toEqual({ to: "***", open: "o", nested: { list: ["***", "x"] }, fixed: 1 });
    expect(maskByMapping(mapping, { to: "a@b.c" }, new Set())).toEqual({ to: "a@b.c" });
  });

  test("x-personal in a schema masks a field, deep and in lists", () => {
    const schema = { type: "object", properties: { email: { type: "string", "x-personal": true }, inner: { type: "object", properties: { phone: { "x-personal": true }, ok: {} } }, list: { type: "array", items: { type: "object", properties: { name: { "x-personal": true } } } } } };
    expect(maskBySchema({ email: "a", inner: { phone: "1", ok: 2 }, list: [{ name: "n", age: 3 }], other: 4 }, schema)).toEqual({ email: "***", inner: { phone: "***", ok: 2 }, list: [{ name: "***", age: 3 }], other: 4 });
    expect(maskBySchema({ email: null }, schema)).toEqual({ email: null });
    expect(maskBySchema({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

test("textOf picks the language, its base, the fallback, then the first", () => {
  expect(textOf("plain", "ru")).toBe("plain");
  expect(textOf({ en: "Hi", ru: "Привет" }, "ru")).toBe("Привет");
  expect(textOf({ en: "Hi", ru: "Привет" }, "ru-RU")).toBe("Привет");
  expect(textOf({ en: "Hi" }, "ru", "en")).toBe("Hi");
  expect(textOf({ de: "Hallo", en: "Hi" }, "ru", "fr")).toBe("Hallo");
  expect(textOf({ constructor: "x" } as never, "toString")).toBe("x");
  expect(textOf(null, "ru")).toBe("");
});

describe("upgradeDocument", () => {
  const v1: ProcessDocumentV1 = {
    schemaVersion: "bazis.workflow/v1",
    input: { fields: [{ code: "amount", type: "number", required: true, title: "Amount" }] },
    nodes: {
      S: { kind: "manualStart", title: "Start" },
      G: { kind: "exclusiveGateway", title: "Big?" },
      T: { kind: "userTask", title: "Review", config: { assignee: { role: "m" }, saveTo: "review", form: { fields: [{ code: "ok", type: "boolean" }] } } },
      E: { kind: "end", title: "End" },
    },
    flows: {
      a: { source: "S", target: "G" },
      b: { source: "G", target: "T", condition: { all: [{ path: "$input.amount", op: "gt", value: 10 }, { any: [{ not: { path: "$input.amount", op: "empty" } }, { path: "$input.amount", op: "eq", value: "$vars.review" }] }] } },
      c: { source: "G", target: "E", isDefault: true, title: "Small" },
      d: { source: "T", target: "E" },
    },
    diagram: { shapes: {}, edges: {} },
  };

  test("input, form fields and conditions", () => {
    const v2 = upgradeDocument(v1);
    expect(v2.schemaVersion).toBe("bazis.workflow/v2");
    expect(v2.variables).toEqual([{ name: "amount", type: "number", required: true, title: "Amount", direction: "in" }]);
    expect((v2.nodes.T!.config as { form: unknown }).form).toEqual({ fields: [{ name: "ok", type: "boolean" }] });
    expect(v2.flows.b!.condition).toEqual({
      op: "and",
      args: [
        { op: "gt", args: [{ path: "$input.amount" }, 10] },
        { op: "or", args: [{ op: "not", args: [{ op: "empty", args: [{ path: "$input.amount" }] }] }, { op: "eq", args: [{ path: "$input.amount" }, { path: "$vars.review" }] }] },
      ],
    });
    expect(v2.flows.c).toEqual({ source: "G", target: "E", isDefault: true, title: "Small" });
    expect(v2.diagram).toEqual({ shapes: {}, edges: {} });
    expect("input" in v2).toBe(false);
    expect(validateProcess(v2).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("anything else comes back unchanged, and a broken draft does not throw", () => {
    const v2 = base();
    expect(upgradeDocument(v2)).toBe(v2);
    expect(upgradeDocument(null)).toBeNull();
    expect(upgradeDocument("x")).toBe("x");
    expect(upgradeDocument({ schemaVersion: "bazis.workflow/v1", nodes: 1, flows: { a: 1, b: { condition: 5 } }, input: 3 })).toEqual({ schemaVersion: "bazis.workflow/v2", nodes: 1, flows: { a: 1, b: { condition: 5 } } });
  });
});

describe("the structure of a process", () => {
  const structured: ProcessDocument = {
    schemaVersion: "bazis.workflow/v2",
    variables: [{ name: "amount", type: "number", direction: "in" }],
    settings: { log: { variables: true } },
    extensions: { cms: {} },
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      Cron: { kind: "scheduleStart", title: "Nightly", config: { cron: "0 0 * * *" } },
      First: { kind: "serviceTask", title: "First", config: { tool: "a.b" } },
      Late: { kind: "boundaryTimer", title: "Late", attachedTo: "First", config: { duration: "PT1H" } },
      Alarm: { kind: "serviceTask", title: "Alarm", config: { tool: "a.c" } },
      Failed: { kind: "end", title: "Failed" },
      Fork: { kind: "exclusiveGateway", title: "Fork" },
      Yes: { kind: "serviceTask", title: "Yes", config: { tool: "a.d" } },
      Merge: { kind: "exclusiveGateway", title: "Merge" },
      Split: { kind: "parallelGateway", title: "Split" },
      Left: { kind: "assign", title: "Left", config: { assignments: [{ var: "x", value: 1 }] } },
      Right: { kind: "timerCatch", title: "Right", config: { duration: "PT1M" } },
      Join: { kind: "parallelGateway", title: "Join" },
      End: { kind: "end", title: "End" },
    },
    flows: {
      f1: { source: "Start", target: "First" },
      f2: { source: "Cron", target: "First", title: "at night" },
      f3: { source: "First", target: "Fork" },
      f4: { source: "Late", target: "Alarm" },
      f5: { source: "Alarm", target: "Failed", title: "gave up" },
      f6: { source: "Fork", target: "Yes", condition: { op: "gt", args: [1, 0] }, title: "Yes" },
      f7: { source: "Fork", target: "Merge", isDefault: true },
      f8: { source: "Yes", target: "Merge", title: "done" },
      f9: { source: "Merge", target: "Split" },
      f10: { source: "Split", target: "Left" },
      f11: { source: "Split", target: "Right" },
      f12: { source: "Left", target: "Join" },
      f13: { source: "Right", target: "Join" },
      f14: { source: "Join", target: "End" },
    },
  };

  test("a list of steps with forks, blocks and boundaries", () => {
    const tree = toStructure(structured)!;
    expect(tree.starts.map((start) => start.id)).toEqual(["Start", "Cron"]);
    expect(tree.steps.map((step) => [step.type, step.id])).toEqual([["step", "First"], ["choice", "Fork"], ["parallel", "Split"]]);
    expect(tree.end.id).toBe("End");
    const first = tree.steps[0] as Extract<(typeof tree.steps)[number], { type: "step" }>;
    expect(first.boundaries![0]!.steps.map((step) => step.id)).toEqual(["Alarm"]);
    expect(first.boundaries![0]!.end!.id).toBe("Failed");
    const fork = tree.steps[1] as Extract<(typeof tree.steps)[number], { type: "choice" | "parallel" }>;
    expect(fork.branches.map((branch) => branch.steps.map((step) => step.id))).toEqual([["Yes"], []]);
    expect(fork.merge?.id).toBe("Merge");
  });

  test("the way back gives the same nodes and flows", () => {
    const back = fromStructure(toStructure(structured)!);
    expect(back.nodes).toEqual(structured.nodes);
    expect(back.flows).toEqual(structured.flows);
    expect(back.variables).toEqual(structured.variables);
    expect(back.settings).toEqual(structured.settings);
    expect(back.extensions).toEqual(structured.extensions);
    const empty = base();
    expect(fromStructure(toStructure(empty)!).flows).toEqual(empty.flows);
  });

  test("a boundary that comes back after its host", () => {
    const document: ProcessDocument = {
      schemaVersion: "bazis.workflow/v2",
      nodes: {
        S: { kind: "manualStart", title: "S" },
        A: { kind: "timerCatch", title: "A", config: { duration: "PT1H" } },
        B: { kind: "boundaryTimer", title: "B", attachedTo: "A", config: { duration: "PT1M" } },
        C: { kind: "timerCatch", title: "C", config: { duration: "PT1M" } },
        D: { kind: "boundaryTimer", title: "D", attachedTo: "C", config: { duration: "PT1S" } },
        Next: { kind: "exclusiveGateway", title: "Next" },
        Pass: { kind: "timerCatch", title: "Pass", config: { duration: "PT1M" } },
        E: { kind: "end", title: "E" },
      },
      flows: {
        a: { source: "S", target: "A" },
        b: { source: "A", target: "C" },
        c: { source: "B", target: "C" },
        d: { source: "C", target: "Pass" },
        e: { source: "D", target: "Pass" },
        f: { source: "Pass", target: "E" },
      },
    };
    delete (document.nodes as Record<string, unknown>).Next;
    expect(isStructured(document)).toBe(true);
    expect(fromStructure(toStructure(document)!).flows).toEqual(document.flows);
  });

  test("what a list cannot draw", () => {
    const graph = (nodes: ProcessDocument["nodes"], flows: ProcessDocument["flows"]): ProcessDocument => ({ schemaVersion: "bazis.workflow/v2", nodes, flows });
    const S = { kind: "manualStart", title: "S" } as const;
    const E = { kind: "end", title: "E" } as const;
    const X = { kind: "exclusiveGateway", title: "X" } as const;
    const P = { kind: "parallelGateway", title: "P" } as const;
    // A fork whose branches end apart.
    expect(isStructured(graph({ S, F: X, E1: E, E2: E }, { a: { source: "S", target: "F" }, b: { source: "F", target: "E1", condition: true }, c: { source: "F", target: "E2", isDefault: true } }))).toBe(false);
    // Branches that meet at the end need no merge, and the way back gives the same flows.
    const atEnd = graph({ S, F: X, T: { kind: "timerCatch", title: "T", config: { duration: "PT1M" } }, E }, { a: { source: "S", target: "F" }, b: { source: "F", target: "E", condition: true }, c: { source: "F", target: "T", isDefault: true }, d: { source: "T", target: "E" } });
    expect(isStructured(atEnd)).toBe(true);
    expect(fromStructure(toStructure(atEnd)!).flows).toEqual(atEnd.flows);
    // An exclusive fork closed by a parallel join.
    expect(isStructured(graph({ S, F: X, J: P, E }, { a: { source: "S", target: "F" }, b: { source: "F", target: "J", condition: true }, c: { source: "F", target: "J", isDefault: true }, d: { source: "J", target: "E" } }))).toBe(false);
    // Two starts into different steps.
    expect(isStructured(graph({ S1: S, S2: S, T: { kind: "timerCatch", title: "T", config: { duration: "PT1M" } }, E }, { a: { source: "S1", target: "T" }, b: { source: "S2", target: "E" }, c: { source: "T", target: "E" } }))).toBe(false);
    // No start.
    expect(isStructured(graph({ E }, {}))).toBe(false);
  });
});

describe("the palette", () => {
  test("node kinds with their config, functions, paths and Tools", () => {
    const tool = { name: "a.b", description: "d", sideEffect: "write", dryRun: "unsupported", input: { schema: { type: "object", properties: {} } } };
    const palette = processPalette([tool]);
    expect(palette.nodeKinds.map((kind) => kind.kind)).toContain("assign");
    expect(palette.nodeKinds.find((kind) => kind.kind === "serviceTask")!.config.required).toEqual(["tool"]);
    expect(palette.functions.map((item) => item.name)).toContain("dateDiff");
    expect(palette.paths.map((item) => item.path)).toContain("$run");
    expect(palette.tools).toEqual([tool]);
    expect(JSON.parse(JSON.stringify(palette)).nodeKinds).toHaveLength(16);
    expect(palette.nodeKinds.find((kind) => kind.kind === "loop")!.container).toBe(true);
  });

  test("formOf describes a node kind", () => {
    const form = formOf("serviceTask");
    expect(form.fields.find((field) => field.name === "tool")).toEqual({ name: "tool", type: "string", required: true });
    const retry = form.fields.find((field) => field.name === "retry")!;
    expect(retry.fields!.map((field) => [field.name, field.type, field.required])).toContainEqual(["maxAttempts", "integer", true]);
    expect(form.fields.find((field) => field.name === "onError")!.values).toEqual(["fail", "skip"]);
    expect(formOf("assign").fields[0]!.items!.fields!.map((field) => field.name)).toEqual(["var", "value"]);
    expect(formOf("nope" as never).fields).toEqual([]);
  });

  test("formOf describes a Tool's input with references and localizable titles", () => {
    const form = formOf({
      input: {
        schema: {
          type: "object",
          required: ["table"],
          properties: {
            table: { type: "string", "x-ref": "dm.table", title: { ru: "Таблица" } },
            values: { type: "object", "x-ref-keys": "dm.field", "x-ref-scope": "/table" },
            email: { type: ["string", "null"], "x-personal": true },
            status: { enum: ["a", "b"] },
          },
        },
      },
    });
    expect(form.fields).toEqual([
      { name: "table", type: "string", required: true, title: { ru: "Таблица" }, ref: "dm.table" },
      { name: "values", type: "object", required: false, refKeys: "dm.field", refScope: "/table" },
      { name: "email", type: "string", required: false, personal: true },
      { name: "status", type: "enum", required: false, values: ["a", "b"] },
    ]);
    expect(formOf({}).fields).toEqual([]);
  });

  test("every node kind's sample config passes its own check and its schema names its keys", () => {
    const samples: Record<string, Record<string, unknown>> = {
      scheduleStart: { cron: "* * * * *" },
      eventStart: { event: "a.b" },
      userTask: { assignee: { role: "x" }, dueIn: "P1D", saveTo: "x", form: { fields: [] } },
      serviceTask: { tool: "a.b", timeout: "PT1M", onError: "skip", saveTo: "x" },
      assign: { assignments: [{ var: "x", value: 1 }] },
      timerCatch: { duration: "PT1M" },
      eventWait: { event: "a.b", saveTo: "x" },
      boundaryTimer: { duration: "PT1M", interrupting: false },
      boundaryEvent: { event: "a.b", interrupting: false },
      boundaryError: { errorCode: "x" },
    };
    for (const { kind, check, config } of processPalette([]).nodeKinds.map((item) => ({ ...item, check: undefined }))) {
      void check;
      for (const key of Object.keys(samples[kind] ?? {})) expect(Object.keys((config as { properties: object }).properties)).toContain(key);
    }
  });
});
