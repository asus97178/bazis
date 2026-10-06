import type { Condition } from "./conditions";
import type { RowLockMode } from "../Providers/types";

export interface OrderClause {
  readonly property: string;
  readonly descending: boolean;
}

/**
 * Declarative query plan, built by the where/orderBy/take/skip chain and
 * translated into SQL. Immutable: each step returns a new plan, so a base query
 * can be reused and its translation cached.
 */
export interface QueryPlan {
  readonly conditions: readonly Condition[];
  readonly orders: readonly OrderClause[];
  readonly limit?: number;
  /** Original public take value, retained privately for SKIP LOCKED admission. */
  readonly requestedLimit?: number;
  /** Invalid explicit take survives implicit first/firstOrDefault take(1). */
  readonly invalidRequestedLimit?: number;
  readonly offset?: number;
  /** AsNoTracking: do not register the result in the ChangeTracker. */
  readonly noTracking: boolean;
  /**
   * Eager loading paths of navigations (Include/ThenInclude). Each path is a
   * sequence of navigation names from the root, for example `["posts", "comments"]`.
   */
  readonly includes: readonly (readonly string[])[];
  /** Do not apply global `@QueryFilter`s and the soft-delete filter. */
  readonly ignoreQueryFilters: boolean;
  /** Column projection: alias -> propertyName (from `.select(...)`). */
  readonly projections: readonly { readonly alias: string; readonly property: string }[];
  /** Row lock held by the caller-owned transaction until commit/rollback. */
  readonly rowLock?: RowLockMode;
  /** Private renderer policy for the bounded SKIP LOCKED admission. */
  readonly skipLocked?: boolean;
}

export const EMPTY_PLAN: QueryPlan = {
  conditions: [],
  orders: [],
  noTracking: false,
  includes: [],
  ignoreQueryFilters: false,
  projections: [],
};

export function withCondition(plan: QueryPlan, condition: Condition): QueryPlan {
  return { ...plan, conditions: [...plan.conditions, condition] };
}

export function withOrder(plan: QueryPlan, order: OrderClause): QueryPlan {
  return { ...plan, orders: [...plan.orders, order] };
}
