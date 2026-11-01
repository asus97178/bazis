import { IAccess, type AccessObject, type SubjectAccess } from "../../access";
import { ForbiddenError, type HttpContext } from "../../http";
import { frameworkBadRequest } from "../../http/Errors/HttpError";
import { ListQueryError, parseListQuery, type ListQuery, type ListQueryOptions, type ListQueryProblem } from "../../../library/jsonapi";
import { textOf, type LocalizedText } from "../../../library/workflow";
import type { WorkflowActor, WorkflowPaging, WorkflowRequest } from "../contracts/types";
import { WorkflowError } from "../contracts/WorkflowError";
import { WorkflowLanguages } from "./WorkflowLanguages";

/** Who calls a route: their rights and how they are recorded as an actor. */
export interface WorkflowCaller {
  readonly access: SubjectAccess;
  readonly actor: WorkflowActor;
  readonly request: WorkflowRequest;
  /** The language of the request: `Accept-Language` among `workflow.languages`. */
  readonly language: string;
}

/** A record with `titleText`: its `title` in the language of the request. `title` itself stays for editing. */
export function withTitleText<T extends { readonly title: LocalizedText }>(item: T, language: string, fallback: string): T & { readonly titleText: string } {
  return { ...item, titleText: textOf(item.title, language, fallback) };
}

/** The default language, for {@link withTitleText}. */
export function defaultLanguage(ctx: HttpContext): string {
  return ctx.services.resolve(WorkflowLanguages).default;
}

/**
 * The caller of a route; 401 without a subject. With `permission` and `object`
 * also checks the object the route's `can` could not know: 403 without the
 * right. The actor's id is the first owner id, so that `{ own: true }` means
 * the instances the subject started.
 */
export async function callerOf(ctx: HttpContext, permission?: string, object?: AccessObject): Promise<WorkflowCaller> {
  const access = await ctx.services.resolve(IAccess).for(ctx);
  if (permission !== undefined && !await access.can(permission, object)) throw new ForbiddenError();
  const sub = access.subject.sub;
  const [id = sub.slice(sub.lastIndexOf(":") + 1)] = await access.ownerIds();
  return { access, actor: { kind: "user", id }, request: { ip: ctx.clientIp ?? null, userAgent: ctx.header("user-agent") ?? null }, language: ctx.services.resolve(WorkflowLanguages).of(ctx.header("accept-language")) };
}

/** A route parameter as a string. */
export function param(ctx: HttpContext, name: string): string {
  return String(ctx.params[name] ?? "");
}

/** A title or a description from a body; the service checks it. */
export function optionalText(value: unknown): LocalizedText | null | undefined {
  return value as LocalizedText | null | undefined;
}

/** The JSON body as an object; anything else is `invalid_input`. */
export async function body(ctx: HttpContext): Promise<Record<string, unknown>> {
  const text = await ctx.text();
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkflowError("invalid_input", "The body must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkflowError("invalid_input", "The body must be a JSON object");
  return value as Record<string, unknown>;
}

/** An optional string field of a body or a query; another type is `invalid_input`. */
export function optionalString(value: unknown, name: string, max = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new WorkflowError("invalid_input", `${name} must be a string up to ${max} characters`);
  return value;
}

/** A required string field. */
export function requiredString(value: unknown, name: string, max = 200): string {
  const text = optionalString(value, name, max);
  if (text === undefined || text.trim() === "") throw new WorkflowError("invalid_input", `${name} is required`);
  return text;
}

/** An optional integer from a query string or a body. */
export function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number)) throw new WorkflowError("invalid_input", `${name} must be an integer`);
  return number as number;
}

/**
 * The list query of a route: `filter[...]`, `sort`, `page[...]`; anything
 * `options` does not list is 400. Each filter here names one service option, so
 * OR groups and a field filtered twice are refused rather than half applied.
 */
export function listQuery(ctx: HttpContext, options: Pick<ListQueryOptions, "filter" | "sort">): ListQuery {
  try {
    const list = parseListQuery(ctx.url.searchParams, { ...options, page: { defaultSize: 50, maxSize: 200 } });
    const problems: ListQueryProblem[] = list.or.length > 0 ? [{ parameter: "filter[or]", message: "OR groups are not supported here" }] : [];
    for (const [index, { field }] of list.filters.entries()) {
      if (list.filters.findIndex((rule) => rule.field === field) !== index) problems.push({ parameter: `filter[${field}]`, message: "the field is filtered twice" });
    }
    if (problems.length > 0) throw new ListQueryError(problems);
    return list;
  } catch (error) {
    if (error instanceof ListQueryError) throw frameworkBadRequest("invalidListQuery", undefined, error.problems);
    throw error;
  }
}

/** The page and order of a list query, for a list operation. */
export function pagingOfList(list: ListQuery): WorkflowPaging {
  return { limit: list.page.limit, offset: list.page.offset, ...(list.sort.length === 0 ? {} : { sort: list.sort }) };
}

/** The value of `filter[field]`. */
export function filterOf(list: ListQuery, field: string): string | undefined {
  const value = list.filters.find((rule) => rule.field === field)?.value;
  return Array.isArray(value) ? value.join(",") : value as string | undefined;
}
