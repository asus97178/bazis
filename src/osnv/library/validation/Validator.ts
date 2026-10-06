import { MessageRegistry } from "./MessageRegistry";
import { RuleEngine } from "./RuleEngine";
import type { ValidationResult } from "./ValidationResult";
import { registerFieldRule } from "./metadata";
import type { ValidatorOptions } from "./types/ValidatorOptions";

/**
 * Field decorator: registers validation rules in the class metadata.
 * Uses standard TC39 decorators (run natively by Bun), without
 * `experimentalDecorators`, `emitDecoratorMetadata` or `reflect-metadata`,
 * so the module compiles into a binary (`bun build --compile`).
 */
type FieldDecorator = (value: undefined, context: ClassFieldDecoratorContext) => void;

function createFieldDecorator(options: ValidatorOptions): FieldDecorator {
  return (_value, context) => {
    registerFieldRule(context, options);
  };
}

/**
 * The single entry point of the validation module.
 *
 * Both a decorator and a "static class":
 *
 * ```ts
 * class CreateUserDto {
 *   @Validator({ required: true, minLength: 3, maxLength: 50 })
 *   username!: string;
 *
 *   @Validator({ required: true, email: true })
 *   email!: string;
 * }
 *
 * const result = Validator.validate(new CreateUserDto());
 * if (!result.isValid) console.log(result.errors);
 * ```
 *
 * Guarantees:
 * - class rules are collected and compiled once (WeakMap cache), repeated
 *   `validate` calls rebuild nothing;
 * - all errors are collected in one pass; validation does not stop at the first;
 * - exceptions in `custom`/`validateIf` are caught (code `customError`) and
 *   validation continues;
 * - values are read only by the field names declared by decorators; service
 *   keys (`__proto__` and so on) are never traversed, which protects against
 *   prototype pollution.
 */
export const Validator = Object.assign(
  /**
   * `@Validator(options)` goes on a class field. A field may have several
   * decorators; all of them run.
   */
  (options: ValidatorOptions): FieldDecorator => createFieldDecorator(options),
  {
    /**
     * Synchronous validation of an instance.
     *
     * Async `custom` functions are not supported here: if a function returns a
     * Promise, an error with the `asyncCustomInSyncCall` code is added to the
     * result (use {@link Validator.validateAsync}).
     *
     * @param instance Instance of a class with `@Validator` decorators.
     *   An object without decorators is valid.
     */
    validate(instance: object): ValidationResult {
      return RuleEngine.validate(instance);
    },

    /**
     * Asynchronous validation: awaits all async `custom` functions.
     * Synchronous rules run immediately; the error order is deterministic.
     */
    validateAsync(instance: object): Promise<ValidationResult> {
      return RuleEngine.validateAsync(instance);
    },

    /**
     * Globally overrides the standard error messages.
     * Supported placeholders: `{property}`, `{value}`, `{min}`, `{max}`,
     * `{pattern}`, `{contains}`, `{allowed}`, `{expected}`, `{actual}`.
     *
     * Priority: the decorator's local `message` > the ones set here > built-in.
     *
     * ```ts
     * Validator.setDefaultMessages({
     *   required: "{property} is required",
     *   minLength: "At least {min} characters",
     * });
     * ```
     */
    setDefaultMessages(messages: Partial<Record<string, string>>): void {
      MessageRegistry.setDefaults(messages);
    },

    /** Resets global messages to the built-in ones (handy in tests). */
    resetDefaultMessages(): void {
      MessageRegistry.reset();
    },
  },
);
