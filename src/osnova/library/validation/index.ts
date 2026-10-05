/**
 * Модуль валидации классов Osnova.
 *
 * Самодостаточный (только Bun API), без рефлексии и внешних зависимостей,
 * совместим с компиляцией в бинарник (`bun build --compile`).
 *
 * Точка входа — {@link Validator}: декоратор полей и статические методы
 * `validate` / `validateAsync` / `setDefaultMessages`.
 */
export { Validator } from "./Validator";
export { modelValidatorAdapter } from "./modelValidatorAdapter";
export { ValidationError } from "./ValidationError";
export { ValidationResult } from "./ValidationResult";
export { MessageRegistry, RU_VALIDATION_MESSAGES, type MessageParams } from "./MessageRegistry";
export { ValidationCodes, type ValidationCode } from "./types/ValidationCode";
export type { CustomOutcome, CustomValidator, ValidationTypeHint, ValidatorOptions } from "./types/ValidatorOptions";
