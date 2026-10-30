import type { FormSpec } from "./formFields";

/**
 * A process document: the framework's own JSON, not BPMN XML (a designer may
 * render BPMN from it). One object holds the process input (`input`), the graph
 * (`nodes`, `flows`) and the canvas layout (`diagram`).
 */
export const PROCESS_SCHEMA_VERSION = "bazis.workflow/v1";

/** The node kinds of version 1; closed: a new kind comes with a new document version. */
export type NodeKind =
  | "manualStart"
  | "scheduleStart"
  | "eventStart"
  | "userTask"
  | "serviceTask"
  | "timerCatch"
  | "eventWait"
  | "exclusiveGateway"
  | "parallelGateway"
  | "boundaryError"
  | "boundaryTimer"
  | "boundaryEvent"
  | "end";

export interface ProcessNode {
  readonly kind: NodeKind;
  readonly title: string;
  /** Boundary nodes only: the step the node is attached to. */
  readonly attachedTo?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ProcessFlow {
  readonly source: string;
  readonly target: string;
  readonly title?: string;
  /** Condition of a flow that leaves an exclusive gateway. */
  readonly condition?: Condition;
  /** The flow an exclusive gateway takes when no condition holds. */
  readonly isDefault?: boolean;
}

/** Comparison operators of conditions. */
export type ConditionOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "empty" | "notEmpty";

/**
 * A condition: a tree of `all` / `any` / `not` and comparisons. `path` addresses
 * instance data: `$input.<field>`, `$vars.<name>`, `$nodes.<node>.<field>`.
 */
export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly path: string; readonly op: ConditionOp; readonly value?: unknown };

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Canvas layout: stored and returned, never read by the engine. */
export interface ProcessDiagram {
  readonly shapes: Readonly<Record<string, Bounds>>;
  readonly edges: Readonly<Record<string, { readonly waypoints: readonly Point[] }>>;
}

export interface ProcessDocument {
  readonly schemaVersion: typeof PROCESS_SCHEMA_VERSION;
  /** Fields the process starts with; without them it starts with no data. */
  readonly input?: FormSpec;
  readonly nodes: Readonly<Record<string, ProcessNode>>;
  readonly flows: Readonly<Record<string, ProcessFlow>>;
  readonly diagram?: ProcessDiagram;
}

/** A new process: a manual start leading straight to the end. It already passes validation. */
export function emptyProcess(): ProcessDocument {
  return {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    nodes: {
      Start: { kind: "manualStart", title: "Start" },
      End: { kind: "end", title: "End" },
    },
    flows: { StartToEnd: { source: "Start", target: "End" } },
  };
}
