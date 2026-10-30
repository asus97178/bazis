/** Who acts: a user or the system (schedules, events). Steps of an instance run on behalf of who started it. */
export interface WorkflowActor {
  readonly kind: "user" | "system";
  readonly id: string;
}

/** A page of a list. */
export interface WorkflowPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Paging of the list operations: `limit` 1–200 (50 by default), `offset` from 0. */
export interface WorkflowPaging {
  readonly limit?: number;
  readonly offset?: number;
}

export function pagingOf(paging: WorkflowPaging): { readonly limit: number; readonly offset: number } {
  const limit = paging.limit === undefined ? 50 : Math.trunc(paging.limit);
  const offset = paging.offset === undefined ? 0 : Math.trunc(paging.offset);
  return { limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50, offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0 };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id can be a row key; anything else would reach PostgreSQL as an invalid uuid. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
