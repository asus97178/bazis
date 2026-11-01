import { IAccess, type AccessObject, type SubjectAccess } from "../../access";
import { ForbiddenError, type HttpContext } from "../../http";
import type { WorkflowActor } from "../contracts/types";
import { WorkflowError } from "../contracts/WorkflowError";

/** Who calls a route: their rights and how they are recorded as an actor. */
export interface WorkflowCaller {
  readonly access: SubjectAccess;
  readonly actor: WorkflowActor;
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
  return { access, actor: { kind: "user", id } };
}

/** A route parameter as a string. */
export function param(ctx: HttpContext, name: string): string {
  return String(ctx.params[name] ?? "");
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

/** `limit` and `offset` of a list query. */
export function pagingQuery(ctx: HttpContext): { limit?: number; offset?: number } {
  return { limit: optionalInteger(ctx.query("limit"), "limit"), offset: optionalInteger(ctx.query("offset"), "offset") };
}
