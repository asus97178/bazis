import { isUuidKeyGeneration, type ColumnType, type EntityModel, type PropertyModel } from "../Metadata/types";
import { SchemaAdmissionError } from "../errors";

/** Resolve the physical FK contract without changing logical converter types.
 * UUID storage follows referenced keys, including PK/FK chains and cycles. */
export function physicalColumnTypes(models: readonly EntityModel[]): ReadonlyMap<PropertyModel, ColumnType | "uuid"> {
  const byCtor = new Map(models.map((model) => [model.ctor, model]));
  const result = new Map<PropertyModel, ColumnType | "uuid">();
  const pairs: [PropertyModel, PropertyModel][] = [];
  for (const model of models) {
    for (const property of model.properties) result.set(property, isUuidKeyGeneration(property.generation) ? "uuid" : property.type);
    for (const fk of model.foreignKeys) {
      const target = byCtor.get(fk.target());
      if (!target) throw crossUnitForeignKey(model, fk.properties, fk.target());
      if (fk.properties.length !== target.key.length) throw new Error("ORM_SCHEMA_FOREIGN_KEY_ARITY");
      fk.properties.forEach((name, index) => {
        const local = model.propertyByName(name);
        if (!local) throw new Error("ORM_SCHEMA_FOREIGN_KEY_PROPERTY");
        pairs.push([local, target.key[index]!]);
      });
    }
  }
  // Monotonic propagation terminates: each text column can become UUID once.
  let changed: boolean;
  do {
    changed = false;
    for (const [local, target] of pairs) {
      if (result.get(target) === "uuid" && result.get(local) === "text" && local.generation === "none") {
        result.set(local, "uuid");
        changed = true;
      }
    }
  } while (changed);
  for (const [local, target] of pairs) {
    if (result.get(local) !== result.get(target)) throw new Error("ORM_SCHEMA_FOREIGN_KEY_TYPE_MISMATCH");
  }
  return result;
}

/** A database foreign key cannot leave the context that creates the schema. */
export function crossUnitForeignKey(model: EntityModel, properties: readonly string[], target: new () => object): SchemaAdmissionError {
  const columns = properties.join(", ");
  return new SchemaAdmissionError("ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY", `Entity "${model.name}" has a foreign key (${columns}) to "${target.name}", which is not an entity of the same DbContext. A database foreign key can only point to an entity of the same context: keep ${columns} as a plain column without @ManyToOne, or map both entities in one context.`);
}
