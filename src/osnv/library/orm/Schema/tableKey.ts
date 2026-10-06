import type { EntityModel } from "../Metadata/types";

interface TableIdentity { readonly schema?: string; readonly table: string }
const dynamicIdentities = new WeakMap<EntityModel["ctor"], TableIdentity>();

/** Legacy dynamic models expose schema.table in tableName. Retain the
 * original components privately so literal dots are never parsed as SQL. */
export function registerDynamicTableIdentity(ctor: EntityModel["ctor"], identity: TableIdentity): void {
  dynamicIdentities.set(ctor, Object.freeze({ ...identity }));
}

export function physicalTableIdentity(model: EntityModel): TableIdentity {
  const dynamic = dynamicIdentities.get(model.ctor);
  if (model.schema === undefined && dynamic && model.tableName === (dynamic.schema ? `${dynamic.schema}.${dynamic.table}` : dynamic.table)) return dynamic;
  return { schema: model.schema, table: model.tableName };
}

/** Table key in the introspection / diff for an `EntityModel`. */
export function entityStorageKey(model: EntityModel): string {
  return model.schema !== undefined ? `${model.schema}.${model.tableName}` : model.tableName;
}

/** Table key from a PostgreSQL introspection row. */
export function introspectedTableKey(schema: string, table: string): string {
  return schema === "public" ? table : `${schema}.${table}`;
}
