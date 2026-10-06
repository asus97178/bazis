/**
 * Class validation module of Bazis.
 *
 * Self-contained (Bun APIs only), with no reflection or external dependencies,
 * compatible with binary compilation (`bun build --compile`).
 *
 * The entry point is {@link Validator}: a field decorator plus the static
 * methods `validate` / `validateAsync` / `setDefaultMessages`.
 */
export { Validator } from "./Validator";
export { modelValidatorAdapter } from "./modelValidatorAdapter";
export { ValidationError } from "./ValidationError";
export { ValidationResult } from "./ValidationResult";
export { MessageRegistry, RU_VALIDATION_MESSAGES, type MessageParams } from "./MessageRegistry";
export { ValidationCodes, type ValidationCode } from "./types/ValidationCode";
export type { CustomOutcome, CustomValidator, ValidationTypeHint, ValidatorOptions } from "./types/ValidatorOptions";
