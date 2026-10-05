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
 * Базовый класс контекста БД (scoped-сервис DI). Наследник объявляет наборы:
 *
 * ```ts
 * class AppDbContext extends DbContext {
 *   readonly users = this.set(User);
 *   readonly posts = this.set(Post);
 * }
 * ```
 *
 * Хранит ChangeTracker, фасад `database` и предоставляет SaveChanges в транзакции.
 */
export abstract class DbContext {
  /** Трекер изменений этого контекста. */
  readonly changeTracker: ChangeTracker;
  /** Управление базой данных (схема, сырой SQL, транзакции). */
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

  /** Создаёт набор для сущности. Вызывается в инициализаторах полей наследника. */
  protected set<T extends object>(entity: EntityClass<T>): DbSet<T> {
    return this.setOf(entity);
  }

  /** Публичный доступ к `DbSet` по классу сущности (для `Repository<T>` и generic-сценариев). */
  setOf<T extends object>(entity: EntityClass<T>): DbSet<T> {
    return new DbSet<T>(this.#options.model.requireByCtor(entity), this.#runtime);
  }

  /**
   * `DbSet` для сущности, зарегистрированной в реестре по имени (без статического
   * класса в коде) — основа динамических таблиц DataManager. Модель должна быть
   * предварительно зарегистрирована (`OrmModel.registerModel`), иначе
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
   * Применяет все накопленные изменения в одной транзакции и возвращает число
   * обработанных сущностей. Перед сохранением выполняется DetectChanges и
   * (если включено) валидация Added/Modified сущностей.
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
