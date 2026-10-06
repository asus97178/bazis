/**
 * Validation error codes.
 *
 * A code uniquely identifies the rule that failed. The message template is
 * picked by code: the decorator's local `message` > global
 * (`Validator.setDefaultMessages`) > the built-in default.
 */
export const ValidationCodes = {
  /** The value is missing (`undefined` or `null`) but the field is required. */
  required: "required",
  /** The string or array is empty but the rule requires a non-empty one. */
  notEmpty: "notEmpty",
  /** The string is shorter than the minimum. */
  minLength: "minLength",
  /** The string is longer than the maximum. */
  maxLength: "maxLength",
  /** The string length is outside `length: [min, max]`. */
  length: "length",
  /** The array has fewer items than `minLength`. */
  minItems: "minItems",
  /** The array has more items than `maxLength`. */
  maxItems: "maxItems",
  /** The array item count is outside `length: [min, max]`. */
  itemCount: "itemCount",
  /** The string does not contain the required substring. */
  contains: "contains",
  /** The string contains a forbidden substring. */
  notContains: "notContains",
  /** The string does not match the regular expression. */
  pattern: "pattern",
  /** The string is not a valid email address. */
  email: "email",
  /** The string is not a valid URL. */
  url: "url",
  /** The string is not a valid UUID. */
  uuid: "uuid",
  /** The value has the wrong type (see `{expected}` / `{actual}`). */
  type: "type",
  /** The number is below the minimum. */
  min: "min",
  /** The number is above the maximum. */
  max: "max",
  /** The number is outside `range: [min, max]`. */
  range: "range",
  /** The number is not positive. */
  positive: "positive",
  /** The number is not negative. */
  negative: "negative",
  /** The number is not an integer. */
  integer: "integer",
  /** The boolean value is not `true`. */
  mustBeTrue: "mustBeTrue",
  /** The boolean value is not `false`. */
  mustBeFalse: "mustBeFalse",
  /** The value is not in the `enumType` enumeration. */
  enum: "enum",
  /** The string does not parse as JSON. */
  json: "json",
  /** The string is not a valid phone number. */
  phone: "phone",
  /** The value is not a valid date. */
  date: "date",
  /** The `custom` check returned `false` or a string. */
  custom: "custom",
  /** The `custom` check (or `validateIf`) threw an exception. */
  customError: "customError",
  /**
   * An async `custom` check was called through the synchronous `validate()`.
   * Use `Validator.validateAsync()`.
   */
  asyncCustomInSyncCall: "asyncCustomInSyncCall",
} as const;

/** Union type of all built-in error codes. */
export type ValidationCode = (typeof ValidationCodes)[keyof typeof ValidationCodes];
