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

export interface ModelValidator {
  validate(instance: object): { readonly isValid: boolean; readonly errors: readonly ModelValidationIssue[] };
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
