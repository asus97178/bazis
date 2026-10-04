import type { Condition } from "./conditions";
import type { RowLockMode } from "../Providers/types";

export interface OrderClause {
  readonly property: string;
  readonly descending: boolean;
}

/**
 * Декларативный план запроса — собирается цепочкой where/orderBy/take/skip и
 * транслируется в SQL. Иммутабелен: каждый шаг возвращает новый план, что
 * позволяет переиспользовать базовый запрос и кэшировать трансляцию.
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
  /** AsNoTracking: не регистрировать результат в ChangeTracker. */
  readonly noTracking: boolean;
  /**
   * Пути жадной загрузки навигаций (Include/ThenInclude). Каждый путь —
   * последовательность имён навигаций от корня, например `["posts", "comments"]`.
   */
  readonly includes: readonly (readonly string[])[];
  /** Не применять глобальные `@QueryFilter` и soft-delete фильтр. */
  readonly ignoreQueryFilters: boolean;
  /** Проекция колонок: alias -> propertyName (из `.select(...)`). */
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
