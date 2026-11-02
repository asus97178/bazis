import { isExpressionNode } from "./expressions";
import { isPath } from "./paths";
import type { ProcessDocument } from "./ProcessDocument";

/** One reference in a Tool input or a document: what `x-ref` and `x-ref-keys` of a schema mark. */
export interface InputReference {
  readonly kind: string;
  readonly id: string;
  /** The area it is looked for in: `x-ref-scope`. */
  readonly within?: string;
  /** Where in the input: `/values/status`. */
  readonly path: string;
}

/** A reference of a document, and whose it is. */
export interface DocumentReference extends InputReference {
  readonly node?: string;
  readonly variable?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is known only when the step runs. */
function isComputed(value: unknown): boolean {
  return isPath(value) || isExpressionNode(value);
}

function isId(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || typeof value === "number";
}

/**
 * The references in a Tool input by the JSON Schema of the input. A value computed
 * when the step runs is left out: it is checked then. `x-ref-scope` beginning
 * with `/` is a JSON Pointer to another field of the input; otherwise it is the area
 * itself. A reference whose area is computed is left out too.
 */
export function inputReferences(schema: unknown, input: unknown): InputReference[] {
  const out: InputReference[] = [];
  const within = (source: Json): { readonly known: boolean; readonly value?: string } => {
    const scope = source["x-ref-scope"];
    if (typeof scope !== "string") return { known: true };
    if (!scope.startsWith("/")) return { known: true, value: scope };
    let current: unknown = input;
    for (const key of scope.slice(1).split("/")) {
      current = isObject(current) && Object.hasOwn(current, key) ? current[key] : undefined;
    }
    return isId(current) && !isComputed(current) ? { known: true, value: String(current) } : { known: false };
  };
  const walk = (source: unknown, value: unknown, path: string): void => {
    if (!isObject(source) || value === undefined || value === null || isComputed(value)) return;
    const area = within(source);
    const add = (kind: string, id: string, at: string) => out.push({ kind, id, ...(area.value === undefined ? {} : { within: area.value }), path: at });
    if (typeof source["x-ref"] === "string" && isId(value) && area.known) add(source["x-ref"], String(value), path);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(source.items, item, `${path}/${index}`));
      return;
    }
    if (!isObject(value)) return;
    if (typeof source["x-ref-keys"] === "string" && area.known) for (const key of Object.keys(value)) add(source["x-ref-keys"], key, `${path}/${key}`);
    if (isObject(source.properties)) {
      for (const [key, item] of Object.entries(source.properties)) if (Object.hasOwn(value, key)) walk(item, value[key], `${path}/${key}`);
    }
  };
  walk(schema, input, "");
  return out;
}

/** The kinds a schema refers to, whatever the values: each must have an owner. */
export function schemaReferenceKinds(schema: unknown): string[] {
  const kinds = new Set<string>();
  const walk = (source: unknown): void => {
    if (!isObject(source)) return;
    for (const key of ["x-ref", "x-ref-keys"]) if (typeof source[key] === "string") kinds.add(source[key]);
    if (isObject(source.properties)) Object.values(source.properties).forEach(walk);
    walk(source.items);
  };
  walk(schema);
  return [...kinds];
}

/**
 * The references a document holds as literals (WORKFLOW-002 §6.3): in the inputs of
 * its Tools, by their schemas; the defaults of variables of type `ref`; the processes
 * it calls. `inputSchemaOf` gives the input schema of a Tool, if it is known.
 */
export function documentReferences(document: ProcessDocument, inputSchemaOf: (tool: string) => unknown): DocumentReference[] {
  const out: DocumentReference[] = [];
  for (const variable of document.variables ?? []) {
    if (variable.type === "ref" && typeof variable.ref === "string" && isId(variable.default)) {
      out.push({ kind: variable.ref, id: String(variable.default), path: "/default", variable: variable.name });
    }
  }
  const handler = document.settings?.errorHandler;
  if (handler !== undefined) out.push({ kind: "workflow.process", id: handler, path: "/settings/errorHandler" });
  for (const [node, { kind, config }] of Object.entries(document.nodes)) {
    if (kind === "callProcess" && typeof config?.process === "string") out.push({ kind: "workflow.process", id: config.process, path: "/process", node });
    if (kind !== "serviceTask" || typeof config?.tool !== "string") continue;
    for (const reference of inputReferences(inputSchemaOf(config.tool), config.input)) out.push({ ...reference, node });
  }
  return out;
}
