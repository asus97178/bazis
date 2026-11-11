import { toolNameOf, type DefinedTool } from "../../../agent";
import type {
  Expr,
  LocalizedText,
  NodeConfigs,
  NodeKind,
  ProcessDiagram,
  ProcessDocument,
  ProcessFlow,
  ProcessNode,
  ProcessNodeOf,
  ProcessSettings,
  TypedProcessFlow,
  TypedProcessNode,
  VariableSpec,
} from "../../../../library/workflow";

const CODE_PROCESS = Symbol.for("bazis/core/workflow/code-process");
declare const PROCESS_TYPES: unique symbol;

/** A class with `@Tool`: a process names it instead of writing its name. */
export type ToolClass = abstract new (...args: never[]) => { execute(...args: never[]): unknown };
/** A Tool of a step: by reference (a class with `@Tool`, a Tool made by `defineTool`), or by name. */
export type ToolRef = string | ToolClass | DefinedTool;
/** A process another one calls or hands its failures to: by reference, or by key. */
export type ProcessRef = string | CodeProcess;

/** The node configs a process in code may write: a Tool and a process by reference. */
export interface CodeNodeConfigs extends Omit<NodeConfigs, "serviceTask" | "callProcess"> {
  readonly serviceTask: Omit<NodeConfigs["serviceTask"], "tool"> & { readonly tool: ToolRef };
  readonly callProcess: Omit<NodeConfigs["callProcess"], "process"> & { readonly process: ProcessRef };
}

/** A node as code writes it: the `config` of its kind, the ids of the document's own nodes. */
export type CodeProcessNode<Id extends string = string> = TypedProcessNode<Id, CodeNodeConfigs>;

/** The settings of a process in code: the error handler by reference. */
export interface CodeProcessSettings extends Omit<ProcessSettings, "errorHandler"> {
  /** The process to start when an instance fails or times out. */
  readonly errorHandler?: ProcessRef;
}

type FieldValue<F> =
  F extends { readonly type: "enum"; readonly values: readonly (infer Value)[] } ? Value
  : F extends { readonly type: "string" | "text" | "date" | "datetime" | "ref" | "enum" } ? string
  : F extends { readonly type: "number" | "integer" } ? number
  : F extends { readonly type: "boolean" } ? boolean
  : F extends { readonly type: "list" } ? readonly unknown[]
  : F extends { readonly type: "object" } ? Readonly<Record<string, unknown>>
  : unknown;

type Flat<T> = { readonly [K in keyof T]: T[K] };

/** What a start of the process takes: its `in` variables; the `required` ones must be there. */
export type ProcessInput<V extends readonly VariableSpec[]> = string extends V[number]["name"]
  ? Readonly<Record<string, unknown>>
  : Flat<
    & { [F in V[number] as F extends { readonly direction: "in"; readonly required: true } ? F["name"] : never]: FieldValue<F> }
    & { [F in V[number] as F extends { readonly direction: "in" } ? (F extends { readonly required: true } ? never : F["name"]) : never]?: FieldValue<F> }
  >;

/** What a finished process gives back: its `out` variables. */
export type ProcessOutput<V extends readonly VariableSpec[]> = string extends V[number]["name"]
  ? Readonly<Record<string, unknown>>
  : Flat<{ [F in V[number] as F extends { readonly direction: "out" } ? F["name"] : never]: FieldValue<F> | null }>;

/** What a Tool takes: the parameter of its `execute`. `unknown` when it does not say. */
type ToolInputOf<T> =
  T extends DefinedTool<infer Input, unknown> ? Input
  : T extends abstract new (...args: never[]) => { execute(input: infer Input, ...rest: never[]): unknown } ? Input
  : unknown;

/** `config.input` of a step against what its Tool or process takes: every required parameter, no unknown one. */
type InputOf<Target, Given> = unknown extends Target ? unknown
  : Target extends object
    ? string extends keyof Target ? unknown
      : { readonly config: ({} extends Target ? { readonly input?: MappingOf<Target, Given> } : { readonly input: MappingOf<Target, Given> }) }
    : unknown;

type MappingOf<Target, Given> = { readonly [P in keyof Target]: Expr } & { readonly [P in Exclude<keyof Given, keyof Target>]?: never };

type CheckedInput<Node> =
  Node extends { readonly kind: "serviceTask"; readonly config: { readonly tool: infer Tool; readonly input?: infer Given } } ? InputOf<ToolInputOf<Tool>, Given>
  : Node extends { readonly kind: "callProcess"; readonly config: { readonly process: infer Called; readonly input?: infer Given } }
    ? (Called extends CodeProcess<infer Input, unknown> ? InputOf<Input, Given> : unknown)
    : unknown;

/** The nodes of a document, as `defineProcess` reads their type. */
export type CodeProcessNodes = Readonly<Record<string, ProcessNode | CodeProcessNode>>;

type KeysOf<T> = T extends unknown ? keyof T : never;
type ValueOf<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
/** Whether a value of this type is not a closed object: a primitive, a list of anything, a map by any key. */
type IsOpen<T> = T extends unknown ? (T extends readonly unknown[] ? false : T extends object ? (string extends keyof T ? true : false) : true) : never;

/**
 * `Given` with every key the allowed type does not know turned into `never`:
 * a misspelled optional field is an error, not a field nobody reads.
 */
type Exact<Given, Allowed> =
  true extends IsOpen<NonNullable<Allowed>> ? unknown
  : Given extends readonly (infer Item)[] ? (NonNullable<Allowed> extends readonly (infer AllowedItem)[] ? readonly Exact<Item, AllowedItem>[] : unknown)
  : Given extends object ? { readonly [P in keyof Given]: P extends KeysOf<NonNullable<Allowed>> ? Exact<Given[P], ValueOf<NonNullable<Allowed>, P>> : never }
  : unknown;

type ExactNode<Node, Id extends string> = Node extends { readonly kind: infer Kind extends NodeKind } ? Exact<Node, ProcessNodeOf<Kind, Id, CodeNodeConfigs>> : unknown;

/** What the nodes written as a literal must also be: of their kind, with known fields, with the input their Tool takes. */
type CheckedNodes<N> = string extends keyof N ? unknown : { readonly [Id in keyof N]: CodeProcessNode<keyof N & string> & CheckedInput<N[Id]> & ExactNode<N[Id], keyof N & string> };

/**
 * The document of a process in code. Written as a literal, it is checked while
 * you type: the `config` of each node kind, the nodes that flows, `attachedTo`
 * and `parent` name, the input of a Tool or a called process given by
 * reference. A document that already exists as data (exported from a designer,
 * built by a function, upgraded from version 1) is taken as it is.
 */
export interface CodeProcessDocument<V extends readonly VariableSpec[], N extends CodeProcessNodes> {
  readonly schemaVersion: ProcessDocument["schemaVersion"];
  /** `in` — the input of a start, `local` — inside the process, `out` — what it gives back. */
  readonly variables?: V;
  readonly settings?: CodeProcessSettings;
  readonly nodes: N & CheckedNodes<N>;
  readonly flows: Readonly<Record<string, string extends keyof N ? ProcessFlow : TypedProcessFlow<keyof N & string>>>;
  readonly diagram?: ProcessDiagram;
  /** The application's data by namespace; the engine does not read it. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** What `defineProcess` takes: the catalog fields of the process and its document. */
export interface ProcessDefinition<V extends readonly VariableSpec[] = readonly VariableSpec[], N extends CodeProcessNodes = CodeProcessNodes> {
  /** The key it is started by: `^[a-z][a-z0-9_.-]{0,63}$`. */
  readonly key: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText | null;
  /** A path in the catalog: `Sales/Orders`. */
  readonly folder?: string | null;
  /** Whose process it is: an opaque id. */
  readonly owner?: string | null;
  /** Days to keep completed and cancelled instances; omitted keeps them. */
  readonly retentionDays?: number | null;
  readonly document: CodeProcessDocument<V, N>;
}

/**
 * A process described in code: listed in `@Module({ processes })` and published
 * at start (WORKFLOW-001 §14). `Input` and `Output` come from its variables:
 * `runtime.start(process, { input })` and a `callProcess` step are checked by them.
 * Plain `CodeProcess` is any process.
 */
export interface CodeProcess<Input = never, Output = unknown> {
  readonly key: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText | null;
  readonly folder?: string | null;
  readonly owner?: string | null;
  readonly retentionDays?: number | null;
  /** The document as it is stored: Tools by name, processes by key. */
  readonly document: ProcessDocument;
  readonly [CODE_PROCESS]: true;
  /** Only for the types. */
  readonly [PROCESS_TYPES]?: { readonly input: (input: Input) => void; readonly output: Output };
}

/**
 * Describes a process in the code of the module that owns it. It is only a
 * description: checks happen when the container is built and at start.
 *
 * ```ts
 * // order/process/OrderApproval.process.ts
 * export const orderApproval = defineProcess({
 *   key: "order-approval",
 *   title: "Order approval",
 *   document: {
 *     schemaVersion: "bazis.workflow/v2",
 *     variables: [{ name: "orderId", type: "string", direction: "in", required: true }],
 *     nodes: {
 *       Start: { kind: "manualStart", title: "Start" },
 *       Approve: { kind: "serviceTask", title: "Approve", config: { tool: SetOrderStatusTool, input: { orderId: "$input.orderId", status: "approved" } } },
 *       End: { kind: "end", title: "End" },
 *     },
 *     flows: { a: { source: "Start", target: "Approve" }, b: { source: "Approve", target: "End" } },
 *   },
 * });
 *
 * await runtime.start(orderApproval, { actor, input: { orderId: "o-1" } });
 * ```
 *
 * A Tool is named by its class (or by a Tool made by `defineTool`:
 * `orderTools.find`), a called process and the error handler by their
 * `defineProcess` result; a name or a key in a string is still taken, for what
 * the module does not see. A document of version 1 goes through `upgradeDocument`.
 */
export function defineProcess<const V extends readonly VariableSpec[] = readonly VariableSpec[], const N extends CodeProcessNodes = Readonly<Record<string, ProcessNode>>>(
  definition: ProcessDefinition<V, N>,
): CodeProcess<ProcessInput<V>, ProcessOutput<V>> {
  const { document, ...catalog } = definition;
  return Object.freeze({ ...catalog, document: storedDocument(String(definition.key), document as unknown as LooseDocument), [CODE_PROCESS]: true as const });
}

export function isCodeProcess(value: unknown): value is CodeProcess {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[CODE_PROCESS] === true;
}

interface LooseDocument {
  readonly settings?: { readonly errorHandler?: unknown };
  readonly nodes?: unknown;
}

/** The document with its references written as the engine stores them: a Tool by name, a process by key. */
function storedDocument(key: string, document: LooseDocument): ProcessDocument {
  // A wrong shape is the business of the checks at start: they name every problem at once.
  if (typeof document !== "object" || document === null) return document as unknown as ProcessDocument;
  const out: Record<string, unknown> = { ...document };
  if (typeof document.settings === "object" && document.settings !== null && document.settings.errorHandler !== undefined) {
    out.settings = { ...document.settings, errorHandler: processKeyOf(key, "settings.errorHandler", document.settings.errorHandler) };
  }
  if (typeof document.nodes === "object" && document.nodes !== null && !Array.isArray(document.nodes)) {
    const nodes: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(document.nodes as Record<string, unknown>)) nodes[id] = storedNode(key, id, node);
    out.nodes = nodes;
  }
  return out as unknown as ProcessDocument;
}

function storedNode(key: string, id: string, node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const { kind, config } = node as { readonly kind?: unknown; readonly config?: unknown };
  if (typeof config !== "object" || config === null) return node;
  const fields = config as Record<string, unknown>;
  if (kind === "serviceTask" && typeof fields.tool === "function") {
    const name = toolNameOf(fields.tool);
    if (name === undefined) {
      throw new TypeError(`defineProcess("${key}"): node "${id}" names ${fields.tool.name || "a class"} as its Tool, but it is neither a class with @Tool nor a Tool made by defineTool.`);
    }
    return { ...node, config: { ...fields, tool: name } };
  }
  if (kind === "callProcess" && typeof fields.process !== "string" && fields.process !== undefined) {
    return { ...node, config: { ...fields, process: processKeyOf(key, `node "${id}"`, fields.process) } };
  }
  return node;
}

function processKeyOf(key: string, where: string, value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isCodeProcess(value)) return value.key;
  throw new TypeError(`defineProcess("${key}"): ${where} must name a process by its key or by its defineProcess(...) result.`);
}
