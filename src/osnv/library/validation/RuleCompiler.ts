import { rulesOf } from "./metadata";
import type { ValidatorOptions } from "./types/ValidatorOptions";

/**
 * Режим вложенной валидации для конкретного правила:
 * - `explicit` — `nested: true`, рекурсия даже без автоопределения;
 * - `auto` — рекурсия, если значение является экземпляром класса с декораторами;
 * - `none` — это правило вложенную валидацию не запускает.
 *
 * На поле с несколькими декораторами носителем вложенной проверки назначается
 * ровно одно правило — иначе ошибки вложенного объекта дублировались бы.
 */
export type NestedMode = "explicit" | "auto" | "none";

/**
 * Скомпилированное правило одного декоратора: всё дорогое (компиляция RegExp,
 * сбор значений enum в Set) сделано заранее, в горячем пути валидации
 * остаются только проверки.
 */
export interface CompiledRule {
  readonly property: string;
  readonly options: ValidatorOptions;
  /** Запускает ли это правило вложенную валидацию и в каком режиме. */
  nested: NestedMode;
  /** Предкомпилированный `pattern` (из RegExp или строки-источника). */
  readonly pattern?: RegExp;
  /** Допустимые значения enum (O(1)-проверка членства). */
  readonly enumValues?: ReadonlySet<unknown>;
  /** Человекочитаемый список значений enum для сообщения `{allowed}`. */
  readonly enumLabel?: string;
  /** Есть строковые правила — значение обязано быть строкой. */
  readonly needsString: boolean;
  /** Есть числовые правила — значение обязано быть числом. */
  readonly needsNumber: boolean;
  /** Есть boolean-правила — значение обязано быть boolean. */
  readonly needsBoolean: boolean;
  /** Проверки-флаги с учётом подсказки `type` (type: "email" === email: true). */
  readonly checkEmail: boolean;
  readonly checkUrl: boolean;
  readonly checkUuid: boolean;
  readonly checkJson: boolean;
  readonly checkPhone: boolean;
  readonly checkDate: boolean;
}

/**
 * Компилирует и кэширует план валидации класса.
 *
 * Кэш — WeakMap по конструктору: правила собираются при первом обращении
 * к классу и переиспользуются всеми последующими вызовами `validate`.
 * WeakMap не удерживает классы от сборки мусора.
 */
export class RuleCompiler {
  private static readonly cache = new WeakMap<object, readonly CompiledRule[]>();

  /**
   * План валидации для конструктора или `undefined`, если на классе
   * (и его родителях) нет декораторов `@Validator`.
   */
  static planFor(ctor: object | undefined | null): readonly CompiledRule[] | undefined {
    if (typeof ctor !== "function") {
      return undefined;
    }
    const cached = RuleCompiler.cache.get(ctor);
    if (cached) {
      return cached;
    }
    const rules = rulesOf(ctor);
    if (!rules) {
      return undefined;
    }
    const plan = rules.map((rule) => RuleCompiler.compile(rule.property, rule.options));
    RuleCompiler.assignNestedCarriers(plan);
    RuleCompiler.cache.set(ctor, plan);
    return plan;
  }

  /**
   * Выбирает для каждого поля единственное правило-носитель вложенной
   * валидации: явный `nested: true` приоритетнее автоопределения; если
   * хоть один декоратор поля указал `nested: false` и явного `true` нет —
   * вложенная проверка для поля отключается целиком.
   */
  private static assignNestedCarriers(plan: CompiledRule[]): void {
    const carrierByProperty = new Map<string, CompiledRule>();
    const disabledProperties = new Set<string>();
    for (const rule of plan) {
      const declared = rule.options.nested;
      if (declared === false) {
        disabledProperties.add(rule.property);
        continue;
      }
      const current = carrierByProperty.get(rule.property);
      if (!current || (declared === true && current.options.nested !== true)) {
        carrierByProperty.set(rule.property, rule);
      }
    }
    for (const [property, carrier] of carrierByProperty) {
      if (carrier.options.nested === true) {
        carrier.nested = "explicit";
      } else if (!disabledProperties.has(property)) {
        carrier.nested = "auto";
      }
    }
  }

  private static compile(property: string, o: ValidatorOptions): CompiledRule {
    const checkEmail = o.email === true || o.type === "email";
    const checkUrl = o.url === true;
    const checkUuid = o.uuid === true;
    const checkJson = o.json === true || o.type === "json";
    const checkPhone = o.phone === true || o.type === "phone";
    const checkDate = o.type === "date";

    const needsString =
      o.type === "string" ||
      o.notEmpty === true ||
      o.minLength !== undefined ||
      o.maxLength !== undefined ||
      o.length !== undefined ||
      o.contains !== undefined ||
      o.notContains !== undefined ||
      o.pattern !== undefined ||
      checkEmail ||
      checkUrl ||
      checkUuid ||
      checkJson ||
      checkPhone;

    const needsNumber =
      o.type === "number" ||
      o.min !== undefined ||
      o.max !== undefined ||
      o.range !== undefined ||
      o.positive === true ||
      o.negative === true ||
      o.integer === true;

    const needsBoolean = o.type === "boolean" || o.mustBeTrue === true || o.mustBeFalse === true;

    // Строка-источник компилируется здесь один раз — это обычный конструктор
    // RegExp, никакого eval/динамической компиляции кода.
    const pattern = o.pattern === undefined ? undefined : o.pattern instanceof RegExp ? o.pattern : new RegExp(o.pattern);

    let enumValues: ReadonlySet<unknown> | undefined;
    let enumLabel: string | undefined;
    if (o.enumType !== undefined) {
      const values = new Set<unknown>();
      for (const key of Object.keys(o.enumType)) {
        // hasOwnProperty: защита от prototype pollution в переданном объекте.
        if (!Object.prototype.hasOwnProperty.call(o.enumType, key)) {
          continue;
        }
        // Числовые enum TypeScript содержат обратные ключи ("0" -> "Admin") —
        // их пропускаем, иначе имена значений попали бы в допустимые.
        if (/^\d+$/.test(key)) {
          continue;
        }
        values.add(o.enumType[key]);
      }
      enumValues = values;
      enumLabel = [...values].join(", ");
    }

    return {
      property,
      options: o,
      nested: "none",
      pattern,
      enumValues,
      enumLabel,
      needsString,
      needsNumber,
      needsBoolean,
      checkEmail,
      checkUrl,
      checkUuid,
      checkJson,
      checkPhone,
      checkDate,
    };
  }
}
