import type { ColumnOptionsType, RelationKind, PropertyConvention } from "./types";
import type { ValueConverter } from "./ValueConverter";
import { fieldSelector, type PredicateFn } from "../Query/conditions";
import type { Condition } from "../Query/conditions";
import { compileCheck, type CheckPredicate } from "../Schema/CheckExpression";

type EntityClass = new () => object;

// Стандартные TC39-декораторы (как в validation/http): без reflect-metadata
// и experimentalDecorators — это сохраняет совместимость с bun build --compile.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const ENTITY_META = Symbol.for("osnova:orm:entity");

/** Опции `@Entity`. */
export interface EntityOptions {
  /** Имя таблицы (по умолчанию — множественное число от имени класса). */
  readonly table?: string;
  /**
   * Имя свойства soft-delete (`datetime`, nullable). Эквивалент `@SoftDelete()`
   * на колонке. `remove()` ставит метку времени вместо DELETE; запросы фильтруют
   * `IS NULL`, если не вызван `ignoreQueryFilters()`.
   */
  readonly softDelete?: string;
}

/** Опции `@Column`. */
export interface ColumnOptions {
  /** Имя колонки (по умолчанию — имя свойства). */
  readonly name?: string;
  /** Тип: физический (`text`, `datetime`, …) или семантический (`uuid`, `createdAt`, `updatedAt`). */
  readonly type?: ColumnOptionsType;
  /** Разрешать NULL (по умолчанию true; `@Required` ставит false). */
  readonly nullable?: boolean;
  /** Closed physical PostgreSQL default. It is not an application initializer or SQL fragment. */
  readonly default?: ColumnDefaultValue;
}
export type ColumnDefaultValue = null | boolean | number | string;

/** Опции `@Key`. */
export interface KeyOptions {
  /**
   * Генерировать ли значение на стороне БД (автоинкремент). По умолчанию
   * `true` для целочисленного ключа, иначе `false` (значение задаёт код,
   * например GUID).
   */
  readonly generated?: boolean;
  readonly name?: string;
}

/** Опции `@UUID`. */
export interface UUIDOptions {
  /**
   * Версия UUID при автогенерации ключа: `v4` (по умолчанию) или `v7`
   * (монотонный, лучше для индексов БД).
   */
  readonly version?: "v4" | "v7";
  readonly name?: string;
}

/** Опции `@Index` (на свойстве). */
export interface IndexOptions {
  readonly unique?: boolean;
  readonly name?: string;
}
export interface CompositeKeyOptions { readonly name?: string }
export type ReferentialAction = "noAction" | "restrict" | "cascade" | "setNull";
export interface CompositeForeignKeyOptions { readonly name?: string; readonly properties: readonly [string, ...string[]]; readonly onDelete?: ReferentialAction; readonly onUpdate?: ReferentialAction }

/** Опции навигации. */
export interface RelationOptions {
  /** Имя свойства внешнего ключа (на зависимой стороне). */
  readonly foreignKey: string | readonly string[];
}

/** Сырое описание свойства, накопленное декораторами. */
export interface RawProperty {
  propertyName: string;
  columnName?: string;
  type?: ColumnOptionsType;
  isKey?: boolean;
  keyGenerated?: boolean;
  required?: boolean;
  nullable?: boolean;
  default?: ColumnDefaultValue;
  index?: { unique: boolean; name?: string };
  /** `@ForeignKey(() => Principal)` на скалярной колонке — для DDL FK. */
  fkTarget?: () => EntityClass;
  /** `@ValueConverter(...)` — преобразование до/после диалекта. */
  converter?: ValueConverter;
  /** `@UUID` / `@CreatedAt` / `@UpdatedAt`. */
  convention?: PropertyConvention;
  /** Версия UUID для `@UUID` (по умолчанию v4). */
  uuidVersion?: "v4" | "v7";
}

/** Сырая навигационная связь. */
export interface RawRelation {
  navigationName: string;
  kind: RelationKind;
  target: () => EntityClass;
  foreignKey: string | readonly string[];
}

/** Сырые метаданные сущности до применения соглашений. */
export interface RawEntity {
  isEntity: boolean;
  table?: string;
  schema?: string;
  properties: Map<string, RawProperty>;
  relations: RawRelation[];
  queryFilters?: Condition[];
  /** Имя свойства soft-delete (см. `@SoftDelete` / `@Entity({ softDelete })`). */
  softDeleteProperty?: string;
  keyDeclaration?: { properties: readonly string[]; name?: string; anchor: string; composite: boolean };
  indexes?: Array<{ properties: readonly string[]; unique: boolean; name?: string }>;
  foreignKeys?: Array<{ properties: readonly string[]; target: () => EntityClass; name?: string; onDelete?: ReferentialAction; onUpdate?: ReferentialAction }>;
  checks?: Array<{ name: string; expression: import("../Schema/CheckExpression").CheckAst }>;
}

interface MetadataCarrier {
  [ENTITY_META]?: RawEntity;
}

function emptyRaw(): RawEntity {
  return { isEntity: false, properties: new Map(), relations: [] };
}

function cloneRaw(source: RawEntity): RawEntity {
  const properties = new Map<string, RawProperty>();
  for (const [name, prop] of source.properties) {
    properties.set(name, { ...prop, index: prop.index ? { ...prop.index } : undefined });
  }
  return { ...source, properties, relations: source.relations.map((relation) => ({ ...relation })), keyDeclaration: source.keyDeclaration && { ...source.keyDeclaration, properties: [...source.keyDeclaration.properties] }, indexes: source.indexes?.map((index) => ({ ...index, properties: [...index.properties] })), foreignKeys: source.foreignKeys?.map((foreignKey) => ({ ...foreignKey, properties: [...foreignKey.properties] })), checks: source.checks?.map((check) => ({ ...check })), queryFilters: source.queryFilters?.map(cloneCondition) };
}

function cloneCondition(condition: Condition): Condition {
  switch (condition.kind) {
    case "and":
    case "or":
      return { kind: condition.kind, left: cloneCondition(condition.left), right: cloneCondition(condition.right) };
    case "not":
      return { kind: "not", inner: cloneCondition(condition.inner) };
    default:
      return { ...condition };
  }
}

/**
 * Собственные (copy-on-write) метаданные сущности для декорируемого класса.
 * Метадата TC39-декораторов наследуется прототипно — первая запись в подкласс
 * копирует унаследованное (нужно для будущих иерархий TPH/TPT/TPC).
 */
function ownRaw(metadata: object): RawEntity {
  const carrier = metadata as MetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, ENTITY_META)) {
    const inherited = carrier[ENTITY_META];
    carrier[ENTITY_META] = inherited ? cloneRaw(inherited) : emptyRaw();
  }
  return carrier[ENTITY_META]!;
}

function ownProperty(metadata: object, name: string): RawProperty {
  const raw = ownRaw(metadata);
  let prop = raw.properties.get(name);
  if (!prop) {
    prop = { propertyName: name };
    raw.properties.set(name, prop);
  }
  return prop;
}

type FieldContext = ClassFieldDecoratorContext | ClassGetterDecoratorContext | ClassAccessorDecoratorContext;

function fieldName(context: FieldContext): string {
  if (context.static || context.private) {
    throw new Error(`@Column/@Key support public instance properties only ("${String(context.name)}").`);
  }
  return String(context.name);
}

/** Помечает класс как сущность (таблицу). */
export function Entity(options: EntityOptions = {}) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const raw = ownRaw(context.metadata);
    raw.isEntity = true;
    raw.table = options.table;
    if (options.softDelete) {
      raw.softDeleteProperty = options.softDelete;
    }
  };
}

/**
 * PostgreSQL-схема таблицы. Без декоратора или с пустым именем — таблица в
 * `public`, `CREATE SCHEMA` не выполняется. С именем — мигратор создаёт схему
 * (`CREATE SCHEMA IF NOT EXISTS`) перед таблицей.
 */
export function Schema(name?: string) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      ownRaw(context.metadata).schema = trimmed;
    }
  };
}

/** Первичный ключ. По умолчанию автоинкремент для целочисленного ключа. */
export function Key(options?: KeyOptions): (value: undefined, context: ClassFieldDecoratorContext) => void;
export function Key(properties: readonly [string, string, ...string[]], options?: CompositeKeyOptions): (value: undefined, context: ClassFieldDecoratorContext) => void;
export function Key(first: KeyOptions | readonly [string, string, ...string[]] = {}, options: CompositeKeyOptions = {}) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    const prop = ownProperty(context.metadata, fieldName(context));
    const raw = ownRaw(context.metadata);
    if (raw.keyDeclaration) throw new Error("Only one @Key declaration is allowed.");
    if (Array.isArray(first)) { raw.keyDeclaration = { properties: [...first], name: options.name, anchor: prop.propertyName, composite: true }; prop.isKey = true; return; }
    raw.keyDeclaration = { properties: [prop.propertyName], name: (first as KeyOptions).name, anchor: prop.propertyName, composite: false };
    prop.isKey = true;
    prop.keyGenerated = (first as KeyOptions).generated;
  };
}
export function Check<T extends object>(name: string, predicate: CheckPredicate<T>) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error("Invalid CHECK constraint name.");
    (ownRaw(context.metadata).checks ??= []).push({ name, expression: compileCheck(predicate) });
  };
}

/**
 * Первичный ключ UUID. Генерируется **в PostgreSQL** (`DEFAULT gen_random_uuid()`),
 * значение читается через `RETURNING` после INSERT.
 */

export function UUID(options: UUIDOptions = {}) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    const prop = ownProperty(context.metadata, fieldName(context));
    const raw = ownRaw(context.metadata); if (raw.keyDeclaration) throw new Error("@UUID cannot be combined with @Key."); raw.keyDeclaration = { properties: [prop.propertyName], name: options.name, anchor: prop.propertyName, composite: false };
    prop.isKey = true;
    prop.type = "uuid";
    prop.keyGenerated = false;
    prop.convention = "uuid"; prop.uuidVersion = options.version ?? "v4";
  };
}

/**
 * Метка создания (`datetime`). Заполняется при первой вставке.
 * Эквивалент `@Column({ type: "createdAt" })`.
 */
export function CreatedAt() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).type = "createdAt";
  };
}

/**
 * Метка обновления (`datetime`). Заполняется при вставке и при каждом UPDATE.
 * Эквивалент `@Column({ type: "updatedAt" })`.
 */
export function UpdatedAt() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).type = "updatedAt";
  };
}

/** Замапленная колонка. Тип не выводится из TS-типа (нет рефлексии) — задаётся здесь. */
export function Column(options: ColumnOptions = {}) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    const prop = ownProperty(context.metadata, fieldName(context));
    prop.columnName = options.name;
    prop.type = options.type;
    prop.default = options.default;
    if (options.nullable !== undefined) {
      prop.nullable = options.nullable;
    }
  };
}

/** NOT NULL. */
export function Required() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).required = true;
  };
}

/** Индекс по колонке свойства. */
export function Index(options?: IndexOptions): (value: undefined, context: ClassFieldDecoratorContext) => void;
export function Index(properties: readonly [string, ...string[]], options?: IndexOptions): (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext) => void;
export function Index(first: IndexOptions | readonly [string, ...string[]] = {}, options: IndexOptions = {}) {
  if (Array.isArray(first)) {
    return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
      (ownRaw(context.metadata).indexes ??= []).push({ properties: [...first], unique: options.unique === true, name: options.name });
    };
  }
  const propertyOptions = first as IndexOptions;
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).index = { unique: propertyOptions.unique === true, name: propertyOptions.name };
  };
}

/**
 * Помечает скалярную колонку как внешний ключ к `target` (для DDL-ограничения).
 * Достаточно, если навигационного свойства нет; иначе FK выводится из
 * `@ManyToOne`.
 */
export function ForeignKey(target: () => EntityClass): (value: undefined, context: ClassFieldDecoratorContext) => void;
export function ForeignKey(target: () => EntityClass, options: CompositeForeignKeyOptions): (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext) => void;
export function ForeignKey(target: () => EntityClass, options?: CompositeForeignKeyOptions) {
  if (options) {
    return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
      (ownRaw(context.metadata).foreignKeys ??= []).push({ properties: [...options.properties], target, name: options.name, onDelete: options.onDelete, onUpdate: options.onUpdate });
    };
  }
  return (_value: undefined, context: ClassFieldDecoratorContext): void => { ownProperty(context.metadata, fieldName(context)).fkTarget = target; };
}

/**
 * Ссылочная навигация (many-to-one): внешний ключ на этой сущности.
 *
 * ```ts
 * @Column({ type: "integer" }) authorId = 0;
 * @ManyToOne(() => User, { foreignKey: "authorId" }) author?: User;
 * ```
 */
export function ManyToOne(target: () => EntityClass, options: RelationOptions) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownRaw(context.metadata).relations.push({
      navigationName: fieldName(context),
      kind: "reference",
      target,
      foreignKey: Array.isArray(options.foreignKey) ? [...options.foreignKey] : options.foreignKey,
    });
  };
}

/**
 * Коллекционная навигация (one-to-many): внешний ключ на целевой сущности.
 *
 * ```ts
 * @OneToMany(() => Post, { foreignKey: "authorId" }) posts: Post[] = [];
 * ```
 */
export function OneToMany(target: () => EntityClass, options: RelationOptions) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownRaw(context.metadata).relations.push({
      navigationName: fieldName(context),
      kind: "collection",
      target,
      foreignKey: Array.isArray(options.foreignKey) ? [...options.foreignKey] : options.foreignKey,
    });
  };
}

/** Конвертер значения колонки (шифрование, сериализация). */
export function HasConversion(converter: ValueConverter) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).converter = converter;
  };
}

/**
 * Глобальный фильтр запросов для сущности (multi-tenant, флаги и т.д.).
 * Применяется автоматически; отключается через `ignoreQueryFilters()`.
 */
export function QueryFilter<T extends object>(predicate: PredicateFn<T>) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const raw = ownRaw(context.metadata);
    const node = predicate(fieldSelector<T>()).node;
    raw.queryFilters = [...(raw.queryFilters ?? []), node];
  };
}

/** Помечает колонку soft-delete: `remove()` ставит метку времени вместо DELETE. */
export function SoftDelete() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    const name = fieldName(context);
    ownProperty(context.metadata, name).type = "datetime";
    ownProperty(context.metadata, name).nullable = true;
    ownRaw(context.metadata).softDeleteProperty = name;
  };
}

/** Читает сырые метаданные сущности (или undefined, если класс не сущность). */
export function readRawEntity(ctor: object): RawEntity | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | MetadataCarrier
    | undefined;
  const raw = metadata?.[ENTITY_META];
  return raw?.isEntity ? raw : undefined;
}
