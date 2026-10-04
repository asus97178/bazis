import type { HttpContext } from "../HttpContext/HttpContext";

/**
 * Middleware signature (Koa/ASP.NET Core style): do work, call `next()` to
 * pass control down the pipeline, optionally short-circuit by setting
 * `ctx.response` without calling `next`.
 */
export type HttpMiddleware = (ctx: HttpContext, next: () => Promise<void>) => void | Promise<void>;

/**
 * Action filter (`@ActionFilter`): `before` is an action-boundary policy and
 * therefore also runs before a short-circuiting output cache hit. `after`
 * wraps an actual action invocation and may replace its result by returning a
 * non-undefined value.
 */
export interface ActionFilterHooks {
  before?(ctx: HttpContext): void | Promise<void>;
  after?(ctx: HttpContext, result: unknown): unknown | Promise<unknown>;
}
