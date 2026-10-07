import { MessageRegistry } from "./MessageRegistry";
import { RuleCompiler, type CompiledRule } from "./RuleCompiler";
import { ValidationError } from "./ValidationError";
import { ValidationResult } from "./ValidationResult";
import { hasRules } from "./metadata";
import { ValidationCodes } from "./types/ValidationCode";
import type { CustomOutcome, ValidatorOptions } from "./types/ValidatorOptions";

/** Email is checked with linear passes; whitespace is forbidden in both parts. */
const EMAIL_WHITESPACE_PATTERN = /\s/;

/**
 * UUID versions 1–8 (including v4 from `crypto.randomUUID()` and v7 from
 * `Bun.randomUUIDv7()`) with a correct variant, plus the nil UUID.
 * Character classes only, no backtracking.
 */
const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

/** Phone number after normalization: an optional `+` and 7–15 digits. */
const PHONE_PATTERN = /^\+?\d{7,15}$/;

/** Characters dropped when normalizing a phone number: spaces, hyphens, parentheses. */
const PHONE_NOISE = /[\s\-()]/g;

/** Deferred async check (a custom function that needs await). */
type AsyncJob = () => Promise<void>;

/**
 * Validation engine: one pass over the compiled plan of a class.
 *
 * Principles:
 * - errors are collected into one array; string content checks are skipped
 *   when the value exceeds the upper length bound of the same decorator;
 * - the hot path (a valid object) barely allocates: the plan is cached, and
 *   message parameter objects are created only on error;
 * - exceptions from user functions (`custom`, `validateIf`) are caught and
 *   turned into an error with the `customError` code; validation continues;
 * - nested objects are checked recursively with protection against circular references.
 */
export class RuleEngine {
  /**
   * Synchronous validation. If a field has an async `custom` function
   * (it returned a Promise), an `asyncCustomInSyncCall` error is added.
   */
  static validate(instance: object): ValidationResult {
    const errors: ValidationError[] = [];
    RuleEngine.collect(instance, "", errors, undefined, undefined);
    return new ValidationResult(errors);
  }

  /**
   * Asynchronous validation: all synchronous rules run immediately, async
   * `custom` functions run sequentially after them (deterministic error order).
   */
  static async validateAsync(instance: object): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const jobs: AsyncJob[] = [];
    RuleEngine.collect(instance, "", errors, jobs, undefined);
    for (const job of jobs) {
      await job();
    }
    return new ValidationResult(errors);
  }

  /** Runs the plan of the instance's class; without decorators it silently returns. */
  private static collect(
    instance: object,
    prefix: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    const plan = RuleCompiler.planFor(instance.constructor);
    if (!plan) {
      return;
    }
    for (const rule of plan) {
      RuleEngine.applyRule(rule, instance, prefix, errors, jobs, seen);
    }
  }

  private static applyRule(
    rule: CompiledRule,
    instance: object,
    prefix: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    const o = rule.options;
    const path = prefix === "" ? rule.property : `${prefix}.${rule.property}`;

    // 1. Conditional validation: false -> the whole decorator is skipped.
    if (o.validateIf !== undefined) {
      try {
        if (!(o.validateIf as (instance: unknown) => boolean)(instance)) {
          return;
        }
      } catch (error) {
        RuleEngine.fail(errors, ValidationCodes.customError, path, undefined, o, { error: RuleEngine.describeError(error) });
        return;
      }
    }

    const value = (instance as Record<string, unknown>)[rule.property];

    // 2. Missing value: an error only with required, otherwise the field is optional.
    if (value === undefined || value === null) {
      if (o.required === true) {
        RuleEngine.fail(errors, ValidationCodes.required, path, value, o, undefined);
      }
      return;
    }

    // 3. String rules: first one type check, then the rules themselves.
    if (rule.needsString) {
      if (Array.isArray(value) && RuleEngine.onlyLengthRules(o)) {
        RuleEngine.applyArrayLengthRules(o, value, path, errors);
      } else if (typeof value !== "string") {
        RuleEngine.failType(errors, path, value, o, "string");
        return;
      } else {
        RuleEngine.applyStringRules(rule, value, path, errors);
      }
    }

    // 4. Number rules.
    if (rule.needsNumber) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        RuleEngine.failType(errors, path, value, o, "number");
        return;
      }
      RuleEngine.applyNumberRules(o, value, path, errors);
    }

    // 5. Boolean rules.
    if (rule.needsBoolean) {
      if (typeof value !== "boolean") {
        RuleEngine.failType(errors, path, value, o, "boolean");
        return;
      }
      if (o.mustBeTrue === true && value !== true) {
        RuleEngine.fail(errors, ValidationCodes.mustBeTrue, path, value, o, undefined);
      }
      if (o.mustBeFalse === true && value !== false) {
        RuleEngine.fail(errors, ValidationCodes.mustBeFalse, path, value, o, undefined);
      }
    }

    // 6. Enum: membership in a precomputed Set (O(1)).
    if (rule.enumValues !== undefined && !rule.enumValues.has(value)) {
      RuleEngine.fail(errors, ValidationCodes.enum, path, value, o, { allowed: rule.enumLabel });
    }

    // 7. Date (the type: "date" hint).
    if (rule.checkDate && !RuleEngine.isValidDate(value)) {
      RuleEngine.fail(errors, ValidationCodes.date, path, value, o, undefined);
    }

    // 8. Custom check.
    if (o.custom !== undefined) {
      RuleEngine.applyCustom(o, value, instance, path, errors, jobs);
    }

    // 9. Nested validation: only the carrier rule (see RuleCompiler),
    // so several decorators on a field do not duplicate errors.
    if (rule.nested !== "none") {
      RuleEngine.applyNested(rule.nested === "explicit", value, instance, path, errors, jobs, seen);
    }
  }

  /** notEmpty/minLength/maxLength/length also apply to arrays; any other string rule needs a string. */
  private static onlyLengthRules(o: ValidatorOptions): boolean {
    return o.type === undefined && o.contains === undefined && o.notContains === undefined && o.pattern === undefined
      && o.email !== true && o.url !== true && o.uuid !== true && o.json !== true && o.phone !== true;
  }

  private static applyArrayLengthRules(o: ValidatorOptions, value: readonly unknown[], path: string, errors: ValidationError[]): void {
    if (o.notEmpty === true && value.length === 0) {
      RuleEngine.fail(errors, ValidationCodes.notEmpty, path, value, o, undefined);
    }
    if (o.minLength !== undefined && value.length < o.minLength) {
      RuleEngine.fail(errors, ValidationCodes.minItems, path, value, o, { min: o.minLength });
    }
    if (o.maxLength !== undefined && value.length > o.maxLength) {
      RuleEngine.fail(errors, ValidationCodes.maxItems, path, value, o, { max: o.maxLength });
    }
    if (o.length !== undefined && (value.length < o.length[0] || value.length > o.length[1])) {
      RuleEngine.fail(errors, ValidationCodes.itemCount, path, value, o, { min: o.length[0], max: o.length[1] });
    }
  }

  private static applyStringRules(rule: CompiledRule, value: string, path: string, errors: ValidationError[]): void {
    const o = rule.options;
    if (o.notEmpty === true && value.length === 0) {
      RuleEngine.fail(errors, ValidationCodes.notEmpty, path, value, o, undefined);
    }
    if (o.minLength !== undefined && value.length < o.minLength) {
      RuleEngine.fail(errors, ValidationCodes.minLength, path, value, o, { min: o.minLength });
    }
    const exceedsMaxLength = o.maxLength !== undefined && value.length > o.maxLength;
    if (exceedsMaxLength) {
      RuleEngine.fail(errors, ValidationCodes.maxLength, path, value, o, { max: o.maxLength });
    }
    const exceedsLengthRange = o.length !== undefined && value.length > o.length[1];
    if (o.length !== undefined && (value.length < o.length[0] || value.length > o.length[1])) {
      RuleEngine.fail(errors, ValidationCodes.length, path, value, o, { min: o.length[0], max: o.length[1] });
    }
    // The upper bound limits the input of RegExp/parsers. Other fields, decorators
    // and custom checks still run and collect their errors in order.
    if (exceedsMaxLength || exceedsLengthRange) {
      return;
    }
    if (o.contains !== undefined && !value.includes(o.contains)) {
      RuleEngine.fail(errors, ValidationCodes.contains, path, value, o, { contains: o.contains });
    }
    if (o.notContains !== undefined && value.includes(o.notContains)) {
      RuleEngine.fail(errors, ValidationCodes.notContains, path, value, o, { contains: o.notContains });
    }
    if (rule.pattern !== undefined && !rule.pattern.test(value)) {
      RuleEngine.fail(errors, ValidationCodes.pattern, path, value, o, { pattern: rule.pattern.source });
    }
    if (rule.checkEmail && !RuleEngine.isEmail(value)) {
      RuleEngine.fail(errors, ValidationCodes.email, path, value, o, undefined);
    }
    if (rule.checkUrl && !URL.canParse(value)) {
      RuleEngine.fail(errors, ValidationCodes.url, path, value, o, undefined);
    }
    if (rule.checkUuid && !UUID_PATTERN.test(value)) {
      RuleEngine.fail(errors, ValidationCodes.uuid, path, value, o, undefined);
    }
    if (rule.checkJson && !RuleEngine.isJson(value)) {
      RuleEngine.fail(errors, ValidationCodes.json, path, value, o, undefined);
    }
    if (rule.checkPhone && !PHONE_PATTERN.test(value.replace(PHONE_NOISE, ""))) {
      RuleEngine.fail(errors, ValidationCodes.phone, path, value, o, undefined);
    }
  }

  private static applyNumberRules(o: ValidatorOptions, value: number, path: string, errors: ValidationError[]): void {
    if (o.min !== undefined && value < o.min) {
      RuleEngine.fail(errors, ValidationCodes.min, path, value, o, { min: o.min });
    }
    if (o.max !== undefined && value > o.max) {
      RuleEngine.fail(errors, ValidationCodes.max, path, value, o, { max: o.max });
    }
    if (o.range !== undefined && (value < o.range[0] || value > o.range[1])) {
      RuleEngine.fail(errors, ValidationCodes.range, path, value, o, { min: o.range[0], max: o.range[1] });
    }
    if (o.positive === true && value <= 0) {
      RuleEngine.fail(errors, ValidationCodes.positive, path, value, o, undefined);
    }
    if (o.negative === true && value >= 0) {
      RuleEngine.fail(errors, ValidationCodes.negative, path, value, o, undefined);
    }
    if (o.integer === true && !Number.isInteger(value)) {
      RuleEngine.fail(errors, ValidationCodes.integer, path, value, o, undefined);
    }
  }

  /**
   * Custom check. In synchronous mode a Promise is an `asyncCustomInSyncCall`
   * error; in asynchronous mode the check is queued.
   */
  private static applyCustom(
    o: ValidatorOptions,
    value: unknown,
    instance: object,
    path: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
  ): void {
    const custom = o.custom!;
    if (jobs !== undefined) {
      jobs.push(async () => {
        try {
          RuleEngine.handleCustomOutcome(await custom(value, instance), o, value, path, errors);
        } catch (error) {
          RuleEngine.fail(errors, ValidationCodes.customError, path, value, o, { error: RuleEngine.describeError(error) });
        }
      });
      return;
    }
    try {
      const outcome = custom(value, instance);
      if (outcome instanceof Promise) {
        // A pending Promise cannot be awaited synchronously; silently treating
        // the field as valid would be unsafe, so record a usage error.
        outcome.catch(() => {});
        RuleEngine.fail(errors, ValidationCodes.asyncCustomInSyncCall, path, value, o, undefined);
        return;
      }
      RuleEngine.handleCustomOutcome(outcome, o, value, path, errors);
    } catch (error) {
      RuleEngine.fail(errors, ValidationCodes.customError, path, value, o, { error: RuleEngine.describeError(error) });
    }
  }

  private static handleCustomOutcome(
    outcome: CustomOutcome,
    o: ValidatorOptions,
    value: unknown,
    path: string,
    errors: ValidationError[],
  ): void {
    if (outcome === true || outcome === undefined) {
      return;
    }
    if (outcome instanceof ValidationError) {
      errors.push(outcome);
      return;
    }
    if (typeof outcome === "string") {
      // A returned string is the most local message and wins over message.
      errors.push(new ValidationError(path, value, MessageRegistry.format(ValidationCodes.custom, outcome, { property: path, value }), ValidationCodes.custom));
      return;
    }
    RuleEngine.fail(errors, ValidationCodes.custom, path, value, o, undefined);
  }

  /**
   * Nested validation. Enabled by an explicit `nested: true` or automatically
   * when the value (or an array element) is an instance of a decorated class.
   * Cycle protection: objects already visited in the chain are skipped.
   */
  private static applyNested(
    explicit: boolean,
    value: unknown,
    instance: object,
    path: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (item !== null && typeof item === "object" && (explicit || hasRules(item))) {
          RuleEngine.nest(item as object, `${path}[${index}]`, instance, errors, jobs, seen);
        }
      }
      return;
    }
    if (value !== null && typeof value === "object" && (explicit || hasRules(value))) {
      RuleEngine.nest(value as object, path, instance, errors, jobs, seen);
    }
  }

  private static nest(
    child: object,
    path: string,
    parent: object,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    // The Set is created lazily, only when nesting actually occurs.
    const visited = seen ?? new Set<object>([parent]);
    if (visited.has(child)) {
      return;
    }
    visited.add(child);
    RuleEngine.collect(child, path, errors, jobs, visited);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Creates a ValidationError with the message by priority local > global > built-in. */
  private static fail(
    errors: ValidationError[],
    code: string,
    path: string,
    value: unknown,
    o: ValidatorOptions,
    extra: Record<string, unknown> | undefined,
  ): void {
    const params: Record<string, unknown> = { property: path, value };
    if (extra !== undefined) {
      for (const key of Object.keys(extra)) {
        params[key] = extra[key];
      }
    }
    errors.push(new ValidationError(path, value, MessageRegistry.format(code, o.message, params), code));
  }

  private static failType(errors: ValidationError[], path: string, value: unknown, o: ValidatorOptions, expected: string): void {
    const actual = typeof value === "number" && Number.isNaN(value) ? "NaN" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    RuleEngine.fail(errors, ValidationCodes.type, path, value, o, { expected, actual });
  }

  private static isJson(value: string): boolean {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  private static isEmail(value: string): boolean {
    const at = value.indexOf("@");
    if (at <= 0 || at !== value.lastIndexOf("@") || EMAIL_WHITESPACE_PATTERN.test(value)) {
      return false;
    }
    // Grammar: at least one character before and after the dot that separates
    // the domain; extra dots are allowed.
    const dot = value.indexOf(".", at + 2);
    return dot !== -1 && dot < value.length - 1;
  }

  private static isValidDate(value: unknown): boolean {
    if (value instanceof Date) {
      return !Number.isNaN(value.getTime());
    }
    if (typeof value === "string" || typeof value === "number") {
      return !Number.isNaN(new Date(value).getTime());
    }
    return false;
  }

  private static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
