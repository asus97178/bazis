import { defineConfig, secret } from "bazis/core/kernel";

/** The signing key of the access tokens: `BAZIS_AUTH__JWTSECRET`, required in production. */
export const authConfig = defineConfig("auth", {
  default: { jwtSecret: secret("dev-only-secret-at-least-32-bytes!!") },
  production: { jwtSecret: secret() },
});
