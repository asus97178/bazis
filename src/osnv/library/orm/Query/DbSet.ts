import type { EntityModel } from "../Metadata/types";
import type { DbContextRuntime } from "../runtime";
import { EntityQuery } from "./EntityQuery";
import { Operand } from "./conditions";
import { KeyTuple } from "../Metadata/KeyTuple";
import { insertIfAbsent, type OrmInsertIfAbsentResultV1, type OrmUniqueKeySelectorV1 } from "./ImmediateMutations";

/**
 * Точка доступа к таблице: запросы (наследуются от `EntityQuery`) плюс операции
 * трекера (add/update/remove/attach) и поиск по ключу `find`.
 */
export class DbSet<T extends object> extends EntityQuery<T> {
  constructor(model: EntityModel, runtime: DbContextRuntime) {
    super(model, runtime);
  }

  /** Помечает сущность на вставку. */
  add(entity: T): T {
    this.runtime.tracker.add(entity, this.model);
    return entity;
  }

  addRange(entities: readonly T[]): void {
    for (const entity of entities) {
      this.runtime.tracker.add(entity, this.model);
    }
  }

  /** Помечает сущность как изменённую (полное обновление). */
  update(entity: T): T {
    this.runtime.tracker.update(entity, this.model);
    return entity;
  }

  /** Помечает сущность на удаление. */
  remove(entity: T): T {
    this.runtime.tracker.remove(entity, this.model);
    return entity;
  }

  /** Прикрепляет существующую сущность как Unchanged (со снимком). */
  attach(entity: T): T {
    this.runtime.tracker.attach(entity, this.model);
    return entity;
  }

  /**
   * Поиск по первичному ключу с обычными query filters/soft-delete.
   * Identity map по-прежнему возвращает канонический tracked instance,
   * но запрос всегда идёт в БД, чтобы cached entity не обошла filters.
   */
  find(key: unknown): Promise<T | null> {
    return this.byKey(key).firstOrDefault();
  }

  /**
   * Reads the current row and locks it for mutation in the surrounding
   * transaction. PostgreSQL emits `FOR UPDATE`; query filters remain active.
   */
  findForUpdate(key: unknown): Promise<T | null> {
    return this.byKey(key).forUpdate().firstOrDefault();
  }

  insertIfAbsent(entity: T, options: { readonly conflictBy: OrmUniqueKeySelectorV1<T> }): Promise<OrmInsertIfAbsentResultV1> {
    return insertIfAbsent(this.model, this.runtime, entity, options);
  }

  private byKey(key: unknown): EntityQuery<T> {
    const tuple = KeyTuple.fromInput(this.model, key);
    let query: EntityQuery<T> = this;
    for (let index = 0; index < this.model.key.length; index += 1) {
      const property = this.model.key[index]!;
      const value = tuple.values[index];
      query = query.where((entity) => (entity as unknown as Record<string, Operand>)[property.propertyName]!.eq(value));
    }
    return query;
  }
}
