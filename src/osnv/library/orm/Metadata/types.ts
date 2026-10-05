import type { Condition } from "../Query/conditions";
import type { ValueConverter } from "./ValueConverter";
import type { CheckAst } from "../Schema/CheckExpression";
import type { CanonicalDefault } from "../Schema/introspection";

/**
 * Тип хранения колонки. Сопоставление с типами конкретной СУБД делает
 * диалект провайдера (`SqlDialect.columnType`).
 */
/**
 * Физический тип колонки в БД (DDL, encode/decode).
 */
export type StorageColumnType = "integer" | "real" | "text" | "boolean" | "datetime" | "json";

/**
 * Семантические типы `@Column({ type })` с автоповедением при `SaveChanges`.
 * В модели раскладываются на `StorageColumnType` + `PropertyConvention`.
 */
export type SemanticColumnType = "uuid" | "createdAt" | "updatedAt";

/** Тип в опциях `@Column({ type })`. */
export type ColumnOptionsType = StorageColumnType | SemanticColumnType;

/** Физический тип в скомпилированной `PropertyModel`. */
export type ColumnType = StorageColumnType;

/** Стратегия генерации значения первичного ключа. */
export type KeyGeneration = "identity" | "uuid" | "none";

/** Автоматические соглашения колонки (`@UUID`, `@CreatedAt`, `@UpdatedAt`). */
export type PropertyConvention = "uuid" | "createdAt" | "updatedAt";

/** Скомпилированная модель одной колонки/свойства сущности. */
export interface PropertyModel {
  /** Имя свойства в классе. */
  readonly propertyName: string;
  /** Имя колонки в таблице. */
  readonly columnName: string;
  /** Тип хранения. */
  readonly type: ColumnType;
  /** Часть первичного ключа. */
  readonly isKey: boolean;
  /** Как генерируется ключ (`identity` / `uuid` — на стороне БД, `none` — задаёт код). */
  readonly generation: KeyGeneration;
  /** NOT NULL. */
  readonly required: boolean;
  /** Опциональный конвертер значения (шифрование, сериализация и т.д.). */
  readonly converter?: ValueConverter;
  /** Автоматическое значение при сохранении (см. `@UUID`, `@CreatedAt`, `@UpdatedAt`). */
  readonly convention?: PropertyConvention;
  /** Версия UUID для `@UUID` (по умолчанию v4). */
  readonly uuidVersion?: "v4" | "v7";
  /** Closed physical database default; it never affects entity initialization. */
  readonly databaseDefault: CanonicalDefault;
}

/** Скомпилированная модель индекса. */
export interface IndexModel {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}
export interface CheckModel { readonly name: string; readonly expression: CheckAst }

/** Тип навигации: ссылка (many-to-one) или коллекция (one-to-many). */
export type RelationKind = "reference" | "collection";

/**
 * Скомпилированная модель навигационной связи.
 *
 * - `reference`: внешний ключ `foreignKey` находится на ЭТОЙ сущности и
 *   указывает на первичный ключ цели.
 * - `collection`: внешний ключ `foreignKey` находится на ЦЕЛЕВОЙ сущности и
 *   указывает на первичный ключ этой сущности.
 *
 * `target` — ленивый thunk (для разрыва циклических импортов между сущностями).
 */
export interface RelationModel {
  readonly navigationName: string;
  readonly kind: RelationKind;
  readonly target: () => new () => object;
  /** Имя свойства внешнего ключа (на зависимой стороне). */
  readonly foreignKey: string | readonly string[];
}

/** Внешний ключ для DDL-ограничения (из `@ForeignKey` или reference-связи). */
export interface ForeignKeyModel {
  /** Имя свойства внешнего ключа на этой сущности. */
  readonly property: string;
  readonly properties: readonly string[];
  readonly name?: string;
  readonly onDelete: "noAction" | "restrict" | "cascade" | "setNull";
  readonly onUpdate: "noAction" | "restrict" | "cascade" | "setNull";
  readonly target: () => new () => object;
}

/** Скомпилированная модель сущности (таблицы). */
export interface EntityModel {
  /** Конструктор класса сущности. */
  readonly ctor: new () => object;
  /** Имя сущности (имя класса). */
  readonly name: string;
  /** Имя таблицы (физическое, без схемы). */
  readonly tableName: string;
  /** Схема БД PostgreSQL. */
  readonly schema?: string;
  /** Все замапленные свойства в порядке объявления. */
  readonly properties: readonly PropertyModel[];
  /** The sole ordered primary-key authority. */
  readonly key: readonly [PropertyModel, ...PropertyModel[]];
  /** Physical name of the sole primary-key constraint, if declared explicitly. */
  readonly keyName?: string;
  readonly indexes: readonly IndexModel[];
  readonly checks: readonly CheckModel[];
  /** Навигационные связи. */
  readonly relations: readonly RelationModel[];
  /** Внешние ключи для DDL-ограничений. */
  readonly foreignKeys: readonly ForeignKeyModel[];
  /** Глобальные фильтры запросов (`@QueryFilter`), применяются ко всем SELECT. */
  readonly queryFilters: readonly Condition[];
  /** Имя свойства soft-delete (NULL = не удалено). `@SoftDelete` / `@Entity({ softDelete })`. */
  readonly softDeleteProperty?: string;
  /** Свойство по имени. */
  propertyByName(name: string): PropertyModel | undefined;
  /** Навигация по имени. */
  relationByName(name: string): RelationModel | undefined;
}
