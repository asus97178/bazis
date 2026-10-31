import type { Condition, NodeKind, ProcessDocument } from "./ProcessDocument";

/** Words Mermaid reads as syntax: such node ids are renamed. */
const RESERVED = new Set(["end", "graph", "flowchart", "subgraph", "style", "class", "classdef", "click", "default", "linkstyle", "direction"]);

const SHAPES: Record<NodeKind, readonly [open: string, close: string]> = {
  manualStart: ["([", "])"],
  scheduleStart: ["([", "])"],
  eventStart: ["([", "])"],
  end: ["((", "))"],
  userTask: ["[", "]"],
  serviceTask: ["[[", "]]"],
  timerCatch: ["{{", "}}"],
  eventWait: ["{{", "}}"],
  exclusiveGateway: ["{", "}"],
  parallelGateway: ["{", "}"],
  boundaryError: ["((", "))"],
  boundaryTimer: ["((", "))"],
  boundaryEvent: ["((", "))"],
};

/**
 * A process as a Mermaid `flowchart` (WORKFLOW-001 §14): starts are stadiums,
 * Tool steps subroutines, tasks rectangles, waits hexagons, gateways rhombi,
 * ends and boundary events circles. A boundary event hangs on its step by a
 * dotted link. Labels show the node kind's detail: the Tool, the cron, the
 * duration, the event key; flows show their title or condition.
 */
export function processToMermaid(document: ProcessDocument, direction: "LR" | "TB" = "LR"): string {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const idOf = (nodeId: string): string => {
    const known = ids.get(nodeId);
    if (known !== undefined) return known;
    let id = /^[A-Za-z][A-Za-z0-9_]*$/.test(nodeId) && !RESERVED.has(nodeId.toLowerCase()) ? nodeId : `n_${nodeId.replace(/[^A-Za-z0-9_]/g, "_")}`;
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    ids.set(nodeId, id);
    return id;
  };
  const lines = [`flowchart ${direction}`];
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    const [open, close] = SHAPES[node.kind] ?? ["[", "]"];
    const detail = detailOf(node.kind, node.config ?? {});
    lines.push(`  ${idOf(nodeId)}${open}"${label(node.title || nodeId)}${detail === undefined ? "" : `<br/><small>${label(detail)}</small>`}"${close}`);
  }
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.attachedTo !== undefined && document.nodes[node.attachedTo] !== undefined) lines.push(`  ${idOf(node.attachedTo)} -.- ${idOf(nodeId)}`);
  }
  for (const flow of Object.values(document.flows)) {
    if (document.nodes[flow.source] === undefined || document.nodes[flow.target] === undefined) continue;
    const text = flow.title ?? (flow.condition !== undefined ? conditionText(flow.condition) : flow.isDefault === true ? "default" : undefined);
    lines.push(`  ${idOf(flow.source)} -->${text === undefined ? "" : `|"${label(text)}"|`} ${idOf(flow.target)}`);
  }
  return `${lines.join("\n")}\n`;
}

function detailOf(kind: NodeKind, config: Readonly<Record<string, unknown>>): string | undefined {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  switch (kind) {
    case "serviceTask": return text(config.tool);
    case "scheduleStart": return text(config.cron);
    case "eventStart":
    case "eventWait":
    case "boundaryEvent": return text(config.event);
    case "timerCatch":
    case "boundaryTimer": return text(config.duration) ?? (text(config.at) === undefined ? undefined : `at ${config.at}`);
    case "boundaryError": return text(config.errorCode);
    case "userTask": {
      const assignee = config.assignee as { role?: unknown; user?: unknown } | undefined;
      return assignee === undefined ? undefined : text(assignee.role) !== undefined ? `role ${assignee.role}` : text(assignee.user) === undefined ? undefined : `user ${assignee.user}`;
    }
    default: return undefined;
  }
}

function conditionText(condition: Condition): string {
  if ("all" in condition) return condition.all.map(conditionText).join(" and ");
  if ("any" in condition) return condition.any.map(conditionText).join(" or ");
  if ("not" in condition) return `not (${conditionText(condition.not)})`;
  return condition.op === "empty" || condition.op === "notEmpty" ? `${condition.path} ${condition.op}` : `${condition.path} ${condition.op} ${JSON.stringify(condition.value)}`;
}

/** Text inside a quoted Mermaid label: quotes and markup are entities. */
function label(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
