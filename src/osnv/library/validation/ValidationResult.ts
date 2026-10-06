import type { ValidationError } from "./ValidationError";

const NO_ERRORS: readonly ValidationError[] = Object.freeze([]);

/**
 * Validation outcome of an instance: all errors found at once.
 *
 * The engine does not stop at the first error: `errors` holds the full list of
 * problems across all fields, including nested objects.
 *
 * ```ts
 * const result = Validator.validate(dto);
 * if (!result.isValid) {
 *   for (const error of result.getErrorsFor("email")) console.log(error.message);
 * }
 * ```
 */
export class ValidationResult {
  /**
   * "Field -> errors" index, built lazily on the first `getErrorsFor`/`hasErrorsFor`
   * call so a valid object pays no allocations (the hot path is `isValid === true`).
   */
  private index?: Map<string, ValidationError[]>;

  /** @param errors All errors collected in one validation pass. */
  constructor(readonly errors: readonly ValidationError[]) {}

  /** `true` if no rule is violated. */
  get isValid(): boolean {
    return this.errors.length === 0;
  }

  /**
   * Errors of a specific field. For nested fields pass the full path:
   * `getErrorsFor("address.city")`.
   *
   * @returns The field's errors; an empty (frozen, shared) array if there are none.
   */
  getErrorsFor(property: string): readonly ValidationError[] {
    return this.buildIndex().get(property) ?? NO_ERRORS;
  }

  /** Whether the `property` field has at least one error. */
  hasErrorsFor(property: string): boolean {
    return this.buildIndex().has(property);
  }

  private buildIndex(): Map<string, ValidationError[]> {
    if (!this.index) {
      const index = new Map<string, ValidationError[]>();
      for (const error of this.errors) {
        const bucket = index.get(error.property);
        if (bucket) {
          bucket.push(error);
        } else {
          index.set(error.property, [error]);
        }
      }
      this.index = index;
    }
    return this.index;
  }
}
