import type { Expr } from "./expressions";
import type { VariableSpec } from "./formFields";
import type { LocalizedText } from "./localized";

/**
 * A process document: the framework's own JSON, not BPMN XML (a designer may
 * render BPMN from it). One object holds the variables, the settings, the graph
 * (`nodes`, `flows`), the canvas layout (`diagram`) and the application's data
 * (`extensions`).
 */
export const PROCESS_SCHEMA_VERSION = "bazis.workflow/v2";

/** The node kinds of version 2; closed: a new kind comes with a new document version. */
export type NodeKind =
  | "manualStart"
  | "scheduleStart"
  | "eventStart"
  | "userTask"
  | "serviceTask"
  | "assign"
  | "loop"
  | "callProcess"
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
  readonly title: LocalizedText;
  /** Boundary nodes only: the step the node is attached to. */
  readonly attachedTo?: string;
  /** The `loop` whose body the node belongs to. */
  readonly parent?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  /** The application's data by namespace; the engine does not read it. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ProcessFlow {
  readonly source: string;
  readonly target: string;
  readonly title?: LocalizedText;
  /** Condition of a flow that leaves an exclusive gateway. */
  readonly condition?: Expr;
  /** The flow an exclusive gateway takes when no condition holds. */
  readonly isDefault?: boolean;
}

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

/** What goes to the history of an instance. */
export interface ProcessLogSettings {
  /** The values of variables an `assign` step sets; `false` by default. */
  readonly variables?: boolean;
  /** The input and output of Tools; `false` by default. */
  readonly toolPayloads?: boolean;
  /** Personal data shows as `***`; `true` by default. */
  readonly maskPersonal?: boolean;
}

/** Settings of a process: they are part of the version. */
export interface ProcessSettings {
  /** On whose behalf steps run: who started the instance (the default) or the process's own system actor. */
  readonly runAs?: "starter" | "process";
  /** How long the whole run may take, waits included: an ISO duration. */
  readonly runTimeout?: string;
  /** The default `timeout` of steps with a Tool: an ISO duration. */
  readonly stepTimeout?: string;
  /** How many instances of the process run at once; the rest wait as `pending`. */
  readonly maxConcurrent?: number;
  /** A new start with the `businessKey` of an unfinished instance: run as well, do not start, or wait for it. */
  readonly sameKey?: "allow" | "skip" | "queue";
  /** The key of the process to start when an instance fails or times out. */
  readonly errorHandler?: string;
  readonly log?: ProcessLogSettings;
}

export interface ProcessDocument {
  readonly schemaVersion: typeof PROCESS_SCHEMA_VERSION;
  /** `in` — the input of a start, `local` — inside the process, `out` — what it gives back. */
  readonly variables?: readonly VariableSpec[];
  readonly settings?: ProcessSettings;
  readonly nodes: Readonly<Record<string, ProcessNode>>;
  readonly flows: Readonly<Record<string, ProcessFlow>>;
  readonly diagram?: ProcessDiagram;
  /** The application's data by namespace; the engine does not read it. */
  readonly extensions?: Readonly<Record<string, unknown>>;
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

/** The fields a start takes: the `in` variables. */
export function inputSpecOf(document: Pick<ProcessDocument, "variables">): { readonly fields: readonly VariableSpec[] } {
  return { fields: (document.variables ?? []).filter((variable) => variable.direction === "in") };
}

/** What `$vars` holds at the start: the `local` and `out` variables with a default. */
export function initialVarsOf(document: Pick<ProcessDocument, "variables">): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const variable of document.variables ?? []) {
    if (variable.direction !== "in" && variable.default !== undefined) vars[variable.name] = variable.default;
  }
  return vars;
}

/** What a finished process gives back: its `out` variables. */
export function outputOf(document: Pick<ProcessDocument, "variables">, vars: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const variable of document.variables ?? []) {
    if (variable.direction === "out") output[variable.name] = Object.hasOwn(vars, variable.name) ? vars[variable.name] : null;
  }
  return output;
}
