import { ModelValidationError } from "../Errors/HttpError";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { ParameterBinding, SourceModelField } from "./bindings";
import { tryConvert, INVALID, type ValueType } from "./convert";
import type { ModelValidationIssue, ModelValidator } from "./modelValidator";

/** Values one query parameter may carry: bounds the work for `?tag=…` repeated thousands of times. */
export const MAX_QUERY_VALUES = 100;

const VALUE_TYPES: Readonly<Record<SourceModelField["type"], ValueType>> = { string: "string", number: "number", boolean: "bool" };

/**
 * A query or header model: every declared field is read from the request by
 * its wire name, converted to the field type and then checked by the model's
 * `@Validator` rules — before the action runs. All problems come in one 400,
 * named as the client sent them (`page_size`, `x-tenant-id`). Undeclared
 * parameters are ignored; a field that is absent keeps its initializer.
 */
export async function bindSourceModel(binding: ParameterBinding, ctx: HttpContext): Promise<object> {
  const model = binding.model as new () => object;
  const instance = new model() as Record<string, unknown>;
  const source = binding.source === "headerModel" ? "header" : "query";
  const issues: ModelValidationIssue[] = [];
  const failed = new Set<string>();
  const validator = ctx.modelValidator;
  const say = (code: string, params: Readonly<Record<string, unknown>>, english: string): ModelValidationIssue => ({
    property: params.property as string,
    message: validator?.message?.(code, params) ?? english,
    code,
    params,
  });

  for (const field of binding.fields ?? []) {
    const raw = source === "query" ? ctx.url.searchParams.getAll(field.wire) : headerValues(ctx, field.wire);
    if (raw.length === 0) continue;
    if (!field.array && raw.length > 1) {
      // `?page_size=10&page_size=1000`: the proxy and the app could read
      // different values, so neither is taken.
      issues.push(say("duplicate", { property: field.wire }, `Parameter "${field.wire}" must be given once`));
      failed.add(field.property);
      continue;
    }
    if (raw.length > MAX_QUERY_VALUES) {
      issues.push(say("tooManyValues", { property: field.wire, max: MAX_QUERY_VALUES }, `Parameter "${field.wire}" accepts at most ${MAX_QUERY_VALUES} values`));
      failed.add(field.property);
      continue;
    }
    const values: unknown[] = [];
    for (const text of raw) {
      const value = tryConvert(text, VALUE_TYPES[field.type]);
      if (value === INVALID) {
        const params = { property: field.wire, expected: field.type, actual: "string" };
        issues.push(say("type", params, `Field "${field.wire}" must be of type ${field.type}, got: string`));
        failed.add(field.property);
        break;
      }
      values.push(value);
    }
    if (!failed.has(field.property)) instance[field.property] = field.array ? values : values[0];
  }

  const result = validator === undefined ? undefined : await (validator.validateAsync?.(instance) ?? validator.validate(instance));
  const wires = new Map((binding.fields ?? []).map((field) => [field.property, field.wire]));
  for (const error of result?.errors ?? []) {
    if (failed.has(error.property)) continue;
    issues.push(onTheWire(error, wires, validator));
  }
  if (issues.length > 0) {
    throw new ModelValidationError(issues, validator?.message?.("validationFailed", {}) ?? "Validation failed");
  }
  return instance;
}

/** A header field takes one value; `fetch` already joins repeated headers. */
function headerValues(ctx: HttpContext, name: string): string[] {
  const value = ctx.header(name);
  return value === undefined ? [] : [value];
}

/** A rule error renamed to the wire name, the message rendered again with it. */
function onTheWire(error: ModelValidationIssue, wires: ReadonlyMap<string, string>, validator: ModelValidator | undefined): ModelValidationIssue {
  const wire = wires.get(error.property);
  if (wire === undefined || wire === error.property) return error;
  if (error.params === undefined || error.code === undefined) return { ...error, property: wire };
  const params = { ...error.params, property: wire };
  return { property: wire, message: validator?.message?.(error.code, params) ?? error.message, code: error.code, params };
}
