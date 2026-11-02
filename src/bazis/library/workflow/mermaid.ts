import type { Expr } from "./expressions";
import { printExpression } from "./expressionSyntax";
import { textOf } from "./localized";
import type { NodeKind, ProcessDocument } from "./ProcessDocument";

/** Words Mermaid reads as syntax: such node ids are renamed. */
const RESERVED = new Set(["end", "graph", "flowchart", "subgraph", "style", "class", "classdef", "click", "default", "linkstyle", "direction"]);

const SHAPES: Record<NodeKind, readonly [open: string, close: string]> = {
  manualStart: ["([", "])"],
  scheduleStart: ["([", "])"],
  eventStart: ["([", "])"],
  end: ["((", "))"],
  userTask: ["[", "]"],
  serviceTask: ["[[", "]]"],
  callProcess: ["[[", "]]"],
  loop: ["[", "]"],
  assign: ["[/", "/]"],
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
 * Tool steps and called processes subroutines, a loop a subgraph around its body, tasks rectangles, waits hexagons, gateways rhombi,
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
  // A loop is a subgraph around its body; flows and boundaries link to it by its id.
  const write = (parent: string | undefined, indent: string): void => {
    for (const [nodeId, node] of Object.entries(document.nodes)) {
      if (node.parent !== parent) continue;
      const detail = detailOf(node.kind, node.config ?? {});
      const text = `${label(textOf(node.title, "en") || nodeId)}${detail === undefined ? "" : `<br/><small>${label(detail)}</small>`}`;
      if (node.kind === "loop") {
        lines.push(`${indent}subgraph ${idOf(nodeId)}["${text}"]`);
        write(nodeId, `${indent}  `);
        lines.push(`${indent}end`);
        continue;
      }
      const [open, close] = SHAPES[node.kind] ?? ["[", "]"];
      lines.push(`${indent}${idOf(nodeId)}${open}"${text}"${close}`);
    }
  };
  write(undefined, "  ");
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.attachedTo !== undefined && document.nodes[node.attachedTo] !== undefined) lines.push(`  ${idOf(node.attachedTo)} -.- ${idOf(nodeId)}`);
  }
  for (const flow of Object.values(document.flows)) {
    if (document.nodes[flow.source] === undefined || document.nodes[flow.target] === undefined) continue;
    const text = flow.title !== undefined ? textOf(flow.title, "en") : flow.condition !== undefined ? expressionText(flow.condition) : flow.isDefault === true ? "default" : undefined;
    lines.push(`  ${idOf(flow.source)} -->${text === undefined ? "" : `|"${label(text)}"|`} ${idOf(flow.target)}`);
  }
  return `${lines.join("\n")}\n`;
}

function detailOf(kind: NodeKind, config: Readonly<Record<string, unknown>>): string | undefined {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  switch (kind) {
    case "serviceTask": return text(config.tool);
    case "callProcess": return text(config.process);
    case "loop": return typeof config.times === "number" ? `${config.times} times` : config.while !== undefined ? "while" : "for each";
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
    case "assign": {
      const list = config.assignments;
      return Array.isArray(list) ? list.map((item: { var?: unknown }) => String(item.var)).join(", ") : undefined;
    }
    default: return undefined;
  }
}

/** A condition in the designer's syntax; one that does not print shows as JSON. */
function expressionText(expression: Expr): string {
  try {
    return printExpression(expression);
  } catch {
    return JSON.stringify(expression);
  }
}

/** Text inside a quoted Mermaid label: quotes and markup are entities. */
function label(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
