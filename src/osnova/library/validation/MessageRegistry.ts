/**
 * Параметры для подстановки в плейсхолдеры сообщения.
 * Ключ — имя плейсхолдера без скобок: `{min}` -> `min`.
 */
export type MessageParams = Readonly<Record<string, unknown>>;

/** Встроенные сообщения по умолчанию (русский язык). */
const BUILT_IN: Readonly<Record<string, string>> = {
  required: 'Поле "{property}" обязательно для заполнения',
  notEmpty: 'Поле "{property}" не должно быть пустым',
  minLength: 'Поле "{property}" должно содержать не менее {min} символов',
  maxLength: 'Поле "{property}" должно содержать не более {max} символов',
  length: 'Поле "{property}" должно содержать от {min} до {max} символов',
  contains: 'Поле "{property}" должно содержать "{contains}"',
  notContains: 'Поле "{property}" не должно содержать "{contains}"',
  pattern: 'Поле "{property}" не соответствует формату {pattern}',
  email: 'Поле "{property}" должно быть корректным email-адресом',
  url: 'Поле "{property}" должно быть корректным URL',
  uuid: 'Поле "{property}" должно быть корректным UUID',
  type: 'Поле "{property}" должно иметь тип {expected}, получено: {actual}',
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
};

/**
 * Реестр шаблонов сообщений об ошибках.
 *
 * Приоритет шаблона: локальный `message` декоратора > глобальный
 * (`setDefaults`) > встроенный. Плейсхолдеры вида `{name}` заменяются
 * значениями из параметров ошибки; неизвестные плейсхолдеры остаются
 * как есть (без исключений — отказоустойчивость важнее строгости).
 */
export class MessageRegistry {
  /** Текущие глобальные шаблоны: копия встроенных + переопределения. */
  private static defaults: Record<string, string> = { ...BUILT_IN };

  /**
   * Переопределяет глобальные сообщения для кодов ошибок.
   * Неизвестные коды тоже принимаются — это позволяет задавать сообщения
   * для собственных кодов из `custom`-функций.
   */
  static setDefaults(messages: Partial<Record<string, string>>): void {
    for (const code of Object.keys(messages)) {
      // hasOwnProperty: защита от prototype pollution через переданный объект.
      if (!Object.prototype.hasOwnProperty.call(messages, code)) {
        continue;
      }
      const template = messages[code];
      if (typeof template === "string") {
        MessageRegistry.defaults[code] = template;
      }
    }
  }

  /** Сбрасывает все глобальные переопределения к встроенным сообщениям. */
  static reset(): void {
    MessageRegistry.defaults = { ...BUILT_IN };
  }

  /**
   * Строит итоговое сообщение для кода ошибки.
   *
   * @param code Код правила (например, `minLength`).
   * @param localMessage Локальный `message` из опций декоратора (приоритетен).
   * @param params Значения плейсхолдеров.
   */
  static format(code: string, localMessage: string | undefined, params: MessageParams): string {
    const template =
      localMessage ??
      (Object.prototype.hasOwnProperty.call(MessageRegistry.defaults, code)
        ? MessageRegistry.defaults[code]!
        : 'Поле "{property}" не прошло проверку ({code})');
    return MessageRegistry.interpolate(template, params);
  }

  private static interpolate(template: string, params: MessageParams): string {
    return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === undefined) {
        return placeholder;
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
