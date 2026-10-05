import { ModelBuildError } from "../errors";
import type {
  CheckModel,
  EntityModel,
  ForeignKeyModel,
  IndexModel,
  KeyGeneration,
  PropertyConvention,
  PropertyModel,
  RelationKind,
  RelationModel,
  StorageColumnType,
} from "./types";
import { compileCheck, validateCheckAst, type CheckPredicate } from "../Schema/CheckExpression";
import { registerDynamicTableIdentity } from "../Schema/tableKey";

type EntityClass = new () => object;

/**
 * Logical field type of a dynamic table: what a user picks when designing the
 * table. It maps to a physical `StorageColumnType` plus (for semantic fields)
 * a `PropertyConvention`.
 */
export type ScalarLogicalFieldType =
  | "string"
  | "int"
  | "bigint"
  | "decimal"
  | "bool"
  | "datetime"
  | "uuid"
  | "json";

export type LogicalFieldType = ScalarLogicalFieldType | "foreignKey";

/** Definition of one dynamic table field. */
export interface DynamicFieldDefinition {
  /** Property name in the entity (and the column name, if `columnName` is not set). */
  readonly name: string;
  /** Physical column name (defaults to `name`). */
  readonly columnName?: string;
  /** Logical type. */
  readonly type: LogicalFieldType;
  /** Single-field primary key (at most one field). For a composite key use the table's `primaryKey` instead. */
  readonly isKey?: boolean;
  /** NOT NULL. The key and semantic timestamp fields are always required. */
  readonly required?: boolean;
  /** Create a unique index on the column. */
  readonly unique?: boolean;
  /** Create a regular index on the column. */
  readonly indexed?: boolean;
  /** Automatic behavior on save (`uuid`/`createdAt`/`updatedAt`). */
  readonly convention?: PropertyConvention;
  /** UUID version for a `uuid` field/key (default v4). */
  readonly uuidVersion?: "v4" | "v7";
  /** Target dynamic table; required only for `foreignKey`. */
  readonly target?: string;
  /** Reference navigation of this table; required only for `foreignKey`. */
  readonly navigationName?: string;
  /** Optional collection navigation on the target table; compiled by the target's definition. */
  readonly inverseNavigationName?: string;
  /** Snapshot of the target key's logical type; defines the physical type of the FK column. */
  readonly targetKeyType?: ScalarLogicalFieldType;
}

/** Explicit composite index of a dynamic table. */
export interface DynamicIndexDefinition {
  readonly name?: string;
  /** Physical column names, not logical property names. */
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

/**
 * Compiled navigation between dynamic tables. Reference navigations and
 * physical constraints are derived from `foreignKey` fields; this contract
 * remains for server-derived inverse collections.
 *
 * - `reference`: `foreignKey` is a property of THIS table and points to the `target` key;
 * - `collection`: `foreignKey` is a property of the `target` table and points to this table's key.
 */
export interface DynamicRelationDefinition {
  readonly navigationName: string;
  readonly kind: RelationKind;
  /** Name of the target table/model. */
  readonly target: string;
  /** Name of the foreign key property (on the dependent side). */
  readonly foreignKey: string | readonly string[];
}
export interface DynamicPrimaryKeyDefinition { readonly properties: readonly [string, ...string[]]; readonly name?: string }
export interface DynamicForeignKeyDefinition { readonly properties: readonly [string, ...string[]]; readonly target: string; readonly name?: string; readonly onDelete?: "noAction" | "restrict" | "cascade" | "setNull"; readonly onUpdate?: "noAction" | "restrict" | "cascade" | "setNull" }
export interface DynamicCheckDefinition { readonly name: string; readonly predicate: CheckPredicate<Record<string, unknown>> }

/** Dynamic table definition (from an application's metadata catalog). */
export interface DynamicTableDefinition {
  /** Entity/model name (used as the registry key and the `ctor` name). */
  readonly name: string;
  /** Physical database schema (for example `data`). Becomes part of `tableName`. */
  readonly schema?: string;
  /** Physical table name (defaults to `name`). */
  readonly tableName?: string;
  readonly fields: readonly DynamicFieldDefinition[];
  readonly primaryKey?: DynamicPrimaryKeyDefinition;
  readonly indexes?: readonly DynamicIndexDefinition[];
  readonly foreignKeys?: readonly DynamicForeignKeyDefinition[];
  readonly checks?: readonly DynamicCheckDefinition[];
  readonly relations?: readonly DynamicRelationDefinition[];
  /** Soft-delete property name (NULL = not deleted). */
  readonly softDeleteProperty?: string;
}
/** Strict schema contracts use the same dynamic entity shape; no second runtime exists. */
export type DynamicEntityDefinition = DynamicTableDefinition;

/** Resolver of the target table's ctor by name (lazy, for relations). */
export type DynamicTargetResolver = (name: string) => EntityClass;

const LOGICAL_TO_STORAGE: Record<ScalarLogicalFieldType, StorageColumnType> = {
  string: "text",
  int: "integer",
  bigint: "integer",
  decimal: "real",
  bool: "boolean",
  datetime: "datetime",
  uuid: "text",
  json: "json",
};

/**
 * Builds an `EntityModel` from a catalog table definition, without decorators
 * or reflection. Creates a named anonymous `ctor` (its instances are plain row
 * objects); the model then works both for `DbSet`/`ChangeTracker` and for DDL
 * generation by the dialect (`createTableSql` and so on).
 *
 * Mirrors the `ModelBuilder` rules: one primary key, an integer key is identity
 * by default, key/timestamp fields are always NOT NULL.
 */
export function buildDynamicModel(def: DynamicTableDefinition, resolveTarget?: DynamicTargetResolver): EntityModel {
  return buildDynamicModelWithCtor(def, { [def.name]: class {} }[def.name]! as EntityClass, resolveTarget);
}

/**
 * Compiles a strict dynamic schema as one closed graph.  This is deliberately
 * package-local (not re-exported from the public ORM barrel): the legacy
 * single-table entry point retains its resolver-based behaviour.
 */
export function compileDynamicModelGraph(definitions: readonly DynamicEntityDefinition[]): readonly EntityModel[] {
  const definitionsByName = new Map<string, DynamicEntityDefinition>();
  const identities = new Set<string>();
  const ctors = new Map<string, EntityClass>();
  for (const definition of definitions) {
    if (definitionsByName.has(definition.name)) {
      throw new ModelBuildError(`Dynamic schema contains duplicate entity name "${definition.name}".`);
    }
    const identity = `${definition.schema ?? ""}\0${definition.tableName ?? definition.name}`;
    if (identities.has(identity)) {
      throw new ModelBuildError(`Dynamic schema contains duplicate table identity "${definition.schema ?? ""}.${definition.tableName ?? definition.name}".`);
    }
    definitionsByName.set(definition.name, definition);
    identities.add(identity);
    ctors.set(definition.name, { [definition.name]: class {} }[definition.name]! as EntityClass);
  }

  const target = (source: string): DynamicTargetResolver => (name) => {
    const ctor = ctors.get(name);
    if (!ctor) throw new ModelBuildError(`Dynamic table "${source}" references unknown target "${name}" in this schema contract.`);
    return ctor;
  };
  const models = definitions.map((definition) => buildDynamicModelWithCtor(definition, ctors.get(definition.name)!, target(definition.name)));
  const modelByCtor = new Map(models.map((model) => [model.ctor, model]));
  return models.map((model) => validateGraphForeignKeys(model, modelByCtor));
}

function buildDynamicModelWithCtor(
  def: DynamicTableDefinition,
  ctor: EntityClass,
  resolveTarget?: DynamicTargetResolver,
): EntityModel {
  if (def.fields.length === 0) {
    throw new ModelBuildError(`Dynamic table "${def.name}" has no fields.`);
  }

  const properties = def.fields.map((field) => buildProperty(def.name, field));

  const keys = properties.filter((property) => property.isKey);
  if (def.primaryKey && keys.length > 0) throw new ModelBuildError(`Dynamic table "${def.name}" cannot combine primaryKey with legacy isKey.`);
  if (keys.length === 0 && !def.primaryKey) {
    throw new ModelBuildError(`Dynamic table "${def.name}" has no primary key. Mark one field with isKey.`);
  }
  if (keys.length > 1) {
    throw new ModelBuildError(
      `Dynamic table "${def.name}" declares multiple keys ("${keys
        .map((key) => key.propertyName)
        .join('", "')}"). Composite keys are not supported.`,
    );
  }
  const key = keys[0];

  const byName = new Map<string, PropertyModel>();
  for (const property of properties) {
    if (byName.has(property.propertyName)) {
      throw new ModelBuildError(`Dynamic table "${def.name}": duplicate field "${property.propertyName}".`);
    }
    byName.set(property.propertyName, property);
  }

  const primaryKey = def.primaryKey ? def.primaryKey.properties.map((name) => {
    const property = byName.get(name); if (!property) throw new ModelBuildError(`Dynamic table "${def.name}": primary key references unknown field "${name}".`); return { ...property, isKey: true, required: true, generation: "none" as const };
  }) : [key!];
  if (new Set(primaryKey.map((property) => property.propertyName)).size !== primaryKey.length) throw new ModelBuildError(`Dynamic table "${def.name}": duplicate primary key property.`);
  for (const primary of primaryKey) { const index = properties.findIndex((property) => property.propertyName === primary.propertyName); properties[index] = primary; byName.set(primary.propertyName, primary); }
  const physicalName = def.tableName ?? def.name;
  const tableName = def.schema ? `${def.schema}.${physicalName}` : physicalName;
  registerDynamicTableIdentity(ctor, { schema: def.schema || undefined, table: physicalName });

  assertExternalTargetsResolvable(def, resolveTarget);
  const targetCtor = targetResolver(def.name, ctor, resolveTarget);
  const relations = buildRelations(def, byName, targetCtor);
  const relationByName = new Map(relations.map((relation) => [relation.navigationName, relation]));
  const foreignKeys: ForeignKeyModel[] = def.fields
    .filter((field) => field.type === "foreignKey")
    .map((field) => ({ property: field.name, properties: [field.name], target: () => targetCtor(field.target!), onDelete: "noAction" as const, onUpdate: "noAction" as const }));

  for (const fk of def.foreignKeys ?? []) {
    if (fk.properties.length === 0 || new Set(fk.properties).size !== fk.properties.length) throw new ModelBuildError(`Dynamic table "${def.name}": invalid composite foreign key.`);
    for (const name of fk.properties) if (!byName.has(name)) throw new ModelBuildError(`Dynamic table "${def.name}": foreign key references unknown field "${name}".`);
    foreignKeys.push({ property: fk.properties[0]!, properties: [...fk.properties], name: fk.name ?? `fk_${physicalName}_${fk.properties.join("_")}`, target: () => targetCtor(fk.target), onDelete: fk.onDelete ?? "noAction", onUpdate: fk.onUpdate ?? "noAction" });
  }
  const checks: CheckModel[] = (def.checks ?? []).map((check) => ({ name: check.name, expression: compileCheck(check.predicate) }));
  for (const check of checks) validateCheckAst(check.expression, properties);
  return {
    ctor,
    name: def.name,
    tableName,
    properties,
    key: primaryKey as [PropertyModel, ...PropertyModel[]],
    keyName: def.primaryKey?.name,
    indexes: buildIndexes(def, physicalName, byName),
    checks,
    relations,
    foreignKeys,
    queryFilters: [],
    softDeleteProperty: def.softDeleteProperty,
    propertyByName: (name: string) => byName.get(name),
    relationByName: (name: string) => relationByName.get(name),
  };
}

function validateGraphForeignKeys(model: EntityModel, modelByCtor: ReadonlyMap<EntityClass, EntityModel>): EntityModel {
  const checks = [...model.checks];
  const names = new Set(checks.map((check) => check.name));
  if (names.size !== checks.length) throw new ModelBuildError(`Dynamic table "${model.name}" has duplicate CHECK names.`);
  for (const relation of model.relations) {
    if (!modelByCtor.has(relation.target())) {
      throw new ModelBuildError(`Dynamic table "${model.name}" relation target is outside its schema contract.`);
    }
  }
  const shapes = new Set<string>();
  const foreignKeys: ForeignKeyModel[] = [];

  for (const foreignKey of model.foreignKeys) {
    const target = modelByCtor.get(foreignKey.target());
    if (!target) throw new ModelBuildError(`Dynamic table "${model.name}" has a foreign key target outside its schema contract.`);
    const locals = foreignKey.properties.map((property) => model.propertyByName(property));
    if (locals.some((property) => !property)) throw new ModelBuildError(`Dynamic table "${model.name}" foreign key references an unknown field.`);
    if (locals.length !== target.key.length) {
      throw new ModelBuildError(`Dynamic table "${model.name}" foreign key must target the complete primary key of "${target.name}".`);
    }
    for (let index = 0; index < locals.length; index += 1) {
      if (locals[index]!.type !== target.key[index]!.type) {
        throw new ModelBuildError(`Dynamic table "${model.name}" foreign key component types/order do not match target primary key "${target.name}".`);
      }
    }
    const nullable = locals.map((property) => !property!.required);
    if (nullable.some(Boolean) && !nullable.every(Boolean)) {
      throw new ModelBuildError(`Dynamic table "${model.name}" nullable composite foreign key must be all nullable or all required.`);
    }
    if ((foreignKey.onDelete === "setNull" || foreignKey.onUpdate === "setNull") && !nullable.every(Boolean)) {
      throw new ModelBuildError(`Dynamic table "${model.name}" setNull requires nullable foreign key components.`);
    }
    const name = foreignKey.name ?? `fk_${model.tableName}_${foreignKey.properties.join("_")}`;
    const shape = `${foreignKey.properties.join("\0")}\0${target.name}`;
    if (names.has(name) || shapes.has(shape)) {
      throw new ModelBuildError(`Dynamic table "${model.name}" has duplicate or conflicting foreign key "${name}".`);
    }
    names.add(name);
    shapes.add(shape);
    foreignKeys.push({ ...foreignKey, name });
    if (nullable.every(Boolean) && locals.length > 1) {
      const companionName = `ck_${model.tableName}_${foreignKey.properties.join("_")}_tuple`;
      if (names.has(companionName)) throw new ModelBuildError(`Dynamic table "${model.name}" has conflicting CHECK name "${companionName}".`);
      names.add(companionName);
      checks.push(nullableTupleCheck(companionName, locals as PropertyModel[]));
    }
  }
  return { ...model, foreignKeys, checks };
}

function nullableTupleCheck(name: string, properties: readonly PropertyModel[]): CheckModel {
  let allNull: CheckModel["expression"] = { kind: "null", left: properties[0]!.propertyName, not: false };
  let allPresent: CheckModel["expression"] = { kind: "null", left: properties[0]!.propertyName, not: true };
  for (const property of properties.slice(1)) {
    allNull = { kind: "and", left: allNull, right: { kind: "null", left: property.propertyName, not: false } };
    allPresent = { kind: "and", left: allPresent, right: { kind: "null", left: property.propertyName, not: true } };
  }
  return { name, expression: { kind: "or", left: allNull, right: allPresent } };
}

function buildRelations(
  def: DynamicTableDefinition,
  byName: Map<string, PropertyModel>,
  resolveTarget: DynamicTargetResolver,
): RelationModel[] {
  const fieldReferences: DynamicRelationDefinition[] = def.fields
    .filter((field) => field.type === "foreignKey")
    .map((field) => ({
      navigationName: field.navigationName!,
      kind: "reference",
      target: field.target!,
      foreignKey: field.name,
    }));
  const definitions = [...fieldReferences, ...(def.relations ?? [])];
  if (definitions.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const relations: RelationModel[] = [];
  for (const relation of definitions) {
    if (seen.has(relation.navigationName)) {
      throw new ModelBuildError(`Dynamic table "${def.name}": duplicate navigation "${relation.navigationName}".`);
    }
    seen.add(relation.navigationName);
    if (byName.has(relation.navigationName)) {
      throw new ModelBuildError(
        `Dynamic table "${def.name}": navigation "${relation.navigationName}" collides with a field.`,
      );
    }
    // For reference the foreign key is a property of this table; for collection it is on the target.
    const relationKeys = typeof relation.foreignKey === "string" ? [relation.foreignKey] : relation.foreignKey;
    if (relation.kind === "reference" && relationKeys.some((key) => !byName.has(key))) {
      throw new ModelBuildError(
        `Dynamic table "${def.name}": relation "${relation.navigationName}" references unknown foreign key "${relation.foreignKey}".`,
      );
    }
    const targetName = relation.target;
    relations.push({
      navigationName: relation.navigationName,
      kind: relation.kind,
      foreignKey: relation.foreignKey,
      target: () => resolveTarget(targetName),
    });
  }
  return relations;
}

function buildProperty(tableName: string, field: DynamicFieldDefinition): PropertyModel {
  if (field.type === "foreignKey") {
    return buildForeignKeyProperty(tableName, field);
  }
  const isKey = field.isKey === true;
  const storageType = LOGICAL_TO_STORAGE[field.type];
  if (!storageType) {
    throw new ModelBuildError(`Dynamic table "${tableName}": unknown field type "${field.type}" for "${field.name}".`);
  }

  // An integer key is auto-increment (identity) by default.
  const generation: KeyGeneration =
    isKey && storageType === "integer" ? "identity" : isKey && field.type === "uuid" ? "uuid" : "none";
  const convention: PropertyConvention | undefined =
    field.convention ?? (field.type === "uuid" && !isKey ? "uuid" : undefined);
  const required = isKey || field.required === true || convention === "createdAt" || convention === "updatedAt";

  return {
    propertyName: field.name,
    columnName: field.columnName ?? field.name,
    type: storageType,
    isKey,
    generation,
    required,
    convention,
    uuidVersion: field.uuidVersion,
    databaseDefault: generation === "uuid" ? { kind: "uuidV4" } : { kind: "none" },
  };
}

function buildForeignKeyProperty(tableName: string, field: DynamicFieldDefinition): PropertyModel {
  if (!field.target) {
    throw new ModelBuildError(`Dynamic table "${tableName}": foreign key field "${field.name}" has no target.`);
  }
  if (!field.navigationName) {
    throw new ModelBuildError(`Dynamic table "${tableName}": foreign key field "${field.name}" has no navigationName.`);
  }
  if (!field.targetKeyType) {
    throw new ModelBuildError(`Dynamic table "${tableName}": foreign key field "${field.name}" has no targetKeyType.`);
  }
  if (field.isKey === true) {
    throw new ModelBuildError(`Dynamic table "${tableName}": foreign key field "${field.name}" cannot be a primary key.`);
  }
  if (field.convention !== undefined || field.uuidVersion !== undefined) {
    throw new ModelBuildError(
      `Dynamic table "${tableName}": foreign key field "${field.name}" cannot declare convention or uuidVersion.`,
    );
  }

  const storageType = LOGICAL_TO_STORAGE[field.targetKeyType];
  if (!storageType) {
    throw new ModelBuildError(
      `Dynamic table "${tableName}": foreign key field "${field.name}" has unknown targetKeyType "${field.targetKeyType}".`,
    );
  }

  return {
    propertyName: field.name,
    columnName: field.columnName ?? field.name,
    type: storageType,
    isKey: false,
    generation: "none",
    required: field.required === true,
    databaseDefault: { kind: "none" },
  };
}

function assertExternalTargetsResolvable(
  def: DynamicTableDefinition,
  resolveTarget?: DynamicTargetResolver,
): void {
  if (resolveTarget) return;
  const externalTarget = [
    ...def.fields.filter((field) => field.type === "foreignKey").map((field) => field.target),
    ...(def.relations ?? []).map((relation) => relation.target),
  ].find((target) => target !== undefined && target !== def.name);
  if (externalTarget) {
    throw new ModelBuildError(
      `Dynamic table "${def.name}" references target "${externalTarget}" but no target resolver was provided.`,
    );
  }
}

function targetResolver(
  sourceName: string,
  sourceCtor: EntityClass,
  resolveTarget?: DynamicTargetResolver,
): DynamicTargetResolver {
  return (targetName) => {
    if (targetName === sourceName) return sourceCtor;
    if (!resolveTarget) {
      throw new ModelBuildError(
        `Dynamic table "${sourceName}" references target "${targetName}" but no target resolver was provided.`,
      );
    }
    return resolveTarget(targetName);
  };
}

function buildIndexes(
  def: DynamicTableDefinition,
  physicalName: string,
  byName: Map<string, PropertyModel>,
): IndexModel[] {
  const indexes: IndexModel[] = [];
  const base = physicalName.toLowerCase();

  // Indexes from field flags (unique/indexed).
  for (const field of def.fields) {
    if (!field.unique && !field.indexed) {
      continue;
    }
    const column = field.columnName ?? field.name;
    indexes.push({ name: `ix_${base}_${column}`, columns: [column], unique: field.unique === true });
  }

  // Explicit composite indexes.
  for (const index of def.indexes ?? []) {
    for (const column of index.columns) {
      if (![...byName.values()].some((property) => property.columnName === column)) {
        throw new ModelBuildError(`Dynamic table "${def.name}": index references unknown column "${column}".`);
      }
    }
    indexes.push({
      name: index.name ?? `ix_${base}_${index.columns.join("_")}`,
      columns: index.columns,
      unique: index.unique === true,
    });
  }

  const names = new Set<string>();
  for (const index of indexes) {
    if (!index.columns.length || new Set(index.columns).size !== index.columns.length) {
      throw new ModelBuildError(`Dynamic table "${def.name}": index must contain distinct columns.`);
    }
    if (names.has(index.name)) throw new ModelBuildError(`Dynamic table "${def.name}": duplicate index name "${index.name}".`);
    names.add(index.name);
  }
  return indexes;
}
