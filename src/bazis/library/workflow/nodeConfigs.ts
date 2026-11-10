import type { Expr } from "./expressions";
import type { FormSpec } from "./formFields";
import type { LocalizedText } from "./localized";
import type { NodeKind } from "./ProcessDocument";

/** Automatic retries of a failed Tool call. */
export interface RetryPolicy {
  /** 1–10. */
  readonly maxAttempts: number;
  /** The pause before a retry: an ISO duration. */
  readonly backoff?: string;
  readonly growth?: "fixed" | "exponential";
  /** For `exponential` growth: 1–100. */
  readonly factor?: number;
}

/** A timer: a duration from now, or a path to a moment in instance data. */
export type TimerConfig = { readonly duration: string; readonly at?: never } | { readonly at: string; readonly duration?: never };

/** Tool or process input: parameter → a literal, a path string (`$input.orderId`) or an expression. */
export type InputMapping = Readonly<Record<string, Expr>>;

/**
 * The `config` of a node by its kind: what `NODE_KINDS` checks at run time,
 * as types. `validateProcess` stays the judge of a stored document; these
 * types help to write one.
 */
export interface NodeConfigs {
  readonly manualStart: Readonly<Record<string, never>>;
  readonly scheduleStart: {
    /** Five fields: minute hour day month weekday. */
    readonly cron: string;
    /** An IANA time zone; UTC by default. */
    readonly timezone?: string;
    readonly from?: string;
    readonly until?: string;
    readonly overlap?: "skip" | "queue" | "parallel";
    readonly catchUp?: boolean;
    readonly partitions?: "none" | "all" | readonly string[];
  };
  readonly eventStart: {
    readonly event: string;
    readonly filter?: Expr;
    readonly debounce?: { readonly key: Expr; readonly window: string };
    readonly delay?: string;
    readonly ignoreOwn?: boolean;
  };
  readonly userTask: {
    readonly assignee: { readonly role: string; readonly user?: never } | { readonly user: string; readonly role?: never };
    readonly form?: FormSpec;
    readonly dueIn?: string;
    readonly saveTo?: string;
  };
  readonly serviceTask: {
    readonly tool: string;
    readonly input?: InputMapping;
    readonly saveTo?: string;
    readonly timeout?: string;
    readonly retry?: RetryPolicy;
    readonly onError?: "fail" | "skip";
  };
  readonly assign: {
    readonly assignments: readonly { readonly var: string; readonly value: Expr }[];
  };
  readonly loop: {
    readonly over?: Expr;
    readonly while?: Expr;
    readonly times?: number;
    readonly item?: string;
    readonly index?: string;
    readonly maxIterations: number;
    readonly parallel?: { readonly limit: number };
    readonly onItemError?: "stop" | "skip";
    readonly collect?: { readonly from: Expr; readonly to: string };
  };
  readonly callProcess: {
    readonly process: string;
    readonly input?: InputMapping;
    readonly saveTo?: string;
    readonly onError?: "fail" | "skip";
  };
  readonly timerCatch: TimerConfig;
  readonly eventWait: {
    readonly event: string;
    readonly correlation?: string;
    readonly saveTo?: string;
    readonly until?: Expr;
  };
  readonly exclusiveGateway: Readonly<Record<string, never>>;
  readonly parallelGateway: Readonly<Record<string, never>>;
  readonly boundaryError: { readonly errorCode?: string };
  readonly boundaryTimer: TimerConfig & { readonly interrupting?: boolean };
  readonly boundaryEvent: { readonly event: string; readonly correlation?: string; readonly interrupting?: boolean };
  readonly end: Readonly<Record<string, never>>;
}

/** The kinds whose `config` has required fields. */
export type ConfiguredNodeKind = "scheduleStart" | "eventStart" | "userTask" | "serviceTask" | "assign" | "loop" | "callProcess" | "timerCatch" | "eventWait" | "boundaryTimer" | "boundaryEvent";
/** The kinds attached to a step. */
export type BoundaryNodeKind = "boundaryError" | "boundaryTimer" | "boundaryEvent";

/**
 * A node of one kind with its own `config`. `Id` is what `attachedTo` and
 * `parent` may name: the ids of the nodes of the document. `Configs` lets the
 * owner of a document widen single configs (a Tool by reference in code).
 */
export type ProcessNodeOf<K extends NodeKind, Id extends string = string, Configs extends Record<NodeKind, object> = NodeConfigs> = {
  readonly kind: K;
  readonly title: LocalizedText;
  /** The `loop` whose body the node belongs to. */
  readonly parent?: Id;
  /** The application's data by namespace; the engine does not read it. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}
  & (K extends ConfiguredNodeKind ? { readonly config: Configs[K] } : { readonly config?: Configs[K] })
  & (K extends BoundaryNodeKind ? { /** The step the node is attached to. */ readonly attachedTo: Id } : { readonly attachedTo?: never });

/** A node of any kind, with the `config` its kind takes. */
export type TypedProcessNode<Id extends string = string, Configs extends Record<NodeKind, object> = NodeConfigs> = { [K in NodeKind]: ProcessNodeOf<K, Id, Configs> }[NodeKind];

/** A flow between two of the nodes named by `Id`. */
export interface TypedProcessFlow<Id extends string = string> {
  readonly source: Id;
  readonly target: Id;
  readonly title?: LocalizedText;
  /** Condition of a flow that leaves an exclusive gateway. */
  readonly condition?: Expr;
  /** The flow an exclusive gateway takes when no condition holds. */
  readonly isDefault?: boolean;
}
