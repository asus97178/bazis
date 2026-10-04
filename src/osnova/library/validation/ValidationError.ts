/**
 * Одна ошибка валидации: какое поле, какое значение и почему не прошло.
 *
 * Экземпляры создаются движком валидации, но их можно создавать и вручную —
 * например, возвращать из `custom`-функции, чтобы полностью контролировать
 * `code` и `message`:
 *
 * ```ts
 * @Validator({
 *   custom: (value) =>
 *     isReserved(value)
 *       ? new ValidationError("username", value, "Имя зарезервировано", "reserved")
 *       : true,
 * })
 * username!: string;
 * ```
 */
export class ValidationError {
  /**
   * @param property Имя поля. Для вложенных объектов — путь через точку
   *   (`address.city`), для массивов — с индексом (`items[2].name`).
   * @param value Фактическое значение поля на момент проверки.
   * @param message Человекочитаемое сообщение (уже с подставленными плейсхолдерами).
   * @param code Машиночитаемый код правила, например `"required"` или `"minLength"`.
   */
  constructor(
    readonly property: string,
    readonly value: unknown,
    readonly message: string,
    readonly code?: string,
  ) {}

  /** Краткое представление вида `property: message` — удобно для логов. */
  toString(): string {
    return `${this.property}: ${this.message}`;
  }
}
