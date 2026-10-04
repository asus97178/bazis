import { ModelBuildError } from "../errors";
import { readRawEntity, type RawProperty } from "./decorators";
import { defaultTableName, isConventionalKey, resolveColumnType } from "./conventions";
import { validateCheckAst } from "../Schema/CheckExpression";
import type {
  EntityModel,
  ForeignKeyModel,
  IndexModel,
  CheckModel,
  KeyGeneration,
  PropertyModel,
  RelationModel,
} from "./types";
import type { CanonicalDefault } from "../Schema/introspection";

/**
 * Превращает сырые метаданные класса (декораторы) в скомпилированную
 * `EntityModel`, применяя соглашения там, где явных настроек нет.
 * Любая ошибка конфигурации — `ModelBuildError` на старте (fail fast).
 */
export class ModelBuilder {
  static build(ctor: new () => object): EntityModel {
    return ModelBuilder.buildGraph(ctor, new Map());
  }

  private static buildGraph(ctor: new () => object, graph: Map<new () => object, EntityModel>): EntityModel {
    const cached = graph.get(ctor);
    if (cached) return cached;
    const raw = readRawEntity(ctor);
    if (!raw) {
      throw new ModelBuildError(`Class "${ctor.name}" is not an entity. Add the @Entity() decorator.`);
    }
    if (raw.properties.size === 0) {
      throw new ModelBuildError(`Entity "${ctor.name}" has no mapped properties. Annotate fields with @Column()/@Key().`);
    }

    const properties: PropertyModel[] = [];
    const indexes: IndexModel[] = [];
    const foreignKeys: ForeignKeyModel[] = [];
    let explicitKey: PropertyModel | undefined;

    for (const rawProp of raw.properties.values()) {
      const property = ModelBuilder.buildProperty(ctor.name, rawProp);
      properties.push(property);
      if (property.isKey) {
        if (explicitKey) {
          throw new ModelBuildError(
            `Entity "${ctor.name}" declares multiple scalar keys.`,
          );
        }
        explicitKey = property;
      }
      if (rawProp.index) {
        indexes.push({
          name: rawProp.index.name ?? `ix_${defaultTableName(ctor.name).toLowerCase()}_${property.columnName}`,
          columns: [property.columnName],
          unique: rawProp.index.unique,
        });
      }
      if (rawProp.fkTarget) {
        foreignKeys.push({ property: property.propertyName, properties: [property.propertyName], target: rawProp.fkTarget, onDelete: "noAction", onUpdate: "noAction" });
      }
    }

    const relations: RelationModel[] = raw.relations.map((relation) => ({
      navigationName: relation.navigationName,
      kind: relation.kind,
      target: relation.target,
      foreignKey: relation.foreignKey,
    }));
    // Reference-связи неявно объявляют внешний ключ для DDL.
    for (const relation of relations) {
      const names = Array.isArray(relation.foreignKey) ? relation.foreignKey : [relation.foreignKey];
      if (relation.kind === "reference" && !foreignKeys.some((fk) => fk.properties.join("\0") === names.join("\0"))) {
        foreignKeys.push({ property: names[0]!, properties: names, target: relation.target, onDelete: "noAction", onUpdate: "noAction" });
      }
    }

    if (!explicitKey && !raw.keyDeclaration) {
      const inferredIndex = properties.findIndex((property) => isConventionalKey(property.propertyName, ctor.name));
      if (inferredIndex < 0) {
        throw new ModelBuildError(
          `Entity "${ctor.name}" has no primary key. Mark a property with @Key() or name one "id" / "${ctor.name}Id".`,
        );
      }
      const base = properties[inferredIndex]!;
      explicitKey = {
        ...base,
        isKey: true,
        generation: base.type === "integer" ? "identity" : "none",
        required: true,
      };
      properties[inferredIndex] = explicitKey;
    }

    const byName = new Map<string, PropertyModel>();
    for (const property of properties) {
      byName.set(property.propertyName, property);
    }
    const relationByName = new Map<string, RelationModel>();
    const checks: CheckModel[] = (raw.checks ?? []).map((check) => {
      if (raw.checks!.filter((candidate) => candidate.name === check.name).length > 1) throw new ModelBuildError(`Entity "${ctor.name}": duplicate CHECK name "${check.name}".`);
      return check;
    });
    for (const relation of relations) {
      if (byName.has(relation.navigationName)) {
        throw new ModelBuildError(
          `Entity "${ctor.name}": "${relation.navigationName}" is both a column and a navigation. Use distinct names.`,
        );
      }
      relationByName.set(relation.navigationName, relation);
    }
    // FK reference-связи должен существовать как замапленная колонка.
    for (const relation of relations) {
      const relationForeignKeys = Array.isArray(relation.foreignKey) ? relation.foreignKey : [relation.foreignKey];
      if (relation.kind === "reference" && relationForeignKeys.some((name) => !byName.has(name))) {
        throw new ModelBuildError(
          `Entity "${ctor.name}": navigation "${relation.navigationName}" references an unmapped foreign key property.`,
        );
      }
    }

    const primaryKey = ModelBuilder.primaryKeyFor(ctor, raw, properties, byName, explicitKey);
    for (const primary of primaryKey) {
      const index = properties.findIndex((property) => property.propertyName === primary.propertyName);
      properties[index] = primary;
      byName.set(primary.propertyName, primary);
    }

    const tableName = raw.table ?? defaultTableName(ctor.name);
    const model: EntityModel = {
      ctor,
      name: ctor.name,
      tableName,
      schema: raw.schema,
      autoMigrate: raw.migrate === true,
      properties,
      key: primaryKey,
      keyName: raw.keyDeclaration?.name,
      indexes,
      checks,
      relations,
      foreignKeys,
      queryFilters: raw.queryFilters ?? [],
      softDeleteProperty: raw.softDeleteProperty,
      propertyByName: (name: string) => byName.get(name),
      relationByName: (name: string) => relationByName.get(name),
    };
    graph.set(ctor, model);

    for (const declared of raw.foreignKeys ?? []) {
      if (new Set(declared.properties).size !== declared.properties.length) throw new ModelBuildError(`Entity "${ctor.name}": foreign key contains duplicate properties.`);
      for (const name of declared.properties) if (!byName.has(name)) throw new ModelBuildError(`Entity "${ctor.name}": foreign key references unknown property "${name}".`);
      const targetKey = ModelBuilder.buildGraph(declared.target(), graph).key;
      if (targetKey.length !== declared.properties.length) throw new ModelBuildError(`Entity "${ctor.name}": foreign key must target the complete primary key.`);
      const locals = declared.properties.map((name) => byName.get(name)!);
      for (let index = 0; index < locals.length; index += 1) if (locals[index]!.type !== targetKey[index]!.type) throw new ModelBuildError(`Entity "${ctor.name}": foreign key component types/order do not match target primary key.`);
      const nullable = locals.map((property) => !property.required);
      if (nullable.some(Boolean) && !nullable.every(Boolean)) throw new ModelBuildError(`Entity "${ctor.name}": nullable composite foreign key must be all nullable or all required.`);
      if ((declared.onDelete === "setNull" || declared.onUpdate === "setNull") && !nullable.every(Boolean)) throw new ModelBuildError(`Entity "${ctor.name}": setNull requires nullable foreign key components.`);
      foreignKeys.push({ property: declared.properties[0]!, properties: declared.properties, name: declared.name ?? `fk_${(raw.table ?? defaultTableName(ctor.name)).toLowerCase()}_${declared.properties.join("_")}`, target: declared.target, onDelete: declared.onDelete ?? "noAction", onUpdate: declared.onUpdate ?? "noAction" });
      if (nullable.every(Boolean) && locals.length > 1) {
        let allNull: CheckModel["expression"] = { kind: "null", left: locals[0]!.propertyName, not: false };
        let allPresent: CheckModel["expression"] = { kind: "null", left: locals[0]!.propertyName, not: true };
        for (const property of locals.slice(1)) { allNull = { kind: "and", left: allNull, right: { kind: "null", left: property.propertyName, not: false } }; allPresent = { kind: "and", left: allPresent, right: { kind: "null", left: property.propertyName, not: true } }; }
        checks.push({ name: `ck_${(raw.table ?? defaultTableName(ctor.name)).toLowerCase()}_${declared.properties.join("_")}_tuple`, expression: { kind: "or", left: allNull, right: allPresent } });
      }
    }

    for (const check of checks) validateCheckAst(check.expression, properties);
    for (const declared of raw.indexes ?? []) {
      const columns = declared.properties.map((name) => {
        const property = byName.get(name);
        if (!property) throw new ModelBuildError(`Entity "${ctor.name}": index references unknown property "${name}".`);
        return property.columnName;
      });
      if (new Set(columns).size !== columns.length) throw new ModelBuildError(`Entity "${ctor.name}": index contains duplicate properties.`);
      indexes.push({ name: declared.name ?? `ix_${(raw.table ?? defaultTableName(ctor.name)).toLowerCase()}_${columns.join("_")}`, columns, unique: declared.unique });
    }
    const indexNames = new Set<string>();
    for (const index of indexes) {
      if (indexNames.has(index.name)) throw new ModelBuildError(`Entity "${ctor.name}": duplicate index name "${index.name}".`);
      indexNames.add(index.name);
    }
    return model;
  }

  private static buildProperty(entityName: string, raw: RawProperty): PropertyModel {
    const isKey = raw.isKey === true;
    const resolved = resolveColumnType(raw.type, isKey);
    const storageType = resolved.storageType;
    let convention = raw.convention ?? resolved.convention;
    let generated: KeyGeneration = "none";
    if (isKey) {
      if (convention === "uuid" || raw.type === "uuid") {
        generated = "uuid";
        convention = undefined;
      } else if (raw.keyGenerated ?? storageType === "integer") {
        generated = "identity";
      }
    }
    if (raw.keyGenerated === true && generated !== "identity") {
      throw new ModelBuildError(
        `Entity "${entityName}": key "${raw.propertyName}" has keyGenerated=true but is not an integer identity key.`,
      );
    }
    if (raw.uuidVersion === "v7") throw new ModelBuildError(`Entity "${entityName}": UUID v7 is not supported by PostgreSQL exact schema admission.`);
    // Ключ и семантические timestamp-поля всегда NOT NULL.
    const required =
      isKey ||
      raw.required === true ||
      raw.nullable === false ||
      resolved.impliedRequired === true;
    const databaseDefault = ModelBuilder.defaultFor(entityName, raw, storageType, isKey, generated, convention, required);
    return {
      propertyName: raw.propertyName,
      columnName: raw.columnName ?? raw.propertyName,
      type: storageType,
      isKey,
      generation: generated,
      required,
      converter: raw.converter,
      convention,
      uuidVersion: raw.uuidVersion,
      databaseDefault,
    };
  }

  private static primaryKeyFor(
    ctor: new () => object,
    raw: NonNullable<ReturnType<typeof readRawEntity>>,
    properties: PropertyModel[],
    byName: ReadonlyMap<string, PropertyModel>,
    initialKey: PropertyModel | undefined,
  ): [PropertyModel, ...PropertyModel[]] {
    let explicitKey = initialKey;
    if (!explicitKey && !raw.keyDeclaration) {
      const inferredIndex = properties.findIndex((property) => isConventionalKey(property.propertyName, ctor.name));
      if (inferredIndex < 0) throw new ModelBuildError(`Entity "${ctor.name}" has no primary key. Mark a property with @Key() or name one "id" / "${ctor.name}Id".`);
      const base = properties[inferredIndex]!;
      explicitKey = { ...base, isKey: true, generation: base.type === "integer" ? "identity" : "none", required: true };
      properties[inferredIndex] = explicitKey;
    }
    const primaryKey = raw.keyDeclaration
      ? raw.keyDeclaration.properties.map((name) => {
          const property = byName.get(name);
          if (!property) throw new ModelBuildError(`Entity "${ctor.name}": primary key references unknown property "${name}".`);
          return { ...property, isKey: true, required: true, generation: raw.keyDeclaration!.composite ? "none" : property.generation };
        })
      : [explicitKey!];
    if (new Set(primaryKey.map((property) => property.propertyName)).size !== primaryKey.length) throw new ModelBuildError(`Entity "${ctor.name}": primary key contains duplicate properties.`);
    if (raw.keyDeclaration?.composite && (!raw.keyDeclaration.properties.includes(raw.keyDeclaration.anchor) || raw.keyDeclaration.properties.length < 2)) throw new ModelBuildError(`Entity "${ctor.name}": composite @Key must contain its anchor and at least two properties.`);
    if (primaryKey.length > 1 && primaryKey.some((property) => property.generation !== "none")) throw new ModelBuildError(`Entity "${ctor.name}": generated composite primary-key components are not supported.`);
    if (primaryKey.some((property) => property.generation === "none" && property.databaseDefault.kind !== "none")) throw new ModelBuildError(`Entity "${ctor.name}": primary-key components cannot declare database defaults.`);
    return primaryKey as [PropertyModel, ...PropertyModel[]];
  }

  private static defaultFor(entityName: string, raw: RawProperty, type: PropertyModel["type"], isKey: boolean, generation: KeyGeneration, convention: PropertyModel["convention"], required: boolean): CanonicalDefault {
    if (raw.default === undefined) return generation === "uuid" ? { kind: "uuidV4" } : { kind: "none" };
    if (isKey || generation !== "none" || convention !== undefined || raw.converter !== undefined) throw new ModelBuildError(`Entity "${entityName}": database default is not allowed on key/generated/converter/convention property "${raw.propertyName}".`);
    const value = raw.default;
    if (value === null) {
      if (required) throw new ModelBuildError(`Entity "${entityName}": NULL database default requires a nullable property "${raw.propertyName}".`);
      return { kind: "null" };
    }
    if (typeof value === "boolean") {
      if (type !== "boolean" && type !== "json") throw new ModelBuildError(`Entity "${entityName}": boolean database default does not match "${raw.propertyName}".`);
      return { kind: "boolean", value };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (type === "integer" && (!Number.isSafeInteger(value))) || (type !== "integer" && type !== "real" && type !== "json")) throw new ModelBuildError(`Entity "${entityName}": numeric database default is invalid for "${raw.propertyName}".`);
      return { kind: "number", value };
    }
    if (typeof value === "string") {
      if (value.length > 1024) throw new ModelBuildError(`Entity "${entityName}": database default string exceeds 1024 code units.`);
      if (type === "datetime" && !isCanonicalRfc3339(value)) throw new ModelBuildError(`Entity "${entityName}": datetime database default must be canonical RFC3339 with timezone.`);
      if (type !== "text" && type !== "datetime" && type !== "json") throw new ModelBuildError(`Entity "${entityName}": string database default does not match "${raw.propertyName}".`);
      return { kind: "string", value };
    }
    throw new ModelBuildError(`Entity "${entityName}": database default is not a supported literal for "${raw.propertyName}".`);
  }
}

function isCanonicalRfc3339(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined || zone === undefined) return false;
  const numeric: readonly [number, number, number, number, number, number] = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)];
  if (numeric[1] < 1 || numeric[1] > 12 || numeric[2] < 1 || numeric[3] > 23 || numeric[4] > 59 || numeric[5] > 59) return false;
  const days = new Date(Date.UTC(numeric[0], numeric[1], 0)).getUTCDate();
  if (numeric[2] > days) return false;
  if (zone !== "Z") {
    const [offsetHourText, offsetMinuteText] = zone.slice(1).split(":");
    if (offsetHourText === undefined || offsetMinuteText === undefined) return false;
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}
