import { createOpenGenericTokenFamily, type Class, type InjectionToken } from "../di";
import type { ChangeTracker, DatabaseFacade, DbSet, EntityState } from "../../library/orm";

/**
 * Контракт репозитория одной сущности: CRUD-трекинг, Unit of Work и доступ
 * к LINQ-подобным запросам через {@link IRepository.query} / {@link IRepository.dbSet}.
 *
 * Живёт в слое интеграции, потому что DI-токен и контракт публикуются вместе
 * (как `IRepository<T>` тип + `IRepository.of(T)` токен). Чистый движок
 * (`@/library/orm`) от этого контракта не зависит — `Repository<T>`
 * совместим с ним структурно.
 */
export interface IRepository<T extends object> {
  /** Набор сущности — полный API запросов и трекинга ORM. */
  readonly dbSet: DbSet<T>;

  /** Алиас {@link dbSet} для читаемости в сервисном слое. */
  query(): DbSet<T>;

  find(key: unknown): Promise<T | null>;
  add(entity: T): T;
  addRange(entities: readonly T[]): void;
  update(entity: T): T;
  remove(entity: T): T;
  attach(entity: T): T;
  stateOf(entity: T): EntityState;

  /**
   * Сохраняет ВСЕ изменения общего DbContext, включая другие его сущности.
   * Для явной границы операции с несколькими сущностями внедряйте свой
   * DbContext и вызывайте context.saveChanges(). Семантика этого alias сохранена.
   */
  saveChanges(): Promise<number>;

  readonly changeTracker: ChangeTracker;
  readonly database: DatabaseFacade;
}

/** Open generic DI-токен: `repositoryFor(User)` или `IRepository.of(User)`. */
export const IRepository = createOpenGenericTokenFamily<object, IRepository<object>>("IRepository");

/** Типизированный DI-токен репозитория для класса сущности. */
export function repositoryFor<T extends object>(entity: Class<T>): InjectionToken<IRepository<T>> {
  return IRepository.of(entity) as InjectionToken<IRepository<T>>;
}
