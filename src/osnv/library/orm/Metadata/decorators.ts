import type { ColumnOptionsType, RelationKind, PropertyConvention } from "./types";
import type { ValueConverter } from "./ValueConverter";
import { fieldSelector, type PredicateFn } from "../Query/conditions";
import type { Condition } from "../Query/conditions";
import { compileCheck, type CheckPredicate } from "../Schema/CheckExpression";

type EntityClass = new () => object;

// Standard TC39 decorators (as in validation/http): no reflect-metadata
// and no experimentalDecorators, which keeps bun build --compile compatible.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const ENTITY_META = Symbol.for("osnv:orm:entity");

/** `@Entity` options. */
export interface EntityOptions {
  /** Table name (defaults to the plural of the class name). */
  readonly table?: string;
  /**
   * Soft-delete property name (`datetime`, nullable). Equivalent to `@SoftDelete()`
   * on the column. `remove()` sets a timestamp instead of DELETE; queries filter
   * `IS NULL` unless `ignoreQueryFilters()` is called.
   */
  readonly softDelete?: string;
}

/** `@Column` options. */
export interface ColumnOptions {
  /** Column name (defaults to the property name). */
  readonly name?: string;
  /** Type: physical (`text`, `datetime`, …) or semantic (`uuid`, `createdAt`, `updatedAt`). */
  readonly type?: ColumnOptionsType;
  /** Allow NULL (default true; `@Required` sets false). */
  readonly nullable?: boolean;
  /** Closed physical PostgreSQL default. It is not an application initializer or SQL fragment. */
  readonly default?: ColumnDefaultValue;
}
export type ColumnDefaultValue = null | boolean | number | string;

/** `@Key` options. */
export interface KeyOptions {
  /**
   * Whether the database generates the value (auto-increment). Defaults to
   * `true` for an integer key, otherwise `false` (the code sets the value,
   * for example a GUID).
   */
  readonly generated?: boolean;
  readonly name?: string;
}

/** `@UUID` options. */
export interface UUIDOptions {
  /**
   * UUID version. Entity classes support only `v4` (the default): PostgreSQL
   * generates the key with `gen_random_uuid()`, and `v7` is rejected when the
   * model is built.
   */
  readonly version?: "v4" | "v7";
  readonly name?: string;
}

/** `@Index` options (on a property). */
export interface IndexOptions {
  readonly unique?: boolean;
  readonly name?: string;
}
export interface CompositeKeyOptions { readonly name?: string }
export type ReferentialAction = "noAction" | "restrict" | "cascade" | "setNull";
export interface CompositeForeignKeyOptions { readonly name?: string; readonly properties: readonly [string, ...string[]]; readonly onDelete?: ReferentialAction; readonly onUpdate?: ReferentialAction }

/** Navigation options. */
export interface RelationOptions {
  /** Name of the foreign key property (on the dependent side). */
  readonly foreignKey: string | readonly string[];
}

/** Raw property description accumulated by decorators. */
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
  /** `@ForeignKey(() => Principal)` on a scalar column, for the DDL FK. */
  fkTarget?: () => EntityClass;
  /** `@HasConversion(...)`: conversion before/after the dialect. */
  converter?: ValueConverter;
  /** `@UUID` / `@CreatedAt` / `@UpdatedAt`. */
  convention?: PropertyConvention;
  /** UUID version for `@UUID` (default v4). */
  uuidVersion?: "v4" | "v7";
}

/** Raw navigation relation. */
export interface RawRelation {
  navigationName: string;
  kind: RelationKind;
  target: () => EntityClass;
  foreignKey: string | readonly string[];
}

/** Raw entity metadata before conventions are applied. */
export interface RawEntity {
  isEntity: boolean;
  table?: string;
  schema?: string;
  properties: Map<string, RawProperty>;
  relations: RawRelation[];
  queryFilters?: Condition[];
  /** Soft-delete property name (see `@SoftDelete` / `@Entity({ softDelete })`). */
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
 * Own (copy-on-write) entity metadata of the decorated class. TC39 decorator
 * metadata is inherited prototypically: the first write in a subclass copies
 * the inherited state.
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

/** Marks a class as an entity (a table). */
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
 * PostgreSQL schema of the table. Without the decorator or with an empty name
 * the table goes to `public` and no `CREATE SCHEMA` runs. With a name the
 * migrator creates the schema (`CREATE SCHEMA IF NOT EXISTS`) before the table.
 */
export function Schema(name?: string) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      ownRaw(context.metadata).schema = trimmed;
    }
  };
}

/** Primary key. Auto-increment by default for an integer key. */
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
 * UUID primary key. Generated **by PostgreSQL** (`DEFAULT gen_random_uuid()`);
 * the value is read through `RETURNING` after INSERT.
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
 * Creation timestamp (`datetime`). Set on the first insert.
 * Equivalent to `@Column({ type: "createdAt" })`.
 */
export function CreatedAt() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).type = "createdAt";
  };
}

/**
 * Update timestamp (`datetime`). Set on insert and on every UPDATE.
 * Equivalent to `@Column({ type: "updatedAt" })`.
 */
export function UpdatedAt() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).type = "updatedAt";
  };
}

/** Mapped column. The type is not inferred from the TS type (no reflection); it is set here. */
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

/** Index on the property's column. */
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
 * Marks a scalar column as a foreign key to `target` (for the DDL constraint).
 * Use it when there is no navigation property; otherwise the FK is inferred
 * from `@ManyToOne`.
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
 * Reference navigation (many-to-one): the foreign key is on this entity.
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
 * Collection navigation (one-to-many): the foreign key is on the target entity.
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

/** Column value converter (encryption, serialization). */
export function HasConversion(converter: ValueConverter) {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    ownProperty(context.metadata, fieldName(context)).converter = converter;
  };
}

/**
 * Global query filter for the entity (multi-tenant, flags and so on).
 * Applied automatically; disabled with `ignoreQueryFilters()`.
 */
export function QueryFilter<T extends object>(predicate: PredicateFn<T>) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const raw = ownRaw(context.metadata);
    const node = predicate(fieldSelector<T>()).node;
    raw.queryFilters = [...(raw.queryFilters ?? []), node];
  };
}

/** Marks a soft-delete column: `remove()` sets a timestamp instead of DELETE. */
export function SoftDelete() {
  return (_value: undefined, context: ClassFieldDecoratorContext): void => {
    const name = fieldName(context);
    ownProperty(context.metadata, name).type = "datetime";
    ownProperty(context.metadata, name).nullable = true;
    ownRaw(context.metadata).softDeleteProperty = name;
  };
}

/** Reads the raw entity metadata (or undefined if the class is not an entity). */
export function readRawEntity(ctor: object): RawEntity | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | MetadataCarrier
    | undefined;
  const raw = metadata?.[ENTITY_META];
  return raw?.isEntity ? raw : undefined;
}
