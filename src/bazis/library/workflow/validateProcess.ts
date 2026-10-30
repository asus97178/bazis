import { checkFormSpec, formFieldCodes, type FormSpec } from "./formFields";
import { nodeKindOf, type NodeRole } from "./nodeKinds";
import { DATA_PATH } from "./paths";
import { PROCESS_SCHEMA_VERSION, type ConditionOp } from "./ProcessDocument";

/**
 * One finding of {@link validateProcess}. An `error` blocks publishing, a
 * `warning` is a hint for a designer (a node without a shape). `node` / `flow`
 * name what to highlight.
 */
export interface ProcessIssue {
  readonly severity: "error" | "warning";
  readonly code: ProcessIssueCode;
  readonly message: string;
  readonly node?: string;
  readonly flow?: string;
}

export type ProcessIssueCode =
  | "schema"
  | "too_large"
  | "input_invalid"
  | "id_invalid"
  | "unknown_kind"
  | "title_invalid"
  | "config_invalid"
  | "unknown_tool"
  | "flow_dangling"
  | "flow_self"
  | "flow_duplicate"
  | "no_start"
  | "no_end"
  | "start_incoming"
  | "start_outgoing"
  | "end_outgoing"
  | "end_incoming"
  | "activity_incoming"
  | "activity_outgoing"
  | "gateway_flows"
  | "boundary_attach"
  | "boundary_incoming"
  | "boundary_outgoing"
  | "condition_missing"
  | "condition_invalid"
  | "condition_not_allowed"
  | "default_invalid"
  | "unreachable"
  | "dead_end"
  | "diagram_missing"
  | "diagram_orphan";

export const PROCESS_LIMITS = Object.freeze({ nodes: 500, flows: 1000, bytes: 1_000_000, conditionDepth: 8 });

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const OPS = new Set<ConditionOp>(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "empty", "notEmpty"]);
const UNARY = new Set<ConditionOp>(["empty", "notEmpty"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

export interface ValidateProcessOptions {
  /**
   * Whether a Tool may be a service task step: exists and lists `workflow` in its
   * `callers`. Without it Tool names are only checked for their form.
   */
  readonly tools?: (name: string) => boolean;
}

/**
 * Checks a whole process document: the JSON shape, node configs and the graph.
 * Never throws and returns every finding: a draft is kept with errors, while
 * publishing needs no `error` among them.
 */
export function validateProcess(document: unknown, options: ValidateProcessOptions = {}): ProcessIssue[] {
  const out: ProcessIssue[] = [];
  const error = (code: ProcessIssueCode, message: string, at: { node?: string; flow?: string } = {}) => out.push({ severity: "error", code, message, ...at });
  const warning = (code: ProcessIssueCode, message: string, at: { node?: string; flow?: string } = {}) => out.push({ severity: "warning", code, message, ...at });

  if (!isObject(document)) return [{ severity: "error", code: "schema", message: "document must be an object" }];
  if (JSON.stringify(document).length > PROCESS_LIMITS.bytes) return [{ severity: "error", code: "too_large", message: `document is larger than ${PROCESS_LIMITS.bytes} bytes` }];
  if (document.schemaVersion !== PROCESS_SCHEMA_VERSION) error("schema", `schemaVersion must be ${PROCESS_SCHEMA_VERSION}`);
  if (!isObject(document.nodes)) error("schema", "nodes must be an object");
  if (!isObject(document.flows)) error("schema", "flows must be an object");
  if (document.diagram !== undefined && !isDiagram(document.diagram)) error("schema", "diagram must have shapes and edges objects with numeric coordinates");
  if (out.length > 0) return out;
  if (document.input !== undefined) {
    const problem = checkFormSpec(document.input, "input");
    if (problem) error("input_invalid", problem);
  }

  const nodes = document.nodes as Json;
  const flows = document.flows as Json;
  if (Object.keys(nodes).length > PROCESS_LIMITS.nodes) return [{ severity: "error", code: "too_large", message: `more than ${PROCESS_LIMITS.nodes} nodes` }];
  if (Object.keys(flows).length > PROCESS_LIMITS.flows) return [{ severity: "error", code: "too_large", message: `more than ${PROCESS_LIMITS.flows} flows` }];

  // Nodes: id, kind, title, config.
  const roles = new Map<string, NodeRole>();
  const kinds = new Map<string, string>();
  const attached = new Map<string, string>();
  for (const [id, raw] of Object.entries(nodes)) {
    if (!ID.test(id)) error("id_invalid", `node id ${JSON.stringify(id)} is invalid`, { node: id });
    if (!isObject(raw)) {
      error("schema", "node must be an object", { node: id });
      continue;
    }
    const definition = nodeKindOf(raw.kind);
    if (!definition) {
      error("unknown_kind", `unknown node kind ${JSON.stringify(raw.kind)}`, { node: id });
      continue;
    }
    roles.set(id, definition.role);
    kinds.set(id, definition.kind);
    if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > 200) error("title_invalid", "title must be 1–200 characters", { node: id });
    if (raw.config !== undefined && !isObject(raw.config)) {
      error("config_invalid", "config must be an object", { node: id });
    } else {
      const config = (raw.config as Json | undefined) ?? {};
      const problem = definition.check(config);
      if (problem) error("config_invalid", problem, { node: id });
      else if (definition.kind === "serviceTask" && options.tools && !options.tools(config.tool as string)) {
        error("unknown_tool", `Tool ${JSON.stringify(config.tool)} does not exist or does not list "workflow" in its callers`, { node: id });
      }
    }
    if (definition.role === "boundary") {
      if (typeof raw.attachedTo === "string") attached.set(id, raw.attachedTo);
      else error("boundary_attach", "boundary node needs attachedTo", { node: id });
    } else if (raw.attachedTo !== undefined) {
      error("boundary_attach", "only boundary nodes can be attached", { node: id });
    }
  }
  for (const [id, host] of attached) {
    if (roles.get(host) !== "activity") error("boundary_attach", `attachedTo ${JSON.stringify(host)} is not a step`, { node: id });
    else if (kinds.get(id) === "boundaryError" && kinds.get(host) !== "serviceTask") error("boundary_attach", "error boundary attaches only to a service task", { node: id });
  }

  // What conditions may read: declared input fields and existing nodes.
  const inputSpec = document.input !== undefined && checkFormSpec(document.input, "input") === null ? document.input as FormSpec : undefined;
  const scope: ConditionScope = { input: inputSpec === undefined ? null : new Set(formFieldCodes(inputSpec)), nodes: roles };

  // Flows: ends, duplicates, conditions.
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const pairs = new Set<string>();
  for (const [id, raw] of Object.entries(flows)) {
    if (!ID.test(id)) error("id_invalid", `flow id ${JSON.stringify(id)} is invalid`, { flow: id });
    if (Object.hasOwn(nodes, id)) error("id_invalid", "flow id clashes with a node id", { flow: id });
    if (!isObject(raw)) {
      error("schema", "flow must be an object", { flow: id });
      continue;
    }
    const { source, target } = raw;
    if (typeof source !== "string" || typeof target !== "string" || !roles.has(source) || !roles.has(target)) {
      if (typeof source !== "string" || typeof target !== "string" || !Object.hasOwn(nodes, source) || !Object.hasOwn(nodes, target)) {
        error("flow_dangling", "source and target must be existing nodes", { flow: id });
      }
      continue;
    }
    if (source === target) error("flow_self", "flow connects a node to itself", { flow: id });
    const pair = `${source}\u0000${target}`;
    if (pairs.has(pair)) error("flow_duplicate", "another flow already connects these nodes", { flow: id });
    pairs.add(pair);
    outgoing.set(source, [...outgoing.get(source) ?? [], id]);
    incoming.set(target, [...incoming.get(target) ?? [], id]);
    if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 200)) error("title_invalid", "flow title must be up to 200 characters", { flow: id });
    if (raw.isDefault !== undefined && typeof raw.isDefault !== "boolean") error("default_invalid", "isDefault must be a boolean", { flow: id });
    const fromChoice = kinds.get(source) === "exclusiveGateway";
    if (raw.condition !== undefined) {
      if (!fromChoice) error("condition_not_allowed", "only flows leaving an exclusive gateway have conditions", { flow: id });
      else {
        const problem = checkCondition(raw.condition, 0, scope);
        if (problem) error("condition_invalid", problem, { flow: id });
      }
    }
    if (raw.isDefault === true && !fromChoice) error("default_invalid", "only flows leaving an exclusive gateway can be default", { flow: id });
  }

  // Rules by node role.
  const starts = [...roles].filter(([, role]) => role === "start").map(([id]) => id);
  if (starts.length === 0) error("no_start", "process needs a start node");
  if (![...roles.values()].includes("end")) error("no_end", "process needs an end node");
  for (const [id, role] of roles) {
    const ins = incoming.get(id)?.length ?? 0;
    const outs = outgoing.get(id) ?? [];
    switch (role) {
      case "start":
        if (ins > 0) error("start_incoming", "start node cannot have incoming flows", { node: id });
        if (outs.length !== 1) error("start_outgoing", "start node needs exactly one outgoing flow", { node: id });
        break;
      case "end":
        if (outs.length > 0) error("end_outgoing", "end node cannot have outgoing flows", { node: id });
        if (ins === 0) error("end_incoming", "end node needs an incoming flow", { node: id });
        break;
      case "activity":
        if (ins === 0) error("activity_incoming", "step needs an incoming flow", { node: id });
        if (outs.length !== 1) error("activity_outgoing", "step needs exactly one outgoing flow; branch with a gateway", { node: id });
        break;
      case "boundary":
        if (ins > 0) error("boundary_incoming", "boundary node cannot have incoming flows", { node: id });
        if (outs.length !== 1) error("boundary_outgoing", "boundary node needs exactly one outgoing flow", { node: id });
        break;
      case "gateway":
        if (ins === 0 || outs.length === 0 || (ins < 2 && outs.length < 2)) {
          error("gateway_flows", "gateway needs incoming and outgoing flows and must split or join", { node: id });
        }
        if (kinds.get(id) === "exclusiveGateway" && outs.length > 1) checkChoice(id, outs, flows, error);
        break;
    }
  }

  // Reachability: forward from starts and back from ends. A boundary node is reached through its step.
  const forward = new Map<string, string[]>();
  for (const [id, list] of outgoing) forward.set(id, list.map((flow) => (flows[flow] as Json).target as string));
  for (const [boundary, host] of attached) if (roles.has(host)) forward.set(host, [...forward.get(host) ?? [], boundary]);
  const backward = new Map<string, string[]>();
  for (const [from, list] of forward) for (const to of list) backward.set(to, [...backward.get(to) ?? [], from]);
  const reached = walk(starts, forward);
  const ending = walk([...roles].filter(([, role]) => role === "end").map(([id]) => id), backward);
  for (const id of roles.keys()) {
    if (starts.length > 0 && !reached.has(id)) error("unreachable", "node cannot be reached from any start", { node: id });
    else if (!ending.has(id) && roles.get(id) !== "end") error("dead_end", "no end can be reached from this node", { node: id });
  }

  // Layout: hints only.
  const diagram = document.diagram as { shapes: Json; edges: Json } | undefined;
  if (diagram) {
    for (const id of Object.keys(nodes)) if (!Object.hasOwn(diagram.shapes, id)) warning("diagram_missing", "node has no shape on the canvas", { node: id });
    for (const id of Object.keys(diagram.shapes)) if (!Object.hasOwn(nodes, id)) warning("diagram_orphan", "shape without a node", { node: id });
    for (const id of Object.keys(diagram.edges)) if (!Object.hasOwn(flows, id)) warning("diagram_orphan", "edge without a flow", { flow: id });
  }
  return out;
}

/** An exclusive gateway: every outgoing flow has a condition, except at most one default flow. */
function checkChoice(id: string, outs: readonly string[], flows: Json, error: (code: ProcessIssueCode, message: string, at?: { node?: string; flow?: string }) => void): void {
  const defaults = outs.filter((flow) => (flows[flow] as Json).isDefault === true);
  if (defaults.length > 1) error("default_invalid", "exclusive gateway can have only one default flow", { node: id });
  for (const flow of outs) {
    const raw = flows[flow] as Json;
    if (raw.isDefault === true) {
      if (raw.condition !== undefined) error("default_invalid", "default flow cannot have a condition", { flow });
    } else if (raw.condition === undefined) {
      error("condition_missing", "flow leaving an exclusive gateway needs a condition or isDefault", { flow });
    }
  }
}

interface ConditionScope {
  /** Input field codes; `null` when no input is declared and `$input` is not checked. */
  readonly input: ReadonlySet<string> | null;
  readonly nodes: ReadonlyMap<string, unknown>;
}

function checkCondition(condition: unknown, depth: number, scope: ConditionScope): string | null {
  if (depth > PROCESS_LIMITS.conditionDepth) return `condition is nested deeper than ${PROCESS_LIMITS.conditionDepth}`;
  if (!isObject(condition)) return "condition must be an object";
  const keys = Object.keys(condition);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const list = condition[keys[0]];
    if (!Array.isArray(list) || list.length === 0) return `${keys[0]} must be a non-empty list`;
    for (const item of list) {
      const problem = checkCondition(item, depth + 1, scope);
      if (problem) return problem;
    }
    return null;
  }
  if (keys.length === 1 && keys[0] === "not") return checkCondition(condition.not, depth + 1, scope);
  if (typeof condition.path !== "string" || !DATA_PATH.test(condition.path)) return "condition.path must look like $input.field, $vars.name or $nodes.Node.field";
  const [root, first] = condition.path.split(".");
  if (root === "$input" && scope.input && !scope.input.has(first!)) return `condition.path ${condition.path}: input has no field ${first}`;
  if (root === "$nodes" && !scope.nodes.has(first!)) return `condition.path ${condition.path}: no node ${first}`;
  if (typeof condition.op !== "string" || !OPS.has(condition.op as ConditionOp)) return `condition.op must be one of ${[...OPS].join(", ")}`;
  const op = condition.op as ConditionOp;
  if (keys.some((key) => key !== "path" && key !== "op" && key !== "value")) return "condition has unknown keys";
  if (UNARY.has(op)) return condition.value === undefined ? null : `${op} takes no value`;
  if (condition.value === undefined) return `${op} needs a value`;
  if (op === "in" && !Array.isArray(condition.value)) return "in needs a list value";
  return null;
}

function isDiagram(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.shapes) || !isObject(value.edges)) return false;
  const shapesOk = Object.values(value.shapes).every((shape) => isObject(shape) && finite(shape.x) && finite(shape.y) && finite(shape.width) && finite(shape.height));
  const edgesOk = Object.values(value.edges).every((edge) => isObject(edge) && Array.isArray(edge.waypoints) && edge.waypoints.every((point) => isObject(point) && finite(point.x) && finite(point.y)));
  return shapesOk && edgesOk;
}

function walk(from: readonly string[], next: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set(from);
  const queue = [...from];
  while (queue.length > 0) {
    for (const to of next.get(queue.pop()!) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

/** `true` if the findings block publishing. */
export function hasErrors(issues: readonly ProcessIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
