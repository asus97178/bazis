import { EXPRESSION_FUNCTIONS, type ExprFunction } from "./expressions";
import type { LocalizedText } from "./localized";
import { NODE_KINDS, nodeKindOf, type JsonSchema, type NodeRole } from "./nodeKinds";
import { DATA_PATHS } from "./paths";
import type { NodeKind } from "./ProcessDocument";

/** What the palette shows of a Tool: structurally a Tool contract. */
export interface PaletteTool {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly kind?: string; readonly schema?: unknown };
  readonly output?: { readonly kind?: string; readonly schema?: unknown };
  readonly sideEffect: string;
  readonly dryRun: string;
}

export interface PaletteNodeKind {
  readonly kind: NodeKind;
  readonly role: NodeRole;
  /** A container: other nodes name it as their `parent`. */
  readonly container?: boolean;
  readonly config: JsonSchema;
}

/** Everything a designer builds its forms from (WORKFLOW-002 §4.2). */
export interface ProcessPalette {
  readonly nodeKinds: readonly PaletteNodeKind[];
  readonly functions: readonly ExprFunction[];
  readonly paths: typeof DATA_PATHS;
  readonly tools: readonly PaletteTool[];
}

/** The palette with the application's Tools: a new Tool appears in a designer without a release of the framework. */
export function processPalette(tools: readonly PaletteTool[]): ProcessPalette {
  return {
    nodeKinds: NODE_KINDS.map(({ kind, role, container, config }) => ({ kind, role, ...(container === undefined ? {} : { container }), config })),
    functions: EXPRESSION_FUNCTIONS,
    paths: DATA_PATHS,
    tools,
  };
}

/** One field of the form of a step. */
export interface StepFormField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly title?: LocalizedText;
  readonly description?: string;
  readonly values?: readonly unknown[];
  /** What the field references (`x-ref`), its keys reference (`x-ref-keys`) and the input that gives the area (`x-ref-scope`). */
  readonly ref?: string;
  readonly refKeys?: string;
  readonly refScope?: string;
  /** Personal data (`x-personal`). */
  readonly personal?: boolean;
  /** The fields of an object. */
  readonly fields?: readonly StepFormField[];
  /** A list's items. */
  readonly items?: StepFormField;
}

export interface StepForm {
  readonly fields: readonly StepFormField[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldOf(name: string, schema: unknown, required: boolean): StepFormField {
  const source = isObject(schema) ? schema : {};
  const values = Array.isArray(source.enum) ? source.enum : undefined;
  const type = typeof source.type === "string" ? source.type : Array.isArray(source.type) ? String(source.type.find((item) => item !== "null") ?? "any") : values !== undefined ? "enum" : "any";
  const fields = isObject(source.properties) ? fieldsOf(source) : undefined;
  return {
    name,
    type,
    required,
    ...(source.title === undefined ? {} : { title: source.title as LocalizedText }),
    ...(typeof source.description === "string" ? { description: source.description } : {}),
    ...(values === undefined ? {} : { values }),
    ...(typeof source["x-ref"] === "string" ? { ref: source["x-ref"] } : {}),
    ...(typeof source["x-ref-keys"] === "string" ? { refKeys: source["x-ref-keys"] } : {}),
    ...(typeof source["x-ref-scope"] === "string" ? { refScope: source["x-ref-scope"] } : {}),
    ...(source["x-personal"] === true ? { personal: true } : {}),
    ...(fields === undefined ? {} : { fields }),
    ...(isObject(source.items) ? { items: fieldOf("item", source.items, false) } : {}),
  };
}

function fieldsOf(schema: Record<string, unknown>): StepFormField[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(isObject(schema.properties) ? schema.properties : {}).map(([name, item]) => fieldOf(name, item, required.has(name)));
}

/**
 * The form of a step's settings, by the palette (WORKFLOW-002 §3.8): the
 * `config` of a node kind, or the input of a Tool: fields, types, references
 * and localizable titles. An unknown kind has no fields.
 */
export function formOf(source: NodeKind | Pick<PaletteTool, "input">): StepForm {
  if (typeof source === "string") {
    const definition = nodeKindOf(source);
    return { fields: definition === undefined ? [] : fieldsOf(definition.config as Record<string, unknown>) };
  }
  const schema = source.input?.schema;
  return { fields: isObject(schema) ? fieldsOf(schema) : [] };
}

