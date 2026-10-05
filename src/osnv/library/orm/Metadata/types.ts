import type { Condition } from "../Query/conditions";
import type { ValueConverter } from "./ValueConverter";
import type { CheckAst } from "../Schema/CheckExpression";
import type { CanonicalDefault } from "../Schema/introspection";

/**
 * Physical column type in the database (DDL, encode/decode). The provider
 * dialect maps it to the types of a concrete DBMS (`SqlDialect.columnType`).
 */
export type StorageColumnType = "integer" | "real" | "text" | "boolean" | "datetime" | "json";

/**
 * Semantic `@Column({ type })` types with automatic behavior on `SaveChanges`.
 * In the model they split into `StorageColumnType` + `PropertyConvention`.
 */
export type SemanticColumnType = "uuid" | "createdAt" | "updatedAt";

/** Type in the `@Column({ type })` options. */
export type ColumnOptionsType = StorageColumnType | SemanticColumnType;

/** Physical type in a compiled `PropertyModel`. */
export type ColumnType = StorageColumnType;

/** Primary key value generation strategy. */
export type KeyGeneration = "identity" | "uuid" | "none";

/** Automatic column conventions (`@UUID`, `@CreatedAt`, `@UpdatedAt`). */
export type PropertyConvention = "uuid" | "createdAt" | "updatedAt";

/** Compiled model of one entity column/property. */
export interface PropertyModel {
  /** Property name in the class. */
  readonly propertyName: string;
  /** Column name in the table. */
  readonly columnName: string;
  /** Storage type. */
  readonly type: ColumnType;
  /** Part of the primary key. */
  readonly isKey: boolean;
  /** How the key is generated (`identity` / `uuid`: by the database, `none`: set by the code). */
  readonly generation: KeyGeneration;
  /** NOT NULL. */
  readonly required: boolean;
  /** Optional value converter (encryption, serialization and so on). */
  readonly converter?: ValueConverter;
  /** Automatic value on save (see `@UUID`, `@CreatedAt`, `@UpdatedAt`). */
  readonly convention?: PropertyConvention;
  /** UUID version for `@UUID` (default v4). */
  readonly uuidVersion?: "v4" | "v7";
  /** Closed physical database default; it never affects entity initialization. */
  readonly databaseDefault: CanonicalDefault;
}

/** Compiled index model. */
export interface IndexModel {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}
export interface CheckModel { readonly name: string; readonly expression: CheckAst }

/** Navigation kind: a reference (many-to-one) or a collection (one-to-many). */
export type RelationKind = "reference" | "collection";

/**
 * Compiled navigation relation model.
 *
 * - `reference`: the `foreignKey` is on THIS entity and points to the target's
 *   primary key.
 * - `collection`: the `foreignKey` is on the TARGET entity and points to this
 *   entity's primary key.
 *
 * `target` is a lazy thunk (to break circular imports between entities).
 */
export interface RelationModel {
  readonly navigationName: string;
  readonly kind: RelationKind;
  readonly target: () => new () => object;
  /** Name of the foreign key property (on the dependent side). */
  readonly foreignKey: string | readonly string[];
}

/** Foreign key for a DDL constraint (from `@ForeignKey` or a reference relation). */
export interface ForeignKeyModel {
  /** Name of the foreign key property on this entity. */
  readonly property: string;
  readonly properties: readonly string[];
  readonly name?: string;
  readonly onDelete: "noAction" | "restrict" | "cascade" | "setNull";
  readonly onUpdate: "noAction" | "restrict" | "cascade" | "setNull";
  readonly target: () => new () => object;
}

/** Compiled entity (table) model. */
export interface EntityModel {
  /** Entity class constructor. */
  readonly ctor: new () => object;
  /** Entity name (the class name). */
  readonly name: string;
  /** Table name (physical, without the schema). */
  readonly tableName: string;
  /** PostgreSQL database schema. */
  readonly schema?: string;
  /** All mapped properties in declaration order. */
  readonly properties: readonly PropertyModel[];
  /** The sole ordered primary-key authority. */
  readonly key: readonly [PropertyModel, ...PropertyModel[]];
  /** Physical name of the sole primary-key constraint, if declared explicitly. */
  readonly keyName?: string;
  readonly indexes: readonly IndexModel[];
  readonly checks: readonly CheckModel[];
  /** Navigation relations. */
  readonly relations: readonly RelationModel[];
  /** Foreign keys for DDL constraints. */
  readonly foreignKeys: readonly ForeignKeyModel[];
  /** Global query filters (`@QueryFilter`), applied to every SELECT. */
  readonly queryFilters: readonly Condition[];
  /** Soft-delete property name (NULL = not deleted). `@SoftDelete` / `@Entity({ softDelete })`. */
  readonly softDeleteProperty?: string;
  /** Property by name. */
  propertyByName(name: string): PropertyModel | undefined;
  /** Navigation by name. */
  relationByName(name: string): RelationModel | undefined;
}
