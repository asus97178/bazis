import type { ValidationError } from "./ValidationError";

const NO_ERRORS: readonly ValidationError[] = Object.freeze([]);

/**
 * Итог валидации экземпляра: все найденные ошибки разом.
 *
 * Движок не останавливается на первой ошибке — `errors` содержит полный
 * список проблем по всем полям, включая вложенные объекты.
 *
 * ```ts
 * const result = Validator.validate(dto);
 * if (!result.isValid) {
 *   for (const error of result.getErrorsFor("email")) console.log(error.message);
 * }
 * ```
 */
export class ValidationResult {
  /**
   * Индекс «поле -> ошибки», строится лениво при первом обращении к
   * `getErrorsFor`/`hasErrorsFor`, чтобы не платить аллокациями за
   * валидный объект (горячий путь — `isValid === true`).
   */
  private index?: Map<string, ValidationError[]>;

  /** @param errors Все ошибки, собранные за один проход валидации. */
  constructor(readonly errors: readonly ValidationError[]) {}

  /** `true`, если ни одно правило не нарушено. */
  get isValid(): boolean {
    return this.errors.length === 0;
  }

  /**
   * Ошибки конкретного поля. Для вложенных полей указывайте полный путь:
   * `getErrorsFor("address.city")`.
   *
   * @returns Массив ошибок поля; пустой (замороженный, общий) массив, если ошибок нет.
   */
  getErrorsFor(property: string): readonly ValidationError[] {
    return this.buildIndex().get(property) ?? NO_ERRORS;
  }

  /** Есть ли хотя бы одна ошибка у поля `property`. */
  hasErrorsFor(property: string): boolean {
    return this.buildIndex().has(property);
  }

  private buildIndex(): Map<string, ValidationError[]> {
    if (!this.index) {
      const index = new Map<string, ValidationError[]>();
      for (const error of this.errors) {
        const bucket = index.get(error.property);
        if (bucket) {
          bucket.push(error);
        } else {
          index.set(error.property, [error]);
        }
      }
      this.index = index;
    }
    return this.index;
  }
}
