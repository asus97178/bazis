import { bearerToken, PRINCIPAL_STATE_KEY, type AuthorizeCheck } from "bazis/core/http";
import { AuthTokens } from "./AuthTokens";

/**
 * The route check of the application: who makes the request. What they may do
 * is the business of the permissions (`can`), so it only puts the principal
 * where the rights system reads it. Without a valid token — 401.
 */
export const signedIn: AuthorizeCheck = async (ctx) => {
  const { payload } = await ctx.services.resolve(AuthTokens).issuer.verifyAccess(bearerToken(ctx) ?? "");
  ctx.state.set(PRINCIPAL_STATE_KEY, {
    subject: String(payload.sub),
    findFirst: (claim: string) => {
      const value = payload[claim];
      return typeof value === "string" ? value : undefined;
    },
  });
  return true;
};
