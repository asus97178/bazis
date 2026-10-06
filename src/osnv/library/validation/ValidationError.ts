/**
 * One validation error: which field, which value and why it failed.
 *
 * Instances are created by the validation engine, but they can also be created
 * by hand, for example returned from a `custom` function to fully control
 * `code` and `message`:
 *
 * ```ts
 * @Validator({
 *   custom: (value) =>
 *     isReserved(value)
 *       ? new ValidationError("username", value, "This name is reserved", "reserved")
 *       : true,
 * })
 * username!: string;
 * ```
 */
export class ValidationError {
  /**
   * @param property Field name. For nested objects, a dotted path
   *   (`address.city`); for arrays, with an index (`items[2].name`).
   * @param value Actual field value at check time.
   * @param message Human-readable message (placeholders already substituted).
   * @param code Machine-readable rule code, for example `"required"` or `"minLength"`.
   */
  constructor(
    readonly property: string,
    readonly value: unknown,
    readonly message: string,
    readonly code?: string,
  ) {}

  /** Short `property: message` form, handy for logs. */
  toString(): string {
    return `${this.property}: ${this.message}`;
  }
}
