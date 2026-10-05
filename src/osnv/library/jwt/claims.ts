/** Registered claim names defined by RFC 7519. */
export const RegisteredClaims = {
  Subject: "sub",
  Issuer: "iss",
  Audience: "aud",
  ExpiresAt: "exp",
  NotBefore: "nbf",
  IssuedAt: "iat",
  JwtId: "jti",
} as const;

/** Custom claim distinguishing access tokens from refresh tokens. */
export const TOKEN_USE_CLAIM = "token_use";

/** Whether a token authorizes API calls (`access`) or rotation only (`refresh`). */
export type TokenUse = "access" | "refresh";

/** A JSON-serialisable claim value. */
export type ClaimValue = string | number | boolean | readonly string[] | null;

/** A decoded JWT payload — claim name to value. */
export interface JwtPayload {
  readonly [claim: string]: ClaimValue | undefined;
}

/** Custom claims supplied by the caller when issuing a token. */
export interface CustomClaims {
  readonly [claim: string]: ClaimValue;
}

/** Compact JWS header. */
export interface JwtHeader {
  readonly alg: string;
  readonly typ: "JWT";
  readonly kid?: string;
}
