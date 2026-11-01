import type { Expr } from "./expressions";
import type { VariableSpec } from "./formFields";
import { isPath } from "./paths";
import { PROCESS_SCHEMA_VERSION, type ProcessDocument, type ProcessFlow, type ProcessNode } from "./ProcessDocument";

/** The version 1 of the format, for {@link upgradeDocument}. */
export const PROCESS_SCHEMA_VERSION_V1 = "bazis.workflow/v1";

/** A condition of version 1: a tree of `all` / `any` / `not` and comparisons. */
export type ConditionV1 =
  | { readonly all: readonly ConditionV1[] }
  | { readonly any: readonly ConditionV1[] }
  | { readonly not: ConditionV1 }
  | { readonly path: string; readonly op: string; readonly value?: unknown };

export interface FormFieldV1 {
  readonly code: string;
  readonly type: string;
  readonly title?: string;
  readonly required?: boolean;
  readonly values?: readonly (string | number)[];
}

export interface ProcessDocumentV1 {
  readonly schemaVersion: typeof PROCESS_SCHEMA_VERSION_V1;
  readonly input?: { readonly fields: readonly FormFieldV1[] };
  readonly nodes: Readonly<Record<string, { readonly kind: string; readonly title: string; readonly attachedTo?: string; readonly config?: Readonly<Record<string, unknown>> }>>;
  readonly flows: Readonly<Record<string, { readonly source: string; readonly target: string; readonly title?: string; readonly condition?: ConditionV1; readonly isDefault?: boolean }>>;
  readonly diagram?: ProcessDocument["diagram"];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A document of version 1 as version 2: `input` becomes `in` variables, form
 * fields take `name` instead of `code`, conditions become expressions, titles
 * stay as they are. A pure function. A draft may hold errors, so what is not of
 * the expected shape is left as it is for the validation to report; anything
 * that is not version 1 comes back unchanged.
 */
export function upgradeDocument(document: ProcessDocumentV1): ProcessDocument;
export function upgradeDocument(document: unknown): unknown;
export function upgradeDocument(document: unknown): unknown {
  if (!isObject(document) || document.schemaVersion !== PROCESS_SCHEMA_VERSION_V1) return document;
  const { input, nodes, flows, ...rest } = document;
  const fields = isObject(input) && Array.isArray(input.fields) ? input.fields : undefined;
  return {
    ...rest,
    schemaVersion: PROCESS_SCHEMA_VERSION,
    ...(fields === undefined ? {} : { variables: fields.map((field) => upgradeField(field, "in")) }),
    nodes: isObject(nodes) ? Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, upgradeNode(node)])) : nodes,
    flows: isObject(flows) ? Object.fromEntries(Object.entries(flows).map(([id, flow]) => [id, upgradeFlow(flow)])) : flows,
  };
}

function upgradeField(field: unknown, direction?: VariableSpec["direction"]): unknown {
  if (!isObject(field)) return field;
  const { code, ...rest } = field;
  return { name: code, ...rest, ...(direction === undefined ? {} : { direction }) };
}

function upgradeNode(node: unknown): ProcessNode | unknown {
  if (!isObject(node) || !isObject(node.config) || !isObject(node.config.form) || !Array.isArray(node.config.form.fields)) return node;
  return { ...node, config: { ...node.config, form: { ...node.config.form, fields: node.config.form.fields.map((field) => upgradeField(field)) } } };
}

function upgradeFlow(flow: unknown): ProcessFlow | unknown {
  if (!isObject(flow) || flow.condition === undefined) return flow;
  return { ...flow, condition: upgradeCondition(flow.condition) };
}

/** `all` → `and`, `any` → `or`, `not` → `not`, a comparison → a call with the path first. */
export function upgradeCondition(condition: unknown): Expr {
  if (!isObject(condition)) return condition as Expr;
  if (Array.isArray(condition.all)) return { op: "and", args: condition.all.map(upgradeCondition) };
  if (Array.isArray(condition.any)) return { op: "or", args: condition.any.map(upgradeCondition) };
  if (condition.not !== undefined) return { op: "not", args: [upgradeCondition(condition.not)] };
  if (typeof condition.path !== "string" || typeof condition.op !== "string") return condition as Expr;
  const path = { path: condition.path };
  if (condition.value === undefined) return { op: condition.op, args: [path] } as Expr;
  return { op: condition.op, args: [path, isPath(condition.value) ? { path: condition.value } : condition.value as Expr] } as Expr;
}
