/**
 * Порт валидации request-моделей (Dependency Inversion).
 *
 * `@/core/http` (ядро) определяет абстракцию, но не знает о конкретном движке
 * валидации. Библиотека `@/library/validation` реализует её и регистрирует адаптер
 * через {@link useModelValidator} (вызывается в композиционном корне —
 * `createApp` — или в тестах). Без зарегистрированного валидатора привязка тела
 * не валидируется.
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

/** Подключить конкретный валидатор (мост из `@/library/validation`). Идемпотентно. */
export function useModelValidator(validator: ModelValidator): void {
  activeValidator = validator;
}

/** Текущий валидатор или `undefined`, если не подключён. */
export function getModelValidator(): ModelValidator | undefined {
  return activeValidator;
}
