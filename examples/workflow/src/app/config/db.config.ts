import { POSTGRES_SSL_MODES } from "bazis/core/infra";
import { configEnum, defineConfig, secret } from "bazis/core/kernel";

/**
 * PostgreSQL connection. Every key can be overridden from the environment:
 * `BAZIS_DB__HOST`, `BAZIS_DB__PASSWORD`, ... In `production` the password has
 * no default and must come from the environment, otherwise startup fails.
 */
export const dbConfig = defineConfig("db", {
  default: {
    host: "127.0.0.1",
    port: 5432,
    database: "orders",
    username: "postgres",
    password: secret("postgres"),
    tls: configEnum(POSTGRES_SSL_MODES, "disable"),
  },
  production: {
    password: secret(),
    tls: "verify-full",
  },
});
