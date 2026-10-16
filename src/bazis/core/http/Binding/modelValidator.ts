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
  /**
   * Placeholder values of a message built from the engine template for `code`:
   * the error handler re-renders it in the application language. Absent when
   * the message is the rule's own text (`@Validator({ message })`).
   */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ModelValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly ModelValidationIssue[];
}

export interface ModelValidator {
  validate(instance: object): ModelValidationResult;
  /** Async rules (custom checks returning a Promise). HTTP binding prefers it when present. */
  validateAsync?(instance: object): Promise<ModelValidationResult>;
  /**
   * Text of a message the binder writes itself (`type`, `unknownField`,
   * `validationFailed`) in the engine's current language; without it the
   * binder uses English.
   */
  message?(code: string, params: Readonly<Record<string, unknown>>): string;
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
