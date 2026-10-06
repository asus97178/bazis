import { EntityNotFoundError } from "../errors";
import type { EntityModel } from "../Metadata/types";
import type { DbContextRuntime } from "../runtime";
import { fieldSelector, type KeySelectorFn, type PredicateFn } from "./conditions";
import { IncludeLoader } from "./IncludeLoader";
import { materialize, materializeProjection } from "./materialize";
import { EMPTY_PLAN, withCondition, withOrder, type QueryPlan } from "./QueryPlan";
import { SqlTranslator } from "./SqlTranslator";
import { executeImmediateDelete, executeImmediateUpdate, type OrmMutationResultV1, type OrmUpdateValuesV1 } from "./ImmediateMutations";

export interface ForUpdateOptionsV1 { readonly skipLocked?: boolean; }

/** Navigation element type: `Post[]` -> `Post`, `User | undefined` -> `User`. */
export type NavigationElement<N> = N extends readonly (infer E)[] ? E : NonNullable<N>;
function captureNavigation<T>(selector: (entity: T) => unknown): string {
  let captured = "";
  const proxy = new Proxy(
    {},
    {
      get(_target, property): undefined {
        captured = String(property);
        return undefined;
      },
    },
  );
  selector(proxy as T);
  if (captured === "") {
    throw new Error("include/thenInclude selector must access a navigation property, e.g. x => x.posts");
  }
  return captured;
}

/** Captures the `.select(u => ({ alias: u.prop }))` projection. */
function captureProjection<T, R extends Record<string, unknown>>(
  selector: (entity: T) => R,
): { readonly alias: string; readonly property: string }[] {
  const proxy = new Proxy(
    {},
    {
      get(_target, property): string {
        return String(property);
      },
    },
  );
  const mapped = selector(proxy as T);
  return Object.entries(mapped).map(([alias, propertyName]) => ({ alias, property: String(propertyName) }));
}

/**
 * Immutable LINQ-like query over one entity. Each step
 * (where/orderBy/take/skip/asNoTracking) returns a new `EntityQuery` with an
 * extended plan; terminal methods (toList/first/count/...) run the SQL.
 */
export class EntityQuery<T extends object, TResult = T> {
  constructor(
    protected readonly model: EntityModel,
    protected readonly runtime: DbContextRuntime,
    protected readonly plan: QueryPlan = EMPTY_PLAN,
  ) {}

  protected derive(plan: QueryPlan): EntityQuery<T, TResult> {
    return new EntityQuery<T, TResult>(this.model, this.runtime, plan);
  }

  /** Filter. Several calls are combined with AND. */
  where(predicate: PredicateFn<T>): EntityQuery<T, TResult> {
    const result = predicate(fieldSelector<T>());
    return this.derive(withCondition(this.plan, result.node));
  }

  orderBy(selector: KeySelectorFn<T>): EntityQuery<T, TResult> {
    return this.derive(withOrder(this.plan, { property: selector(fieldSelector<T>()).property, descending: false }));
  }

  orderByDescending(selector: KeySelectorFn<T>): EntityQuery<T, TResult> {
    return this.derive(withOrder(this.plan, { property: selector(fieldSelector<T>()).property, descending: true }));
  }

  take(count: number): EntityQuery<T, TResult> {
    const invalidRequestedLimit = !Number.isSafeInteger(count) || count <= 0 ? count : this.plan.invalidRequestedLimit;
    return this.derive({ ...this.plan, limit: Math.max(0, Math.trunc(count)), requestedLimit: count, ...(invalidRequestedLimit === undefined ? {} : { invalidRequestedLimit }) });
  }

  skip(count: number): EntityQuery<T, TResult> {
    return this.derive({ ...this.plan, offset: Math.max(0, Math.trunc(count)) });
  }

  /** Read-only: the result is not tracked by the ChangeTracker (faster). */
  asNoTracking(): EntityQuery<T, TResult> {
    return this.derive({ ...this.plan, noTracking: true });
  }

  /** Do not apply global `@QueryFilter`s and the soft-delete filter. */
  ignoreQueryFilters(): EntityQuery<T, TResult> {
    return this.derive({ ...this.plan, ignoreQueryFilters: true });
  }

  /**
   * Locks selected rows for mutation until the surrounding transaction ends.
   * PostgreSQL emits `FOR UPDATE`. Call this only inside a caller-owned
   * transaction.
   */
  forUpdate(options?: ForUpdateOptionsV1): EntityQuery<T, TResult> {
    return this.derive({ ...this.plan, rowLock: "update", skipLocked: options?.skipLocked === true });
  }

  /**
   * Projects columns into a plain object (without materializing the full entity).
   *
   * ```ts
   * await ctx.users.select(u => ({ name: u.name, age: u.age })).toList();
   * ```
   */
  select<R extends Record<string, unknown>>(selector: (entity: T) => R): ProjectedQuery<T, R> {
    const projections = captureProjection(selector);
    return new ProjectedQuery<T, R>(this.model, this.runtime, { ...this.plan, projections, noTracking: true });
  }

  /**
   * Eager loading of a navigation (split query). Chain `.thenInclude(...)`
   * to load nested navigations.
   *
   * ```ts
   * ctx.users.include((u) => u.posts).thenInclude((p) => p.comments).toList();
   * ```
   */
  include<N>(selector: (entity: T) => N): IncludableQuery<T, NavigationElement<N>> {
    const navigation = captureNavigation(selector);
    const plan: QueryPlan = { ...this.plan, includes: [...this.plan.includes, [navigation]] };
    return new IncludableQuery<T, NavigationElement<N>>(this.model, this.runtime, plan);
  }

  protected translator(): SqlTranslator {
    return new SqlTranslator(this.model, this.runtime.provider.dialect);
  }

  async toList(): Promise<TResult[]> {
    assertSkipLocked(this.model, this.runtime, this.plan, "toList");
    const { sql, params } = this.translator().selectAll(this.plan);
    const rows = await this.runtime.provider.query(sql, params);
    const result: T[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      let entity = materialize<T>(this.model, rows[i]!, this.runtime.provider.dialect);
      if (!this.plan.noTracking) {
        // trackLoaded returns the canonical instance (identity resolution).
        entity = this.plan.rowLock
          ? this.runtime.tracker.trackReloaded(entity, this.model) as T
          : this.runtime.tracker.trackLoaded(entity, this.model) as T;
      }
      result[i] = entity;
    }
    if (this.plan.includes.length > 0) {
      await new IncludeLoader(this.runtime).load(this.model, result as object[], this.plan.includes, this.plan.noTracking);
    }
    return result as unknown as TResult[];
  }

  /** The first element or null. */
  async firstOrDefault(predicate?: PredicateFn<T>): Promise<TResult | null> {
    const query = predicate ? this.where(predicate) : this;
    const rows = await query.take(1).toList();
    return rows.length > 0 ? rows[0]! : null;
  }

  /** The first element, or an error if nothing is found. */
  async first(predicate?: PredicateFn<T>): Promise<TResult> {
    const result = await this.firstOrDefault(predicate);
    if (result === null) {
      throw new EntityNotFoundError(this.model.name);
    }
    return result;
  }

  async count(predicate?: PredicateFn<T>): Promise<number> {
    const query = predicate ? this.where(predicate) : this;
    assertSkipLocked(query.model, query.runtime, query.plan, "count");
    const { sql, params } = query.translator().selectCount(query.plan);
    const rows = await this.runtime.provider.query(sql, params);
    return Number((rows[0] as { count?: unknown })?.count ?? 0);
  }

  async any(predicate?: PredicateFn<T>): Promise<boolean> {
    return (await this.count(predicate)) > 0;
  }

  executeUpdate(values: OrmUpdateValuesV1<T>): Promise<OrmMutationResultV1> {
    return executeImmediateUpdate(this.model, this.runtime, this.plan, values);
  }

  executeDelete(): Promise<OrmMutationResultV1> {
    return executeImmediateDelete(this.model, this.runtime, this.plan);
  }

}

function assertSkipLocked(model: EntityModel, runtime: DbContextRuntime, plan: QueryPlan, terminal: "toList" | "count"): void {
  if (!plan.skipLocked) return;
  if (terminal !== "toList" || runtime.provider.isTransactionActive?.() !== true || plan.conditions.length === 0 || plan.invalidRequestedLimit !== undefined || !Number.isSafeInteger(plan.limit) || plan.limit! <= 0 || plan.requestedLimit !== undefined && plan.requestedLimit !== plan.limit || plan.offset !== undefined || plan.projections.length !== 0 || plan.includes.length !== 0) throw new Error("FOR UPDATE SKIP LOCKED requires an active transaction, where, positive take, and terminal materialization.");
  const ordered = new Set(plan.orders.map((order) => order.property));
  if (!model.key.every((key) => ordered.has(key.propertyName))) throw new Error("FOR UPDATE SKIP LOCKED requires an explicit complete primary-key order.");
}

/**
 * Query with an active Include chain: `thenInclude` loads a navigation of the
 * last included entity (`TLast`).
 */
export class IncludableQuery<T extends object, TLast> extends EntityQuery<T> {
  thenInclude<N>(selector: (entity: TLast) => N): IncludableQuery<T, NavigationElement<N>> {
    const navigation = captureNavigation(selector);
    const includes = this.plan.includes.map((path) => [...path]);
    const last = includes[includes.length - 1];
    if (!last) {
      throw new Error("thenInclude must follow an include().");
    }
    last.push(navigation);
    return new IncludableQuery<T, NavigationElement<N>>(this.model, this.runtime, { ...this.plan, includes });
  }
}

/** Query with a `.select(...)` projection: `toList()` returns plain objects. */
export class ProjectedQuery<T extends object, R> extends EntityQuery<T, R> {
  protected override derive(plan: QueryPlan): ProjectedQuery<T, R> {
    return new ProjectedQuery<T, R>(this.model, this.runtime, plan);
  }

  override async toList(): Promise<R[]> {
    assertSkipLocked(this.model, this.runtime, this.plan, "toList");
    const { sql, params } = this.translator().selectAll(this.plan);
    const rows = await this.runtime.provider.query(sql, params);
    const dialect = this.runtime.provider.dialect;
    return rows.map((row) => materializeProjection(this.model, row, dialect, this.plan.projections) as R);
  }

  override async firstOrDefault(predicate?: PredicateFn<T>): Promise<R | null> {
    const query = predicate ? this.where(predicate) : this;
    const rows = await query.take(1).toList();
    return rows.length > 0 ? rows[0]! : null;
  }

  override async first(predicate?: PredicateFn<T>): Promise<R> {
    const result = await this.firstOrDefault(predicate);
    if (result === null) {
      throw new EntityNotFoundError(this.model.name);
    }
    return result;
  }
}
