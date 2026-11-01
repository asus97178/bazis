import { checkLocalizedText, type LocalizedText } from "./localized";

/** The types of variables and of task form fields. */
export type FieldType = "string" | "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum" | "object" | "list" | "ref";

/** A field of a task form; a variable of a process is the same with a direction. */
export interface FormField {
  /** The key in the value: `amount`, `reason`. */
  readonly name: string;
  readonly type: FieldType;
  readonly title?: LocalizedText;
  readonly default?: unknown;
  readonly required?: boolean;
  /** Allowed values of an `enum` field. */
  readonly values?: readonly (string | number)[];
  /** For `ref`: the kind of reference, for example `orm.entity:Order`. */
  readonly ref?: string;
  /** Personal data: masked in the history under `log.maskPersonal`. */
  readonly personal?: boolean;
  /** The application's rules by namespace; `WorkflowInputValidator` reads them. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** `in`: the input of a start. `local`: inside the process. `out`: what the process gives back. */
export type VariableDirection = "in" | "local" | "out";

export interface VariableSpec extends FormField {
  readonly direction: VariableDirection;
}

/** The fields of a process input or a task form. */
export interface FormSpec {
  readonly fields: readonly FormField[];
}

/** One problem of a value: which field and why. */
export interface FormIssue {
  readonly field: string;
  /** Built in: `required`, `type`, `enum`, `unknown`; an application's validator adds its own. */
  readonly code: string;
  readonly message: string;
}

const TYPES = new Set<FieldType>(["string", "text", "number", "integer", "boolean", "date", "datetime", "enum", "object", "list", "ref"]);
const DIRECTIONS = new Set<VariableDirection>(["in", "local", "out"]);
/** A variable or field name. */
export const FIELD_NAME = /^[a-z][A-Za-z0-9_]{0,39}$/;
const REF_KIND = /^[a-z][A-Za-z0-9_.:-]{0,127}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELDS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is wrong with `extensions`, or `null`: an object of namespace → anything. */
export function checkExtensions(value: unknown, at: string): string | null {
  if (value === undefined) return null;
  if (!isObject(value)) return `${at} must be an object of namespace → data`;
  const bad = Object.keys(value).find((key) => !NAMESPACE.test(key));
  return bad === undefined ? null : `${at} has an invalid namespace ${JSON.stringify(bad)}`;
}

/** What is wrong with one field, or `null`. */
function checkField(field: unknown, where: string): string | null {
  if (!isObject(field)) return `${where} must be an object`;
  if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) return `${where}.name must match ${FIELD_NAME.source}`;
  if (typeof field.type !== "string" || !TYPES.has(field.type as FieldType)) return `${where}.type must be one of ${[...TYPES].join(", ")}`;
  if (field.title !== undefined) {
    const problem = checkLocalizedText(field.title, 200);
    if (problem) return `${where}.title ${problem}`;
  }
  if (field.required !== undefined && typeof field.required !== "boolean") return `${where}.required must be a boolean`;
  if (field.personal !== undefined && typeof field.personal !== "boolean") return `${where}.personal must be a boolean`;
  if (field.type === "enum") {
    if (!Array.isArray(field.values) || field.values.length === 0 || !field.values.every((item) => typeof item === "string" || typeof item === "number")) {
      return `${where}.values must be a non-empty list of strings or numbers`;
    }
  } else if (field.values !== undefined) {
    return `${where}.values is only for enum fields`;
  }
  if (field.type === "ref") {
    if (typeof field.ref !== "string" || !REF_KIND.test(field.ref)) return `${where}.ref must name a kind of reference`;
  } else if (field.ref !== undefined) {
    return `${where}.ref is only for ref fields`;
  }
  const extensions = checkExtensions(field.extensions, `${where}.extensions`);
  if (extensions) return extensions;
  if (field.default !== undefined && field.default !== null) {
    const problem = checkType(field as unknown as FormField, field.default);
    if (problem) return `${where}.default: ${problem.message}`;
  }
  return null;
}

/** Checks the shape of a form spec; returns a problem or `null`. `at` names it in the text. */
export function checkFormSpec(value: unknown, at: string): string | null {
  if (!isObject(value) || !Array.isArray(value.fields)) return `${at} must be an object with a fields list`;
  if (value.fields.length > MAX_FIELDS) return `${at} has more than ${MAX_FIELDS} fields`;
  const seen = new Set<string>();
  for (const [index, field] of value.fields.entries()) {
    const where = `${at}.fields[${index}]`;
    const problem = checkField(field, where);
    if (problem) return problem;
    if (isObject(field) && Object.hasOwn(field, "direction")) return `${where}: a form field has no direction`;
    const name = (field as FormField).name;
    if (seen.has(name)) return `${where}.name ${name} is repeated`;
    seen.add(name);
  }
  return null;
}

/** Every problem of the variables of a document, with the variable it is about. */
export function variableProblems(value: unknown): readonly { readonly variable?: string; readonly message: string }[] {
  if (!Array.isArray(value)) return [{ message: "variables must be a list" }];
  if (value.length > MAX_FIELDS) return [{ message: `there are more than ${MAX_FIELDS} variables` }];
  const out: { variable?: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const [index, variable] of value.entries()) {
    const where = `variables[${index}]`;
    const name = isObject(variable) && typeof variable.name === "string" ? variable.name : undefined;
    const at = name === undefined ? {} : { variable: name };
    const problem = checkField(variable, where);
    if (problem) {
      out.push({ ...at, message: problem });
      continue;
    }
    const spec = variable as Record<string, unknown>;
    if (typeof spec.direction !== "string" || !DIRECTIONS.has(spec.direction as VariableDirection)) out.push({ ...at, message: `${where}.direction must be in, local or out` });
    else if (spec.required !== undefined && spec.direction !== "in") out.push({ ...at, message: `${where}.required is only for in variables` });
    if (seen.has(name!)) out.push({ ...at, message: `${where}.name ${name} is repeated` });
    seen.add(name!);
  }
  return out;
}

/** The field names of a form spec. */
export function formFieldNames(spec: FormSpec): string[] {
  return spec.fields.map((field) => field.name);
}

/**
 * Checks a value against a form spec: required fields, types, enum values and
 * unknown fields; a missing field takes its `default`. Returns the value with
 * only the declared fields and every issue. Without a spec the form takes no
 * data: any field is unknown.
 */
export function validateForm(spec: FormSpec | undefined, value: unknown): { readonly value: Record<string, unknown>; readonly issues: readonly FormIssue[] } {
  const issues: FormIssue[] = [];
  const source = value === undefined || value === null ? {} : value;
  if (!isObject(source)) return { value: {}, issues: [{ field: "", code: "type", message: "value must be an object" }] };
  const fields = spec?.fields ?? [];
  const declared = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(source)) {
    if (!declared.has(key)) issues.push({ field: key, code: "unknown", message: `field ${key} is not declared` });
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const given = Object.hasOwn(source, field.name) ? source[field.name] : undefined;
    const item = given === undefined || given === null || given === "" ? field.default : given;
    if (item === undefined || item === null || item === "") {
      if (field.required === true) issues.push({ field: field.name, code: "required", message: `field ${field.name} is required` });
      continue;
    }
    const problem = checkType(field, item);
    if (problem) issues.push({ field: field.name, ...problem });
    else out[field.name] = item;
  }
  return { value: out, issues };
}

function checkType(field: FormField, value: unknown): { code: "type" | "enum"; message: string } | null {
  const wrong = (expected: string) => ({ code: "type" as const, message: `field ${field.name} must be ${expected}` });
  switch (field.type) {
    case "string":
    case "text":
      return typeof value === "string" ? null : wrong("a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : wrong("a number");
    case "integer":
      return Number.isSafeInteger(value) ? null : wrong("an integer");
    case "boolean":
      return typeof value === "boolean" ? null : wrong("true or false");
    case "date":
      return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value)) ? null : wrong("a date YYYY-MM-DD");
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? null : wrong("an ISO 8601 date and time");
    case "enum":
      return (field.values ?? []).includes(value as string | number) ? null : { code: "enum", message: `field ${field.name} must be one of ${(field.values ?? []).join(", ")}` };
    case "object":
      return isObject(value) ? null : wrong("an object");
    case "list":
      return Array.isArray(value) ? null : wrong("a list");
    case "ref":
      return (typeof value === "string" && value !== "") || typeof value === "number" ? null : wrong("a reference: a string or a number");
  }
}
