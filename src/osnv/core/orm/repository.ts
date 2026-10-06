import { createOpenGenericTokenFamily, type Class, type InjectionToken } from "../di";
import type { ChangeTracker, DatabaseFacade, DbSet, EntityState } from "../../library/orm";

/**
 * Repository contract for one entity: change tracking, Unit of Work and access
 * to LINQ-like queries through {@link IRepository.query} / {@link IRepository.dbSet}.
 *
 * Lives in the integration layer because the DI token and the contract are
 * published together (the `IRepository<T>` type plus the `IRepository.of(T)`
 * token). The pure engine (`@/library/orm`) does not depend on this contract:
 * `Repository<T>` is structurally compatible with it.
 */
export interface IRepository<T extends object> {
  /** The entity set: the full ORM query and tracking API. */
  readonly dbSet: DbSet<T>;

  /** Alias of {@link dbSet} for readability in the service layer. */
  query(): DbSet<T>;

  find(key: unknown): Promise<T | null>;
  add(entity: T): T;
  addRange(entities: readonly T[]): void;
  update(entity: T): T;
  remove(entity: T): T;
  attach(entity: T): T;
  stateOf(entity: T): EntityState;

  /**
   * Saves ALL changes of the shared DbContext, including its other entities.
   * For an explicit boundary of an operation over several entities, inject
   * your DbContext and call context.saveChanges().
   */
  saveChanges(): Promise<number>;

  readonly changeTracker: ChangeTracker;
  readonly database: DatabaseFacade;
}

/** Open generic DI token: `repositoryFor(User)` or `IRepository.of(User)`. */
export const IRepository = createOpenGenericTokenFamily<object, IRepository<object>>("IRepository");

/** Typed repository DI token for an entity class. */
export function repositoryFor<T extends object>(entity: Class<T>): InjectionToken<IRepository<T>> {
  return IRepository.of(entity) as InjectionToken<IRepository<T>>;
}
