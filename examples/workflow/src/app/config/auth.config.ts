import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface AuthConfig {
  jwtSecret: Secret;
}

/** The signing key of the access tokens: `BAZIS_AUTH__JWTSECRET`, required in production. */
export const authConfig = defineConfig<AuthConfig>("auth", {
  default: { jwtSecret: secret("dev-only-secret-at-least-32-bytes!!") },
  production: { jwtSecret: secret() },
});
