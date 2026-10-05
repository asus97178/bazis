import { MessageRegistry } from "./MessageRegistry";
import { RuleCompiler, type CompiledRule } from "./RuleCompiler";
import { ValidationError } from "./ValidationError";
import { ValidationResult } from "./ValidationResult";
import { hasRules } from "./metadata";
import { ValidationCodes } from "./types/ValidationCode";
import type { CustomOutcome, ValidatorOptions } from "./types/ValidatorOptions";

/** Email проверяется линейными проходами; пробелы запрещены в обеих частях. */
const EMAIL_WHITESPACE_PATTERN = /\s/;

/**
 * UUID версий 1–8 (включая v4 из `crypto.randomUUID()` и v7 из
 * `Bun.randomUUIDv7()`) с корректным вариантом, плюс nil-UUID.
 * Только классы символов — без бэктрекинга.
 */
const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

/** Телефон после нормализации: опциональный `+` и 7–15 цифр. */
const PHONE_PATTERN = /^\+?\d{7,15}$/;

/** Символы, отбрасываемые при нормализации телефона: пробелы, дефисы, скобки. */
const PHONE_NOISE = /[\s\-()]/g;

/** Отложенная асинхронная проверка (custom-функция, ждущая await). */
type AsyncJob = () => Promise<void>;

/**
 * Движок валидации: один проход по скомпилированному плану класса.
 *
 * Принципы:
 * - ошибки собираются в один массив; проверки содержимого строки пропускаются
 *   при превышении верхней границы длины этого же декоратора;
 * - горячий путь (валидный объект) почти не аллоцирует: план закэширован,
 *   объекты параметров сообщений создаются только при ошибке;
 * - исключения из пользовательских функций (`custom`, `validateIf`)
 *   перехватываются и превращаются в ошибку с кодом `customError` —
 *   валидация продолжается;
 * - вложенные объекты проверяются рекурсивно с защитой от циклических ссылок.
 */
export class RuleEngine {
  /**
   * Синхронная валидация. Если у поля асинхронная `custom`-функция
   * (вернула Promise) — добавляется ошибка `asyncCustomInSyncCall`.
   */
  static validate(instance: object): ValidationResult {
    const errors: ValidationError[] = [];
    RuleEngine.collect(instance, "", errors, undefined, undefined);
    return new ValidationResult(errors);
  }

  /**
   * Асинхронная валидация: все синхронные правила выполняются сразу,
   * асинхронные `custom`-функции — последовательно после них
   * (детерминированный порядок ошибок).
   */
  static async validateAsync(instance: object): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const jobs: AsyncJob[] = [];
    RuleEngine.collect(instance, "", errors, jobs, undefined);
    for (const job of jobs) {
      await job();
    }
    return new ValidationResult(errors);
  }

  /** Прогоняет план класса экземпляра; без декораторов — молча выходит. */
  private static collect(
    instance: object,
    prefix: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    const plan = RuleCompiler.planFor(instance.constructor);
    if (!plan) {
      return;
    }
    for (const rule of plan) {
      RuleEngine.applyRule(rule, instance, prefix, errors, jobs, seen);
    }
  }

  private static applyRule(
    rule: CompiledRule,
    instance: object,
    prefix: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    const o = rule.options;
    const path = prefix === "" ? rule.property : `${prefix}.${rule.property}`;

    // 1. Условная валидация: false -> весь декоратор пропускается.
    if (o.validateIf !== undefined) {
      try {
        if (!(o.validateIf as (instance: unknown) => boolean)(instance)) {
          return;
        }
      } catch (error) {
        RuleEngine.fail(errors, ValidationCodes.customError, path, undefined, o, { error: RuleEngine.describeError(error) });
        return;
      }
    }

    const value = (instance as Record<string, unknown>)[rule.property];

    // 2. Отсутствующее значение: ошибка только при required, иначе поле опционально.
    if (value === undefined || value === null) {
      if (o.required === true) {
        RuleEngine.fail(errors, ValidationCodes.required, path, value, o, undefined);
      }
      return;
    }

    // 3. Строковые правила: сначала единая проверка типа, потом сами правила.
    if (rule.needsString) {
      if (typeof value !== "string") {
        RuleEngine.failType(errors, path, value, o, "string");
        return;
      }
      RuleEngine.applyStringRules(rule, value, path, errors);
    }

    // 4. Числовые правила.
    if (rule.needsNumber) {
      if (typeof value !== "number" || Number.isNaN(value)) {
        RuleEngine.failType(errors, path, value, o, "number");
        return;
      }
      RuleEngine.applyNumberRules(o, value, path, errors);
    }

    // 5. Boolean-правила.
    if (rule.needsBoolean) {
      if (typeof value !== "boolean") {
        RuleEngine.failType(errors, path, value, o, "boolean");
        return;
      }
      if (o.mustBeTrue === true && value !== true) {
        RuleEngine.fail(errors, ValidationCodes.mustBeTrue, path, value, o, undefined);
      }
      if (o.mustBeFalse === true && value !== false) {
        RuleEngine.fail(errors, ValidationCodes.mustBeFalse, path, value, o, undefined);
      }
    }

    // 6. Enum: членство в предвычисленном Set (O(1)).
    if (rule.enumValues !== undefined && !rule.enumValues.has(value)) {
      RuleEngine.fail(errors, ValidationCodes.enum, path, value, o, { allowed: rule.enumLabel });
    }

    // 7. Дата (подсказка type: "date").
    if (rule.checkDate && !RuleEngine.isValidDate(value)) {
      RuleEngine.fail(errors, ValidationCodes.date, path, value, o, undefined);
    }

    // 8. Пользовательская проверка.
    if (o.custom !== undefined) {
      RuleEngine.applyCustom(o, value, instance, path, errors, jobs);
    }

    // 9. Вложенная валидация — только правило-носитель (см. RuleCompiler),
    // чтобы несколько декораторов на поле не дублировали ошибки.
    if (rule.nested !== "none") {
      RuleEngine.applyNested(rule.nested === "explicit", value, instance, path, errors, jobs, seen);
    }
  }

  private static applyStringRules(rule: CompiledRule, value: string, path: string, errors: ValidationError[]): void {
    const o = rule.options;
    if (o.notEmpty === true && value.length === 0) {
      RuleEngine.fail(errors, ValidationCodes.notEmpty, path, value, o, undefined);
    }
    if (o.minLength !== undefined && value.length < o.minLength) {
      RuleEngine.fail(errors, ValidationCodes.minLength, path, value, o, { min: o.minLength });
    }
    const exceedsMaxLength = o.maxLength !== undefined && value.length > o.maxLength;
    if (exceedsMaxLength) {
      RuleEngine.fail(errors, ValidationCodes.maxLength, path, value, o, { max: o.maxLength });
    }
    const exceedsLengthRange = o.length !== undefined && value.length > o.length[1];
    if (o.length !== undefined && (value.length < o.length[0] || value.length > o.length[1])) {
      RuleEngine.fail(errors, ValidationCodes.length, path, value, o, { min: o.length[0], max: o.length[1] });
    }
    // Верхняя граница ограничивает вход RegExp/парсеров. Проверки других полей,
    // декораторов и custom сохраняют прежний порядок и сбор ошибок.
    if (exceedsMaxLength || exceedsLengthRange) {
      return;
    }
    if (o.contains !== undefined && !value.includes(o.contains)) {
      RuleEngine.fail(errors, ValidationCodes.contains, path, value, o, { contains: o.contains });
    }
    if (o.notContains !== undefined && value.includes(o.notContains)) {
      RuleEngine.fail(errors, ValidationCodes.notContains, path, value, o, { contains: o.notContains });
    }
    if (rule.pattern !== undefined && !rule.pattern.test(value)) {
      RuleEngine.fail(errors, ValidationCodes.pattern, path, value, o, { pattern: rule.pattern.source });
    }
    if (rule.checkEmail && !RuleEngine.isEmail(value)) {
      RuleEngine.fail(errors, ValidationCodes.email, path, value, o, undefined);
    }
    if (rule.checkUrl && !URL.canParse(value)) {
      RuleEngine.fail(errors, ValidationCodes.url, path, value, o, undefined);
    }
    if (rule.checkUuid && !UUID_PATTERN.test(value)) {
      RuleEngine.fail(errors, ValidationCodes.uuid, path, value, o, undefined);
    }
    if (rule.checkJson && !RuleEngine.isJson(value)) {
      RuleEngine.fail(errors, ValidationCodes.json, path, value, o, undefined);
    }
    if (rule.checkPhone && !PHONE_PATTERN.test(value.replace(PHONE_NOISE, ""))) {
      RuleEngine.fail(errors, ValidationCodes.phone, path, value, o, undefined);
    }
  }

  private static applyNumberRules(o: ValidatorOptions, value: number, path: string, errors: ValidationError[]): void {
    if (o.min !== undefined && value < o.min) {
      RuleEngine.fail(errors, ValidationCodes.min, path, value, o, { min: o.min });
    }
    if (o.max !== undefined && value > o.max) {
      RuleEngine.fail(errors, ValidationCodes.max, path, value, o, { max: o.max });
    }
    if (o.range !== undefined && (value < o.range[0] || value > o.range[1])) {
      RuleEngine.fail(errors, ValidationCodes.range, path, value, o, { min: o.range[0], max: o.range[1] });
    }
    if (o.positive === true && value <= 0) {
      RuleEngine.fail(errors, ValidationCodes.positive, path, value, o, undefined);
    }
    if (o.negative === true && value >= 0) {
      RuleEngine.fail(errors, ValidationCodes.negative, path, value, o, undefined);
    }
    if (o.integer === true && !Number.isInteger(value)) {
      RuleEngine.fail(errors, ValidationCodes.integer, path, value, o, undefined);
    }
  }

  /**
   * Пользовательская проверка. В синхронном режиме Promise — это ошибка
   * `asyncCustomInSyncCall`; в асинхронном проверка откладывается в очередь.
   */
  private static applyCustom(
    o: ValidatorOptions,
    value: unknown,
    instance: object,
    path: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
  ): void {
    const custom = o.custom!;
    if (jobs !== undefined) {
      jobs.push(async () => {
        try {
          RuleEngine.handleCustomOutcome(await custom(value, instance), o, value, path, errors);
        } catch (error) {
          RuleEngine.fail(errors, ValidationCodes.customError, path, value, o, { error: RuleEngine.describeError(error) });
        }
      });
      return;
    }
    try {
      const outcome = custom(value, instance);
      if (outcome instanceof Promise) {
        // Незавершённый Promise нельзя «дождаться» синхронно; молча считать
        // поле валидным было бы небезопасно — фиксируем ошибку использования.
        outcome.catch(() => {});
        RuleEngine.fail(errors, ValidationCodes.asyncCustomInSyncCall, path, value, o, undefined);
        return;
      }
      RuleEngine.handleCustomOutcome(outcome, o, value, path, errors);
    } catch (error) {
      RuleEngine.fail(errors, ValidationCodes.customError, path, value, o, { error: RuleEngine.describeError(error) });
    }
  }

  private static handleCustomOutcome(
    outcome: CustomOutcome,
    o: ValidatorOptions,
    value: unknown,
    path: string,
    errors: ValidationError[],
  ): void {
    if (outcome === true || outcome === undefined) {
      return;
    }
    if (outcome instanceof ValidationError) {
      errors.push(outcome);
      return;
    }
    if (typeof outcome === "string") {
      // Возвращённая строка — самое локальное сообщение, приоритетнее message.
      errors.push(new ValidationError(path, value, MessageRegistry.format(ValidationCodes.custom, outcome, { property: path, value }), ValidationCodes.custom));
      return;
    }
    RuleEngine.fail(errors, ValidationCodes.custom, path, value, o, undefined);
  }

  /**
   * Вложенная валидация. Включается явным `nested: true` либо автоматически,
   * когда значение (или элемент массива) — экземпляр класса с декораторами.
   * Защита от циклов: посещённые объекты в цепочке пропускаются.
   */
  private static applyNested(
    explicit: boolean,
    value: unknown,
    instance: object,
    path: string,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (item !== null && typeof item === "object" && (explicit || hasRules(item))) {
          RuleEngine.nest(item as object, `${path}[${index}]`, instance, errors, jobs, seen);
        }
      }
      return;
    }
    if (value !== null && typeof value === "object" && (explicit || hasRules(value))) {
      RuleEngine.nest(value as object, path, instance, errors, jobs, seen);
    }
  }

  private static nest(
    child: object,
    path: string,
    parent: object,
    errors: ValidationError[],
    jobs: AsyncJob[] | undefined,
    seen: Set<object> | undefined,
  ): void {
    // Set создаётся лениво — только когда вложенность реально встретилась.
    const visited = seen ?? new Set<object>([parent]);
    if (visited.has(child)) {
      return;
    }
    visited.add(child);
    RuleEngine.collect(child, path, errors, jobs, visited);
  }

  // ── Вспомогательные методы ────────────────────────────────────────────────

  /** Создаёт ValidationError с сообщением по приоритету local > global > built-in. */
  private static fail(
    errors: ValidationError[],
    code: string,
    path: string,
    value: unknown,
    o: ValidatorOptions,
    extra: Record<string, unknown> | undefined,
  ): void {
    const params: Record<string, unknown> = { property: path, value };
    if (extra !== undefined) {
      for (const key of Object.keys(extra)) {
        params[key] = extra[key];
      }
    }
    errors.push(new ValidationError(path, value, MessageRegistry.format(code, o.message, params), code));
  }

  private static failType(errors: ValidationError[], path: string, value: unknown, o: ValidatorOptions, expected: string): void {
    const actual = typeof value === "number" && Number.isNaN(value) ? "NaN" : value === null ? "null" : typeof value;
    RuleEngine.fail(errors, ValidationCodes.type, path, value, o, { expected, actual });
  }

  private static isJson(value: string): boolean {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }

  private static isEmail(value: string): boolean {
    const at = value.indexOf("@");
    if (at <= 0 || at !== value.lastIndexOf("@") || EMAIL_WHITESPACE_PATTERN.test(value)) {
      return false;
    }
    // Сохраняет прежнюю грамматику: по одному символу до/после разделяющей
    // точки домена; дополнительные точки допустимы, как в исходном pattern.
    const dot = value.indexOf(".", at + 2);
    return dot !== -1 && dot < value.length - 1;
  }

  private static isValidDate(value: unknown): boolean {
    if (value instanceof Date) {
      return !Number.isNaN(value.getTime());
    }
    if (typeof value === "string" || typeof value === "number") {
      return !Number.isNaN(new Date(value).getTime());
    }
    return false;
  }

  private static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
