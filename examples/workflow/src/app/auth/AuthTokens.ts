import type { ConfigView } from "bazis/core/kernel";
import { hs256, TokenIssuer } from "bazis/library/jwt";
import type { authConfig } from "../config/auth.config";

/** The application's access tokens: `sub` is the user, `role` their roles separated by spaces. */
export class AuthTokens {
  readonly issuer: TokenIssuer;

  constructor(config: ConfigView<typeof authConfig>) {
    this.issuer = new TokenIssuer({
      issuer: "orders",
      audience: "user",
      algorithm: hs256(config.get("jwtSecret").reveal()),
      accessTtlSeconds: 3600,
      refreshTtlSeconds: 86400,
    });
  }
}
