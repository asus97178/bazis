import { DatabaseFacade } from "./DatabaseFacade";
import type { DbContextOptions } from "./DbContextOptions";
import { EntityNotMappedError } from "./errors";
import { DbSet } from "./Query/DbSet";
import type { DbContextRuntime } from "./runtime";
import { SaveExecutor } from "./Saving/SaveExecutor";
import { ChangeTracker } from "./Tracking/ChangeTracker";
import { EntityState } from "./Tracking/EntityState";
import { monitorImmediateOperation, monitorWholeOperation, observedProvider, transactionScope } from "./Transactions/TransactionScopeCoordinator";
import { OrmTransaction, type OrmTransactionScopeOptions } from "./Transactions/OrmTransaction";

type EntityClass<T extends object> = new () => T;

/**
 * Base class of a database context (a scoped DI service). A subclass declares the sets:
 *
 * ```ts
 * class AppDbContext extends DbContext {
 *   readonly users = this.set(User);
 *   readonly posts = this.set(Post);
 * }
 * ```
 *
 * Holds the ChangeTracker and the `database` facade and provides SaveChanges in a transaction.
 */
export abstract class DbContext {
  /** Change tracker of this context. */
  readonly changeTracker: ChangeTracker;
  /** Database management (schema, raw SQL, transactions). */
  readonly database: DatabaseFacade;

  readonly #options: DbContextOptions;
  readonly #runtime: DbContextRuntime;

  constructor(options: DbContextOptions) {
    this.#options = options;
    this.changeTracker = new ChangeTracker();
    const provider = observedProvider(this, options.provider);
    this.#runtime = { provider, models: options.model, tracker: this.changeTracker, runImmediateOperation: (operation) => monitorImmediateOperation(this, operation) };
    this.database = new DatabaseFacade(provider, options.model);
  }

  /** Creates a set for an entity. Called in the subclass's field initializers. */
  protected set<T extends object>(entity: EntityClass<T>): DbSet<T> {
    return this.setOf(entity);
  }

  /** Public access to a `DbSet` by entity class (for `Repository<T>` and generic scenarios). */
  setOf<T extends object>(entity: EntityClass<T>): DbSet<T> {
    return new DbSet<T>(this.#options.model.requireByCtor(entity), this.#runtime);
  }

  /**
   * `DbSet` for an entity registered in the model by name (with no static class
   * in the code), the basis for dynamic tables built at runtime. The model must
   * be registered beforehand (`OrmModel.registerModel`), otherwise
   * `EntityNotMappedError`.
   */
  setByName(name: string): DbSet<Record<string, unknown>> {
    const model = this.#options.model.tryByName(name);
    if (!model) {
      throw new EntityNotMappedError(name);
    }
    return new DbSet<Record<string, unknown>>(model, this.#runtime);
  }

  add<T extends object>(entity: T): T {
    this.changeTracker.add(entity, this.#options.model.requireForInstance(entity));
    return entity;
  }

  update<T extends object>(entity: T): T {
    this.changeTracker.update(entity, this.#options.model.requireForInstance(entity));
    return entity;
  }

  remove<T extends object>(entity: T): T {
    this.changeTracker.remove(entity, this.#options.model.requireForInstance(entity));
    return entity;
  }

  attach<T extends object>(entity: T): T {
    this.changeTracker.attach(entity, this.#options.model.requireForInstance(entity));
    return entity;
  }

  stateOf(entity: object): EntityState {
    return this.changeTracker.stateOf(entity);
  }

  /**
   * Applies all pending changes in one transaction and returns the number of
   * processed entities. DetectChanges runs before saving, and (if enabled)
   * Added/Modified entities are validated.
   */
  saveChanges(): Promise<number> {
    return monitorWholeOperation(this, () => new SaveExecutor(this.#runtime.provider, this.changeTracker, {
      validateOnSave: this.#options.validateOnSave,
      executionStrategy: this.#options.executionStrategy,
    }).save());
  }

  /** Executes a composable ORM transaction scope for this provider identity. */
  transactionScope<TResult>(work: (transaction: OrmTransaction) => Promise<TResult>, options?: OrmTransactionScopeOptions): Promise<TResult> {
    return transactionScope(this, this.#options.provider, work, options);
  }
}
