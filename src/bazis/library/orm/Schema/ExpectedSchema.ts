import type { EntityModel, PropertyModel } from "../Metadata/types";
import type { OrmModel } from "../Metadata/OrmModel";
import type { CanonicalDefault, GenerationStrategy } from "./introspection";
import { projectCheckAstIdentifiers, type CheckAst } from "./CheckExpression";
import { crossUnitForeignKey, physicalColumnTypes } from "./physicalColumnTypes";
import { SchemaAdmissionError } from "../errors";
import { foreignKeyName, physicalTableIdentity, primaryKeyName } from "./tableKey";

export interface ExpectedColumn { readonly property: string; readonly column: string; readonly physicalType: string; readonly nullable: boolean; readonly default: CanonicalDefault; readonly generation: GenerationStrategy }
export interface ExpectedTable { readonly schema: string; readonly table: string; readonly columns: readonly ExpectedColumn[]; readonly primaryKey: { readonly name: string; readonly columns: readonly string[] }; readonly indexes: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean; readonly method: "btree"; readonly predicate?: CheckAst }[]; readonly foreignKeys: readonly { readonly name: string; readonly columns: readonly string[]; readonly target: { readonly schema: string; readonly table: string }; readonly targetColumns: readonly string[]; readonly onDelete: string; readonly onUpdate: string }[]; readonly checks: readonly { readonly name: string; readonly expression: unknown }[] }
export interface OrmExpectedSchema { readonly tables: readonly ExpectedTable[] }

const schemaOf = (model: EntityModel) => physicalTableIdentity(model).schema?.trim() || "public";

/** Pure expected physical contract compiled solely from the explicit entity unit. */
export function compileExpectedSchema(models: OrmModel): OrmExpectedSchema {
  const byCtor = new Map(models.entities.map((model) => [model.ctor, model]));
  const identities = new Map<string, string>();
  const types = physicalColumnTypes(models.entities);
  const tables = models.entities.map((model) => compileTable(model, byCtor, identities, types));
  return { tables: Object.freeze(tables.sort((a, b) => Buffer.compare(Buffer.from(`${a.schema}\0${a.table}`, "utf8"), Buffer.from(`${b.schema}\0${b.table}`, "utf8")))) };
}

function compileTable(model: EntityModel, byCtor: ReadonlyMap<EntityModel["ctor"], EntityModel>, identities: Map<string, string>, types: ReturnType<typeof physicalColumnTypes>): ExpectedTable {
  const schema = schemaOf(model);
  const table = physicalTableIdentity(model).table;
  const identity = `${schema}\0${table}`;
  const other = identities.get(identity);
  if (other !== undefined) throw new SchemaAdmissionError("ORM_SCHEMA_OWNERSHIP_CONFLICT", `Entities "${other}" and "${model.name}" both map table "${schema}"."${table}"; one table belongs to one entity.`);
  identities.set(identity, model.name);
  const columns = model.properties.map((property) => ({
    property: property.propertyName,
    column: property.columnName,
    physicalType: property.type === "decimal" ? decimalPhysicalType(property) : types.get(property)!,
    nullable: !property.required,
    default: property.databaseDefault,
    generation: property.generation === "identity" ? "identityByDefault" as const : property.generation === "uuid" ? "uuidDefault" as const : "none" as const,
  }));
  const foreignKeys = model.foreignKeys.map((foreignKey) => {
    const target = byCtor.get(foreignKey.target());
    if (!target) throw crossUnitForeignKey(model, foreignKey.properties, foreignKey.target());
    return { name: foreignKeyName(model, foreignKey), columns: foreignKey.properties.map((name) => model.propertyByName(name)!.columnName), target: { schema: schemaOf(target), table: physicalTableIdentity(target).table }, targetColumns: target.key.map((property) => property.columnName), onDelete: foreignKey.onDelete, onUpdate: foreignKey.onUpdate };
  });
  return Object.freeze({ schema, table, columns: Object.freeze(columns), primaryKey: Object.freeze({ name: primaryKeyName(model), columns: Object.freeze(model.key.map((property) => property.columnName)) }), indexes: Object.freeze(model.indexes.map((index) => Object.freeze({ name: index.name, columns: Object.freeze([...index.columns]), unique: index.unique, method: "btree" as const, ...(index.where === undefined ? {} : { predicate: projectCheckAstIdentifiers(index.where, (name) => model.propertyByName(name)!.columnName) }) }))), foreignKeys: Object.freeze(foreignKeys), checks: Object.freeze(model.checks.map((check) => Object.freeze({ name: check.name, expression: projectCheckAstIdentifiers(check.expression, (name) => model.propertyByName(name)!.columnName) }))) });
}

/** `decimal(12,2)` for numeric(12, 2), `decimal` for an unbounded numeric: the catalog reports the same label. */
export function decimalPhysicalType(property: Pick<PropertyModel, "precision" | "scale">): string {
  return property.precision === undefined ? "decimal" : `decimal(${property.precision},${property.scale ?? 0})`;
}
