import type { DbContext } from "../DbContext";
import type { DatabaseFacade } from "../DatabaseFacade";
import type { DbSet } from "../Query/DbSet";
import type { ChangeTracker } from "../Tracking/ChangeTracker";
import type { EntityState } from "../Tracking/EntityState";

type EntityClass<T extends object> = new () => T;

/**
 * Scoped-реализация репозитория: тонкая обёртка над `DbSet<T>` и `DbContext`
 * без дублирования SQL или change tracking. Структурно совместима с
 * `IRepository<T>` из `@/core/orm` (движок не зависит от DI-слоя).
 */
export class Repository<T extends object> {
  constructor(
    private readonly context: DbContext,
    private readonly entityClass: EntityClass<T>,
  ) {}

  get dbSet(): DbSet<T> {
    return this.context.setOf(this.entityClass);
  }

  query(): DbSet<T> {
    return this.dbSet;
  }

  find(key: unknown): Promise<T | null> {
    return this.dbSet.find(key);
  }

  add(entity: T): T {
    return this.dbSet.add(entity);
  }

  addRange(entities: readonly T[]): void {
    this.dbSet.addRange(entities);
  }

  update(entity: T): T {
    return this.dbSet.update(entity);
  }

  remove(entity: T): T {
    return this.dbSet.remove(entity);
  }

  attach(entity: T): T {
    return this.dbSet.attach(entity);
  }

  stateOf(entity: T): EntityState {
    return this.context.stateOf(entity);
  }

  /** Сохраняет весь DbContext, включая изменения других его DbSet. */
  saveChanges(): Promise<number> {
    return this.context.saveChanges();
  }

  get changeTracker(): ChangeTracker {
    return this.context.changeTracker;
  }

  get database(): DatabaseFacade {
    return this.context.database;
  }
}
