import type { ListQuery, SortField } from "../../../library/jsonapi";

/** Who acts: a user or the system (schedules, events). Steps of an instance run on behalf of who started it. */
export interface WorkflowActor {
  readonly kind: "user" | "system";
  readonly id: string;
}

/** Where an action came from, for the audit: `null` in its place means code called. */
export interface WorkflowRequest {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** What the audit events of an action carry besides its actor. */
export interface WorkflowAuditOptions {
  readonly request?: WorkflowRequest | null;
}

/** What `context.metadata` holds when a process calls a Tool: enough to name the cause in its own events. */
export interface WorkflowToolMetadata {
  readonly instanceId: string;
  readonly processKey: string;
  readonly nodeId: string;
  readonly partition: string | null;
  readonly test: boolean;
}

/** A page of a list. */
export interface WorkflowPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Paging of the list operations: `limit` 1–200 (50 by default), `offset` from 0; `sort` replaces the list's own order. */
export interface WorkflowPaging {
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: readonly SortField[];
}

export function pagingOf(paging: WorkflowPaging): { readonly limit: number; readonly offset: number } {
  const limit = paging.limit === undefined ? 50 : Math.trunc(paging.limit);
  const offset = paging.offset === undefined ? 0 : Math.trunc(paging.offset);
  return { limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50, offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0 };
}

/** The page of a list operation as `paginate` takes it. */
export function pageQueryOf(paging: WorkflowPaging, order: SortField): ListQuery {
  const { limit, offset } = pagingOf(paging);
  return {
    sort: paging.sort ?? [order],
    filters: [],
    or: [],
    include: [],
    fields: {},
    page: { limit, offset, size: limit, number: Math.floor(offset / limit) + 1 },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id can be a row key; anything else would reach PostgreSQL as an invalid uuid. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
