import type { AuthorizeContext } from "./metadata";

/**
 * The token of an `Authorization: Bearer <token>` header, or `undefined`
 * without the header, with another scheme or with an empty token. The scheme
 * is case-insensitive (RFC 7235); surrounding spaces are trimmed.
 */
export function bearerToken(ctx: Pick<AuthorizeContext, "header">): string | undefined {
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(ctx.header("authorization") ?? "");
  return match?.[1];
}
