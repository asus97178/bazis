/**
 * Request-model validation port (dependency inversion).
 *
 * `@/core/http` (the kernel) defines the abstraction but knows nothing about a
 * concrete validation engine. The `@/library/validation` library implements it;
 * the composition root (`runApp`) or a test registers the adapter through
 * {@link useModelValidator}. Without a registered validator the bound body is
 * not validated.
 */
export interface ModelValidationIssue {
  readonly property: string;
  readonly message: string;
  readonly code?: string;
}

export interface ModelValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly ModelValidationIssue[];
}

export interface ModelValidator {
  validate(instance: object): ModelValidationResult;
  /** Async rules (custom checks returning a Promise). HTTP binding prefers it when present. */
  validateAsync?(instance: object): Promise<ModelValidationResult>;
  /** Text for a JSON value of the wrong type; without it the binder uses its English default. */
  typeMismatchMessage?(property: string, expected: string, actual: string): string;
  /** Title of a 400 validation response; without it "Validation failed". */
  failureTitle?(): string;
}

let activeValidator: ModelValidator | undefined;

/** Plugs in a concrete validator (bridge from `@/library/validation`). Idempotent. */
export function useModelValidator(validator: ModelValidator): void {
  activeValidator = validator;
}

/** The current validator, or `undefined` if none is plugged in. */
export function getModelValidator(): ModelValidator | undefined {
  return activeValidator;
}
