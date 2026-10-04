import { EntityNotMappedError } from "../errors";
import { ModelBuilder } from "./ModelBuilder";
import type { EntityModel } from "./types";

type EntityClass = new () => object;

/**
 * Реестр скомпилированных моделей сущностей контекста. Строится один раз на
 * старте из списка `entities` (детерминированно, без глобальных side-effect'ов
 * и рефлексии — дружелюбно к бинарнику).
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
   * Регистрирует уже построенную `EntityModel` в рантайме (например, собранную
   * из каталога метаданных `DynamicModelBuilder`). Регистрация идемпотентна для
   * той же модели; повторная регистрация под тем же именем заменяет предыдущую.
   *
   * Это единственная мутирующая точка реестра — её используют контролируемые
   * сценарии (динамические таблицы), а не произвольный код.
   */
  registerModel(model: EntityModel): void {
    const previous = this.byName.get(model.name);
    if (previous && previous.ctor !== model.ctor) {
      this.byCtor.delete(previous.ctor);
    }
    this.byCtor.set(model.ctor, model);
    this.byName.set(model.name, model);
  }

  /** Снимает динамическую модель с регистрации по имени (archive/drop таблицы). */
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

  /** Модель по имени сущности/таблицы (для доступа к динамическим наборам). */
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

  /** Модель для экземпляра по его конструктору. */
  requireForInstance(entity: object): EntityModel {
    return this.requireByCtor(entity.constructor as EntityClass);
  }

  /** Разрешает ленивый thunk цели навигации в модель. */
  targetModel(target: () => EntityClass): EntityModel {
    return this.requireByCtor(target());
  }
}
