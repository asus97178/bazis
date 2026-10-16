/**
 * Parameters substituted into message placeholders.
 * The key is the placeholder name without braces: `{min}` -> `min`.
 */
export type MessageParams = Readonly<Record<string, unknown>>;

/** Built-in default messages (English). */
export const EN_VALIDATION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  validationFailed: "Validation failed",
  invalid: 'Field "{property}" is invalid ({code})',
  required: 'Field "{property}" is required',
  notEmpty: 'Field "{property}" must not be empty',
  minLength: 'Field "{property}" must be at least {min} characters long',
  maxLength: 'Field "{property}" must be at most {max} characters long',
  length: 'Field "{property}" must be {min} to {max} characters long',
  minItems: 'Field "{property}" must contain at least {min} items',
  maxItems: 'Field "{property}" must contain at most {max} items',
  itemCount: 'Field "{property}" must contain {min} to {max} items',
  contains: 'Field "{property}" must contain "{contains}"',
  notContains: 'Field "{property}" must not contain "{contains}"',
  pattern: 'Field "{property}" does not match the format {pattern}',
  email: 'Field "{property}" must be a valid email address',
  url: 'Field "{property}" must be a valid URL',
  uuid: 'Field "{property}" must be a valid UUID',
  type: 'Field "{property}" must be of type {expected}, got: {actual}',
  min: 'Field "{property}" must be at least {min}',
  max: 'Field "{property}" must be at most {max}',
  range: 'Field "{property}" must be between {min} and {max}',
  positive: 'Field "{property}" must be a positive number',
  negative: 'Field "{property}" must be a negative number',
  integer: 'Field "{property}" must be an integer',
  mustBeTrue: 'Field "{property}" must be true',
  mustBeFalse: 'Field "{property}" must be false',
  enum: 'Field "{property}" must be one of: {allowed}',
  json: 'Field "{property}" must be a valid JSON string',
  phone: 'Field "{property}" must be a valid phone number',
  date: 'Field "{property}" must be a valid date',
  custom: 'Field "{property}" failed a custom check',
  customError: 'Check of field "{property}" failed with an error: {error}',
  asyncCustomInSyncCall:
    'Field "{property}": an async custom check is not supported by synchronous validate(); use validateAsync()',
  unknownField: 'Field "{property}" is forbidden or not declared by the model.',
});
const BUILT_IN = EN_VALIDATION_MESSAGES;

/**
 * Russian texts for every built-in code. An application gets them with
 * `runApp(AppModule, { language: "ru" })`; outside an application:
 * `MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES)`.
 *
 * Numbers stand after a dash ("минимальная длина — 5"), so no template needs
 * a plural form. `typeName.*` keys translate the type names in `type`.
 */
export const RU_VALIDATION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  validationFailed: "Проверка данных не пройдена",
  invalid: 'Поле "{property}" не прошло проверку ({code})',
  required: 'Поле "{property}" обязательно для заполнения',
  notEmpty: 'Поле "{property}" не должно быть пустым',
  minLength: 'Поле "{property}": минимальная длина — {min}',
  maxLength: 'Поле "{property}": максимальная длина — {max}',
  length: 'Поле "{property}": длина — от {min} до {max}',
  minItems: 'Поле "{property}": минимум элементов — {min}',
  maxItems: 'Поле "{property}": максимум элементов — {max}',
  itemCount: 'Поле "{property}": количество элементов — от {min} до {max}',
  contains: 'Поле "{property}" должно содержать "{contains}"',
  notContains: 'Поле "{property}" не должно содержать "{contains}"',
  pattern: 'Поле "{property}" не соответствует формату {pattern}',
  email: 'Поле "{property}" должно быть корректным email-адресом',
  url: 'Поле "{property}" должно быть корректным URL',
  uuid: 'Поле "{property}" должно быть корректным UUID',
  type: 'Поле "{property}": ожидается {expected}, получено: {actual}',
  min: 'Поле "{property}" должно быть не меньше {min}',
  max: 'Поле "{property}" должно быть не больше {max}',
  range: 'Поле "{property}" должно быть в диапазоне от {min} до {max}',
  positive: 'Поле "{property}" должно быть положительным числом',
  negative: 'Поле "{property}" должно быть отрицательным числом',
  integer: 'Поле "{property}" должно быть целым числом',
  mustBeTrue: 'Поле "{property}" должно быть равно true',
  mustBeFalse: 'Поле "{property}" должно быть равно false',
  enum: 'Поле "{property}" должно быть одним из: {allowed}',
  json: 'Поле "{property}" должно быть корректной JSON-строкой',
  phone: 'Поле "{property}" должно быть корректным номером телефона',
  date: 'Поле "{property}" должно быть корректной датой',
  custom: 'Поле "{property}" не прошло пользовательскую проверку',
  customError: 'Проверка поля "{property}" завершилась ошибкой: {error}',
  asyncCustomInSyncCall:
    'Поле "{property}": асинхронная custom-проверка не поддерживается синхронным validate(), используйте validateAsync()',
  unknownField: 'Поле "{property}" запрещено или не объявлено в модели',
  "typeName.string": "строка",
  "typeName.number": "число",
  "typeName.int": "целое число",
  "typeName.boolean": "логическое значение",
  "typeName.bool": "логическое значение",
  "typeName.array": "массив",
  "typeName.object": "объект",
  "typeName.JSON object or array": "объект или массив",
});

/**
 * Registry of error message templates.
 *
 * Template priority: the decorator's local `message` > global (`setDefaults`)
 * > built-in. `{name}` placeholders are replaced with values from the error
 * parameters; unknown placeholders stay as is (no exceptions: resilience
 * matters more than strictness here).
 */
export class MessageRegistry {
  /** Current global templates: a copy of the built-in ones + overrides. */
  private static defaults: Record<string, string> = { ...BUILT_IN };
  /** Only the templates set through {@link setDefaults}. */
  private static overrides: Record<string, string> = {};

  /**
   * Overrides global messages for error codes.
   * Unknown codes are accepted too, so messages can be set for custom codes
   * from `custom` functions.
   */
  static setDefaults(messages: Partial<Record<string, string>>): void {
    for (const code of Object.keys(messages)) {
      // hasOwnProperty: protection against prototype pollution through the given object.
      if (!Object.prototype.hasOwnProperty.call(messages, code)) {
        continue;
      }
      const template = messages[code];
      if (typeof template === "string") {
        MessageRegistry.defaults[code] = template;
        MessageRegistry.overrides[code] = template;
      }
    }
  }

  /** Resets all global overrides to the built-in messages. */
  static reset(): void {
    MessageRegistry.defaults = { ...BUILT_IN };
    MessageRegistry.overrides = {};
  }

  /** A template set through {@link setDefaults}, or `undefined`. */
  static override(code: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(MessageRegistry.overrides, code) ? MessageRegistry.overrides[code] : undefined;
  }

  /**
   * Builds the final message for an error code.
   *
   * @param code Rule code (for example `minLength`).
   * @param localMessage Local `message` from the decorator options (takes priority).
   * @param params Placeholder values.
   */
  static format(code: string, localMessage: string | undefined, params: MessageParams): string {
    const template =
      localMessage ??
      (Object.prototype.hasOwnProperty.call(MessageRegistry.defaults, code)
        ? MessageRegistry.defaults[code]!
        : MessageRegistry.defaults.invalid ?? BUILT_IN.invalid!);
    return MessageRegistry.interpolate(template, params);
  }

  private static interpolate(template: string, params: MessageParams): string {
    return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === undefined) {
        return placeholder;
      }
      const value = params[key];
      if ((key === "expected" || key === "actual") && typeof value === "string") {
        const typeName = MessageRegistry.defaults[`typeName.${value}`];
        if (typeName !== undefined && Object.prototype.hasOwnProperty.call(MessageRegistry.defaults, `typeName.${value}`)) return typeName;
      }
      return MessageRegistry.stringify(params[key]);
    });
  }

  private static stringify(value: unknown): string {
    if (typeof value === "object" && value !== null && !(value instanceof RegExp)) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
}
