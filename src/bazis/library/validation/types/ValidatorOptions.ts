import type { ValidationError } from "../ValidationError";

/**
 * Hint about the field value type.
 *
 * Optional: the module works without reflection (`emitDecoratorMetadata` and
 * `reflect-metadata` are not used; they conflict with the "no external
 * dependencies" principle), so the expected type is either set explicitly or
 * inferred from the rules themselves (`minLength` implies a string, `min` a
 * number and so on).
 */
export type ValidationTypeHint =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "json"
  | "phone"
  | "email"
  | "date"
  | "any";

/**
 * Result of a `custom` check:
 * - `true` or `void`: the value is valid;
 * - `false`: an error with the standard message (code `custom`);
 * - `string`: an error with this message (code `custom`);
 * - `ValidationError`: added to the result as is.
 */
export type CustomOutcome = boolean | string | void | ValidationError;

/**
 * Custom check. May be synchronous or asynchronous (async checks run only
 * through `Validator.validateAsync`).
 *
 * @param value Current field value.
 * @param instance The whole instance being checked, for cross-field checks
 *   such as "if field A equals X, field B is required".
 */
export type CustomValidator = (value: unknown, instance: unknown) => CustomOutcome | Promise<CustomOutcome>;

/**
 * The rule set of one `@Validator(...)` decorator.
 *
 * A field may have several decorators; all of them run. Rules inside one
 * decorator are checked in a fixed order: `validateIf` -> `required` -> the
 * `type` hint -> string/number/boolean/enum/date rules -> `custom` -> `nested`.
 */
export interface ValidatorOptions {
  /** Explicit value type hint. See {@link ValidationTypeHint}. */
  type?: ValidationTypeHint;

  // ── General ──────────────────────────────────────────────────────────────

  /** The value is required: `undefined` and `null` are errors (code `required`). */
  required?: boolean;

  /**
   * Conditional validation: if the function returns `false`, all other rules of
   * this decorator are skipped. It gets the whole instance, so it can rely on
   * the values of other fields.
   */
  validateIf?: (instance: never) => boolean;

  /**
   * Custom check (synchronous or asynchronous).
   * An exception inside the function is caught and turned into a
   * `ValidationError` with the `customError` code; validation continues.
   */
  custom?: CustomValidator;

  /**
   * Local error message for all rules of this decorator.
   * Has the highest priority (above `Validator.setDefaultMessages`).
   * Supports placeholders: `{property}`, `{value}`, `{min}`, `{max}`,
   * `{pattern}`, `{contains}`, `{allowed}`, `{expected}`, `{actual}`.
   */
  message?: string;

  /**
   * Recursive check of the value as a class with `@Validator` decorators.
   * If not set, it turns on automatically when the field value is an instance
   * of a class with registered rules. `nested: false` turns off the auto mode.
   * Arrays are checked element by element (`items[0].name`); circular
   * references are safely skipped.
   */
  nested?: boolean;

  // ── Strings ──────────────────────────────────────────────────────────────

  /** The string (`""`) or array (`[]`) must not be empty. */
  notEmpty?: boolean;
  /** Minimum string length or array item count (inclusive). */
  minLength?: number;
  /** Maximum string length or array item count (inclusive); for a string, exceeding it skips this decorator's content checks. */
  maxLength?: number;
  /** String length or array item count range `[min, max]` (inclusive); for a string, exceeding max skips this decorator's content checks. */
  length?: readonly [number, number];
  /** The string must contain the substring. */
  contains?: string;
  /** The string must not contain the substring. */
  notContains?: string;
  /**
   * Regular expression (a RegExp or a source string).
   * Compiled once on the first access to the class and cached.
   * For untrusted input set maxLength/length in the same decorator.
   */
  pattern?: RegExp | string;
  /** The string must be a valid email address. */
  email?: boolean;
  /** The string must be a valid URL (checked with `URL.canParse`). */
  url?: boolean;
  /**
   * The string must be a valid UUID (versions 1–8, including v4 from
   * `crypto.randomUUID()` and v7 from `Bun.randomUUIDv7()`; the nil UUID is allowed).
   */
  uuid?: boolean;
  /** The string must parse as JSON. */
  json?: boolean;
  /** The string must be a phone number: an optional `+`, 7–15 digits; spaces, hyphens and parentheses are allowed. */
  phone?: boolean;

  // ── Numbers ──────────────────────────────────────────────────────────────

  /** The number is not less than this value. */
  min?: number;
  /** The number is not greater than this value. */
  max?: number;
  /** The number is in the `[min, max]` range (inclusive). */
  range?: readonly [number, number];
  /** The number is strictly greater than zero. */
  positive?: boolean;
  /** The number is strictly less than zero. */
  negative?: boolean;
  /** The number must be an integer. */
  integer?: boolean;

  // ── Boolean ──────────────────────────────────────────────────────────────

  /** The value must be exactly `true` (for example, accepting terms). */
  mustBeTrue?: boolean;
  /** The value must be exactly `false`. */
  mustBeFalse?: boolean;

  // ── Enum ─────────────────────────────────────────────────────────────────

  /**
   * Enum object whose values must include the field value.
   * TypeScript string and numeric enums are supported (reverse keys of numeric
   * enums are ignored).
   */
  enumType?: Record<string, string | number>;
}
