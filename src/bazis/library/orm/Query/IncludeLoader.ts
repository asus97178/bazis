import { OrmError } from "../errors";
import type { EntityModel } from "../Metadata/types";
import { KeyTuple } from "../Metadata/KeyTuple";
import { maxParametersPerInList } from "../Providers/limits";
import type { DbContextRuntime } from "../runtime";
import { materialize } from "./materialize";
import { EMPTY_PLAN } from "./QueryPlan";
import { SqlTranslator } from "./SqlTranslator";

interface Level {
  readonly model: EntityModel;
  readonly entities: object[];
}

/**
 * Eager loading of navigations with split queries: for each level of the path,
 * related entities are loaded with one `WHERE key IN (...)` query and stitched
 * together in memory. This avoids the Cartesian product of collection JOINs.
 */
export class IncludeLoader {
  constructor(private readonly runtime: DbContextRuntime) {}

  async load(rootModel: EntityModel, roots: object[], paths: readonly (readonly string[])[], noTracking: boolean): Promise<void> {
    if (roots.length === 0) {
      return;
    }
    const root: Level = { model: rootModel, entities: roots };
    // A shared prefix must retain the same instances even without tracking.
    // Keep this cache local: another execution must read its own graph.
    const loaded = new Map<Level, Map<string, Level>>();
    for (const path of paths) {
      let level = root;
      for (const navigationName of path) {
        let navigations = loaded.get(level);
        if (!navigations) {
          navigations = new Map();
          loaded.set(level, navigations);
        }
        let next = navigations.get(navigationName);
        if (!next) {
          next = await this.loadLevel(level, navigationName, noTracking);
          navigations.set(navigationName, next);
        }
        level = next;
        if (level.entities.length === 0) {
          break;
        }
      }
    }
  }

  private async loadLevel(parent: Level, navigationName: string, noTracking: boolean): Promise<Level> {
    const relation = parent.model.relationByName(navigationName);
    if (!relation) {
      throw new OrmError(`Navigation "${navigationName}" is not defined on entity "${parent.model.name}".`);
    }
    const targetModel = this.runtime.models.targetModel(relation.target);
    if (relation.kind === "reference") {
      return this.loadReference(parent, navigationName, relation.foreignKey, targetModel, noTracking);
    }
    return this.loadCollection(parent, navigationName, relation.foreignKey, targetModel, noTracking);
  }

  /** many-to-one: the FK on the parent points to the target's key. */
  private async loadReference(
    parent: Level,
    navigationName: string,
    foreignKey: string | readonly string[],
    targetModel: EntityModel,
    noTracking: boolean,
  ): Promise<Level> {
    if (typeof foreignKey !== "string") return this.loadCompositeReference(parent, navigationName, foreignKey, targetModel, noTracking);
    const keys = this.distinct(targetModel, parent.entities.map((entity) => (entity as Record<string, unknown>)[foreignKey]));
    if (keys.length === 0) {
      for (const entity of parent.entities) {
        (entity as Record<string, unknown>)[navigationName] = null;
      }
      return { model: targetModel, entities: [] };
    }

    const targetKey = this.scalarKey(targetModel);
    const children = await this.queryIn(targetModel, targetKey.propertyName, keys, noTracking);
    const byKey = new Map<string, object>();
    for (const child of children) {
      byKey.set(this.tuple(targetModel, [(child as Record<string, unknown>)[targetKey.propertyName]])!, child);
    }
    for (const entity of parent.entities) {
      const fk = (entity as Record<string, unknown>)[foreignKey];
      const key = this.tuple(targetModel, [fk]);
      (entity as Record<string, unknown>)[navigationName] = key === undefined ? null : byKey.get(key) ?? null;
    }
    return { model: targetModel, entities: children };
  }

  /** one-to-many: the FK on the target points to the parent's key. */
  private async loadCollection(
    parent: Level,
    navigationName: string,
    foreignKey: string | readonly string[],
    targetModel: EntityModel,
    noTracking: boolean,
  ): Promise<Level> {
    if (typeof foreignKey !== "string") return this.loadCompositeCollection(parent, navigationName, foreignKey, targetModel, noTracking);
    const keyProperty = this.scalarKey(parent.model).propertyName;
    const keys = this.distinct(parent.model, parent.entities.map((entity) => (entity as Record<string, unknown>)[keyProperty]));

    const children = keys.length > 0 ? await this.queryIn(targetModel, foreignKey, keys, noTracking) : [];
    const groups = new Map<string, object[]>();
    for (const child of children) {
      const fk = this.tuple(parent.model, [(child as Record<string, unknown>)[foreignKey]]);
      if (fk === undefined) continue;
      const bucket = groups.get(fk);
      if (bucket) {
        bucket.push(child);
      } else {
        groups.set(fk, [child]);
      }
    }
    for (const entity of parent.entities) {
      const key = this.tuple(parent.model, [(entity as Record<string, unknown>)[keyProperty]]);
      (entity as Record<string, unknown>)[navigationName] = key === undefined ? [] : groups.get(key) ?? [];
    }
    return { model: targetModel, entities: children };
  }

  private async loadCompositeReference(parent: Level, navigationName: string, foreignKeys: readonly string[], target: EntityModel, noTracking: boolean): Promise<Level> {
    const tuples = parent.entities.map((entity) => foreignKeys.map((name) => (entity as Record<string, unknown>)[name])).filter((tuple) => tuple.every((value) => value !== null && value !== undefined));
    const children = await this.queryTuples(target, target.key.map((key) => key.propertyName), tuples, noTracking);
    const byKey = new Map(children.map((child) => [this.tuple(target, target.key.map((key) => (child as Record<string, unknown>)[key.propertyName]))!, child]));
    for (const entity of parent.entities) {
      const key = this.tuple(target, foreignKeys.map((name) => (entity as Record<string, unknown>)[name]));
      (entity as Record<string, unknown>)[navigationName] = key === undefined ? null : byKey.get(key) ?? null;
    }
    return { model: target, entities: children };
  }
  private async loadCompositeCollection(parent: Level, navigationName: string, foreignKeys: readonly string[], target: EntityModel, noTracking: boolean): Promise<Level> {
    const properties = parent.model.key.map((key) => key.propertyName); if (properties.length !== foreignKeys.length) throw new OrmError("Composite collection relation does not match parent primary key.");
    const tuples = parent.entities.map((entity) => properties.map((name) => (entity as Record<string, unknown>)[name])); const children = await this.queryTuples(target, foreignKeys, tuples, noTracking);
    const groups = new Map<string, object[]>();
    for (const child of children) {
      const key = this.tuple(parent.model, foreignKeys.map((name) => (child as Record<string, unknown>)[name]));
      if (key === undefined) continue;
      const bucket = groups.get(key);
      if (bucket) bucket.push(child); else groups.set(key, [child]);
    }
    for (const entity of parent.entities) {
      const key = this.tuple(parent.model, properties.map((name) => (entity as Record<string, unknown>)[name]));
      (entity as Record<string, unknown>)[navigationName] = key === undefined ? [] : groups.get(key) ?? [];
    }
    return { model: target, entities: children };
  }

  private scalarKey(model: EntityModel) {
    if (model.key.length !== 1) throw new Error(`IncludeLoader does not support composite legacy relation metadata for "${model.name}".`);
    return model.key[0];
  }

  private async queryIn(model: EntityModel, property: string, values: readonly unknown[], noTracking: boolean): Promise<object[]> {
    const translator = new SqlTranslator(model, this.runtime.provider.dialect);
    const result: object[] = [];
    const chunkSize = maxParametersPerInList(this.runtime.provider);
    for (let start = 0; start < values.length; start += chunkSize) {
      const chunk = values.slice(start, start + chunkSize);
      const { sql, params } = translator.selectAll({
        ...EMPTY_PLAN,
        conditions: [{ kind: "in", property, values: chunk }],
        noTracking,
      });
      const rows = await this.runtime.provider.query(sql, params);
      for (const row of rows) {
        let entity = materialize<object>(model, row, this.runtime.provider.dialect);
        if (!noTracking) {
          entity = this.runtime.tracker.trackLoaded(entity, model);
        }
        result.push(entity);
      }
    }
    return result;
  }

  private async queryTuples(model: EntityModel, properties: readonly string[], values: readonly (readonly unknown[])[], noTracking: boolean): Promise<object[]> {
    const result: object[] = []; const perTuple = properties.length; const chunkSize = Math.max(1, Math.floor(maxParametersPerInList(this.runtime.provider) / perTuple));
    for (let start = 0; start < values.length; start += chunkSize) { const translator = new SqlTranslator(model, this.runtime.provider.dialect); const { sql, params } = translator.selectAll({ ...EMPTY_PLAN, conditions: [{ kind: "tuples", properties, values: values.slice(start, start + chunkSize) }], noTracking }); for (let entity of (await this.runtime.provider.query(sql, params)).map((row) => materialize<object>(model, row, this.runtime.provider.dialect))) { if (!noTracking) entity = this.runtime.tracker.trackLoaded(entity, model); result.push(entity); } }
    return result;
  }
  private tuple(model: EntityModel, values: readonly unknown[]): string | undefined {
    if (values.length !== model.key.length) throw new OrmError("Relation does not match target primary key.");
    const record = Object.fromEntries(model.key.map((key, index) => [key.propertyName, values[index]]));
    return KeyTuple.fromEntity(model, record)?.toString();
  }

  private distinct(model: EntityModel, values: readonly unknown[]): unknown[] {
    const seen = new Map<string, unknown>();
    for (const value of values) {
      const key = this.tuple(model, [value]);
      if (key !== undefined) seen.set(key, value);
    }
    return [...seen.values()];
  }
}
