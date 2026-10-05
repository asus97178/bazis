import { EntityNotMappedError } from "../errors";
import { ModelBuilder } from "./ModelBuilder";
import type { EntityModel } from "./types";

type EntityClass = new () => object;

/**
 * Registry of the compiled entity models of a context. Built once at startup
 * from the `entities` list (deterministically, without global side effects or
 * reflection, which keeps it binary-friendly).
 */
export class OrmModel {
  private readonly byCtor = new Map<EntityClass, EntityModel>();
  private readonly byName = new Map<string, EntityModel>();

  constructor(entities: readonly EntityClass[]) {
    for (const ctor of entities) {
      const model = ModelBuilder.build(ctor);
      this.byCtor.set(ctor, model);
      this.byName.set(model.name, model);
    }
  }

  get entities(): readonly EntityModel[] {
    return [...this.byCtor.values()];
  }

  /**
   * Registers an already built `EntityModel` at runtime (for example one built
   * by `DynamicModelBuilder` from a metadata catalog). Registration is idempotent
   * for the same model; registering again under the same name replaces the previous one.
   *
   * This is the only mutating point of the registry; it is used by controlled
   * scenarios (dynamic tables), not by arbitrary code.
   */
  registerModel(model: EntityModel): void {
    const previous = this.byName.get(model.name);
    if (previous && previous.ctor !== model.ctor) {
      this.byCtor.delete(previous.ctor);
    }
    this.byCtor.set(model.ctor, model);
    this.byName.set(model.name, model);
  }

  /** Unregisters a dynamic model by name (table archive/drop). */
  unregister(name: string): void {
    const model = this.byName.get(name);
    if (model) {
      this.byCtor.delete(model.ctor);
      this.byName.delete(name);
    }
  }

  tryByCtor(ctor: EntityClass): EntityModel | undefined {
    return this.byCtor.get(ctor);
  }

  /** Model by entity/table name (for access to dynamic sets). */
  tryByName(name: string): EntityModel | undefined {
    return this.byName.get(name);
  }

  requireByCtor(ctor: EntityClass): EntityModel {
    const model = this.byCtor.get(ctor);
    if (!model) {
      throw new EntityNotMappedError(ctor.name);
    }
    return model;
  }

  /** Model for an instance, by its constructor. */
  requireForInstance(entity: object): EntityModel {
    return this.requireByCtor(entity.constructor as EntityClass);
  }

  /** Resolves the lazy navigation target thunk into a model. */
  targetModel(target: () => EntityClass): EntityModel {
    return this.requireByCtor(target());
  }
}
