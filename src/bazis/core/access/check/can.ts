import type { AuthorizeCheck, AuthorizeContext } from "../../http";
import type { AccessObject } from "../contracts/types";
import { Access } from "./Access";

/**
 * A route check by a permission (ACCESS-001 §5): 401 without a subject, 403
 * without the right. `objectOf` gives the object from the request; without it
 * the route needs the permission anywhere, and the handler checks the object
 * once it has loaded it.
 *
 * ```ts
 * @Authorize(can("orders.create", (ctx) => ({ scope: ctx.header("x-shop") ?? null })))
 * @Post() create(ctx: HttpContext) { … }
 * ```
 */
export function can(permission: string, objectOf?: (ctx: AuthorizeContext) => AccessObject | Promise<AccessObject>): AuthorizeCheck {
  return async (ctx) => {
    const access = await ctx.services.resolve(Access).for(ctx);
    return await access.can(permission, objectOf === undefined ? undefined : await objectOf(ctx));
  };
}
