/** Field types of a process input and of a task form. */
export type FormFieldType = "string" | "text" | "number" | "integer" | "boolean" | "date" | "datetime" | "enum";

export interface FormField {
  /** The key in the value: `amount`, `reason`. */
  readonly code: string;
  readonly type: FormFieldType;
  readonly title?: string;
  readonly required?: boolean;
  /** Allowed values of an `enum` field. */
  readonly values?: readonly (string | number)[];
}

/** The fields of a process input or a task form. */
export interface FormSpec {
  readonly fields: readonly FormField[];
}

/** One problem of a value: which field and why. */
export interface FormIssue {
  readonly field: string;
  readonly code: "required" | "type" | "enum" | "unknown";
  readonly message: string;
}

const TYPES = new Set<FormFieldType>(["string", "text", "number", "integer", "boolean", "date", "datetime", "enum"]);
const CODE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELDS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the shape of a form spec; returns a problem or `null`. `at` names it in the text. */
export function checkFormSpec(value: unknown, at: string): string | null {
  if (!isObject(value) || !Array.isArray(value.fields)) return `${at} must be an object with a fields list`;
  if (value.fields.length > MAX_FIELDS) return `${at} has more than ${MAX_FIELDS} fields`;
  const seen = new Set<string>();
  for (const [index, field] of value.fields.entries()) {
    const where = `${at}.fields[${index}]`;
    if (!isObject(field)) return `${where} must be an object`;
    if (typeof field.code !== "string" || !CODE.test(field.code) || field.code === "__proto__") return `${where}.code is invalid`;
    if (seen.has(field.code)) return `${where}.code ${field.code} is repeated`;
    seen.add(field.code);
    if (typeof field.type !== "string" || !TYPES.has(field.type as FormFieldType)) return `${where}.type must be one of ${[...TYPES].join(", ")}`;
    if (field.title !== undefined && (typeof field.title !== "string" || field.title.length > 200)) return `${where}.title must be up to 200 characters`;
    if (field.required !== undefined && typeof field.required !== "boolean") return `${where}.required must be a boolean`;
    if (field.type === "enum") {
      if (!Array.isArray(field.values) || field.values.length === 0 || !field.values.every((item) => typeof item === "string" || typeof item === "number")) {
        return `${where}.values must be a non-empty list of strings or numbers`;
      }
    } else if (field.values !== undefined) {
      return `${where}.values is only for enum fields`;
    }
  }
  return null;
}

/** The field codes of a form spec. */
export function formFieldCodes(spec: FormSpec): string[] {
  return spec.fields.map((field) => field.code);
}

/**
 * Checks a value against a form spec: required fields, types, enum values and
 * unknown fields. Returns the value with only the declared fields and every issue.
 * Without a spec the form takes no data: any field is unknown.
 */
export function validateForm(spec: FormSpec | undefined, value: unknown): { readonly value: Record<string, unknown>; readonly issues: readonly FormIssue[] } {
  const issues: FormIssue[] = [];
  const source = value === undefined || value === null ? {} : value;
  if (!isObject(source)) return { value: {}, issues: [{ field: "", code: "type", message: "value must be an object" }] };
  const fields = spec?.fields ?? [];
  const declared = new Set(fields.map((field) => field.code));
  for (const key of Object.keys(source)) {
    if (!declared.has(key)) issues.push({ field: key, code: "unknown", message: `field ${key} is not declared` });
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const item = Object.hasOwn(source, field.code) ? source[field.code] : undefined;
    if (item === undefined || item === null || item === "") {
      if (field.required === true) issues.push({ field: field.code, code: "required", message: `field ${field.code} is required` });
      continue;
    }
    const problem = checkType(field, item);
    if (problem) issues.push({ field: field.code, ...problem });
    else out[field.code] = item;
  }
  return { value: out, issues };
}

function checkType(field: FormField, value: unknown): { code: "type" | "enum"; message: string } | null {
  const wrong = (expected: string) => ({ code: "type" as const, message: `field ${field.code} must be ${expected}` });
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
      return (field.values ?? []).includes(value as string | number) ? null : { code: "enum", message: `field ${field.code} must be one of ${(field.values ?? []).join(", ")}` };
  }
}
