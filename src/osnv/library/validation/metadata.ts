import type { ValidatorOptions } from "./types/ValidatorOptions";

// Полифилл одной строкой: Bun выполняет стандартные TC39-декораторы нативно,
// но Symbol.metadata может отсутствовать в рантайме. Symbol.for даёт общий
// символ для всех копий модуля.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/** Ключ, под которым правила валидации лежат в метаданных класса. */
const FIELD_RULES = Symbol.for("osnv:validation:rules");

/** Одно зарегистрированное правило: поле + опции одного декоратора. */
export interface FieldRule {
  readonly property: string;
  readonly options: ValidatorOptions;
}

interface RulesMetadata {
  [FIELD_RULES]?: FieldRule[];
}

/**
 * Регистрирует правило поля в метаданных класса (вызывается декоратором).
 *
 * Метаданные TC39-декораторов наследуются прототипно: метадата-объект
 * подкласса имеет прототипом метадату родителя. Поэтому при первой записи
 * в конкретный класс делаем copy-on-write — копируем унаследованные правила
 * в собственный массив, не мутируя родительские.
 */
export function registerFieldRule(context: ClassFieldDecoratorContext, options: ValidatorOptions): void {
  if (context.static) {
    throw new Error(`@Validator: static field "${String(context.name)}" is not supported; the decorator works on instance fields only.`);
  }
  if (context.private) {
    throw new Error(`@Validator: private field "${String(context.name)}" is not supported; values are read through ordinary property access.`);
  }

  const metadata = context.metadata as RulesMetadata;
  const inherited = metadata[FIELD_RULES];
  if (!Object.prototype.hasOwnProperty.call(metadata, FIELD_RULES)) {
    metadata[FIELD_RULES] = inherited ? [...inherited] : [];
  }
  metadata[FIELD_RULES]!.push({ property: String(context.name), options });
}

/**
 * Возвращает правила валидации класса (включая унаследованные) или
 * `undefined`, если на классе нет ни одного декоратора `@Validator`.
 */
export function rulesOf(ctor: object | undefined | null): readonly FieldRule[] | undefined {
  if (typeof ctor !== "function") {
    return undefined;
  }
  const metadata = (ctor as unknown as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | RulesMetadata
    | undefined;
  const rules = metadata?.[FIELD_RULES];
  return rules && rules.length > 0 ? rules : undefined;
}

/**
 * Есть ли у значения класс с зарегистрированными правилами валидации.
 * Используется для автоопределения `nested`.
 */
export function hasRules(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return rulesOf((value as object).constructor) !== undefined;
}
