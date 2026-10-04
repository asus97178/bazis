/**
 * Коды ошибок валидации.
 *
 * Код однозначно идентифицирует правило, которое не прошло проверку.
 * По коду подбирается шаблон сообщения: локальный `message` декоратора >
 * глобальный (`Validator.setDefaultMessages`) > встроенный по умолчанию.
 */
export const ValidationCodes = {
  /** Значение отсутствует (`undefined` или `null`), а поле обязательно. */
  required: "required",
  /** Строка пустая, а правило требует непустую. */
  notEmpty: "notEmpty",
  /** Длина строки меньше минимальной. */
  minLength: "minLength",
  /** Длина строки больше максимальной. */
  maxLength: "maxLength",
  /** Длина строки вне диапазона `length: [min, max]`. */
  length: "length",
  /** Строка не содержит обязательную подстроку. */
  contains: "contains",
  /** Строка содержит запрещённую подстроку. */
  notContains: "notContains",
  /** Строка не соответствует регулярному выражению. */
  pattern: "pattern",
  /** Строка не является корректным email-адресом. */
  email: "email",
  /** Строка не является корректным URL. */
  url: "url",
  /** Строка не является корректным UUID. */
  uuid: "uuid",
  /** Значение имеет неподходящий тип (см. `{expected}` / `{actual}`). */
  type: "type",
  /** Число меньше минимума. */
  min: "min",
  /** Число больше максимума. */
  max: "max",
  /** Число вне диапазона `range: [min, max]`. */
  range: "range",
  /** Число не положительное. */
  positive: "positive",
  /** Число не отрицательное. */
  negative: "negative",
  /** Число не целое. */
  integer: "integer",
  /** Boolean-значение не равно `true`. */
  mustBeTrue: "mustBeTrue",
  /** Boolean-значение не равно `false`. */
  mustBeFalse: "mustBeFalse",
  /** Значение не входит в перечисление `enumType`. */
  enum: "enum",
  /** Строка не парсится как JSON. */
  json: "json",
  /** Строка не является корректным номером телефона. */
  phone: "phone",
  /** Значение не является корректной датой. */
  date: "date",
  /** Пользовательская `custom`-проверка вернула `false` или строку. */
  custom: "custom",
  /** Пользовательская `custom`-проверка (или `validateIf`) бросила исключение. */
  customError: "customError",
  /**
   * Асинхронная `custom`-проверка вызвана через синхронный `validate()`.
   * Используйте `Validator.validateAsync()`.
   */
  asyncCustomInSyncCall: "asyncCustomInSyncCall",
} as const;

/** Тип-объединение всех встроенных кодов ошибок. */
export type ValidationCode = (typeof ValidationCodes)[keyof typeof ValidationCodes];
