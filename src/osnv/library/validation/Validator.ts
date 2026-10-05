import { MessageRegistry } from "./MessageRegistry";
import { RuleEngine } from "./RuleEngine";
import type { ValidationResult } from "./ValidationResult";
import { registerFieldRule } from "./metadata";
import type { ValidatorOptions } from "./types/ValidatorOptions";

/**
 * Декоратор поля: регистрирует правила валидации в метаданных класса.
 * Используются стандартные TC39-декораторы (нативно выполняются Bun) —
 * без `experimentalDecorators`, `emitDecoratorMetadata` и `reflect-metadata`,
 * поэтому модуль свободно компилируется в бинарник (`bun build --compile`).
 */
type FieldDecorator = (value: undefined, context: ClassFieldDecoratorContext) => void;

function createFieldDecorator(options: ValidatorOptions): FieldDecorator {
  return (_value, context) => {
    registerFieldRule(context, options);
  };
}

/**
 * Единая точка входа модуля валидации.
 *
 * Одновременно и декоратор, и «статический класс»:
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
 * Гарантии:
 * - правила класса собираются и компилируются один раз (WeakMap-кэш),
 *   повторные вызовы `validate` ничего не пересобирают;
 * - все ошибки собираются за один проход — валидация не останавливается
 *   на первой;
 * - исключения в `custom`/`validateIf` перехватываются (код `customError`),
 *   валидация продолжается;
 * - значения читаются только по именам полей, объявленным декораторами,
 *   служебные ключи (`__proto__` и т.п.) не обходятся — защита от
 *   prototype pollution.
 */
export const Validator = Object.assign(
  /**
   * `@Validator(options)` — вешается на поле класса. На одно поле можно
   * повесить несколько декораторов, выполняются все.
   */
  (options: ValidatorOptions): FieldDecorator => createFieldDecorator(options),
  {
    /**
     * Синхронная валидация экземпляра.
     *
     * Асинхронные `custom`-функции здесь не поддерживаются: если функция
     * вернула Promise, в результат добавляется ошибка с кодом
     * `asyncCustomInSyncCall` (используйте {@link Validator.validateAsync}).
     *
     * @param instance Экземпляр класса с декораторами `@Validator`.
     *   Объект без декораторов считается валидным.
     */
    validate(instance: object): ValidationResult {
      return RuleEngine.validate(instance);
    },

    /**
     * Асинхронная валидация: ждёт все асинхронные `custom`-функции.
     * Синхронные правила выполняются немедленно, порядок ошибок детерминирован.
     */
    validateAsync(instance: object): Promise<ValidationResult> {
      return RuleEngine.validateAsync(instance);
    },

    /**
     * Глобально переопределяет стандартные сообщения об ошибках.
     * Поддерживаются плейсхолдеры `{property}`, `{value}`, `{min}`, `{max}`,
     * `{pattern}`, `{contains}`, `{allowed}`, `{expected}`, `{actual}`.
     *
     * Приоритет: локальный `message` декоратора > заданные здесь > встроенные.
     *
     * ```ts
     * Validator.setDefaultMessages({
     *   required: "Поле {property} обязательно для заполнения",
     *   minLength: "Минимальная длина {min} символов",
     * });
     * ```
     */
    setDefaultMessages(messages: Partial<Record<string, string>>): void {
      MessageRegistry.setDefaults(messages);
    },

    /** Сбрасывает глобальные сообщения к встроенным (удобно в тестах). */
    resetDefaultMessages(): void {
      MessageRegistry.reset();
    },
  },
);
