import { configEnum, defineConfig, secret, type Secret } from "bazis/core/kernel";
import type { PostgresSslMode } from "bazis/core/infra";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: Secret;
  tls: PostgresSslMode;
}

/**
 * PostgreSQL connection. Every key can be overridden from the environment:
 * `BAZIS_DB__HOST`, `BAZIS_DB__PASSWORD`, ... In `production` the password has
 * no default and must come from the environment, otherwise startup fails.
 */
export const dbConfig = defineConfig<DbConfig>("db", {
  default: {
    host: "127.0.0.1",
    port: 5432,
    database: "todo",
    username: "postgres",
    password: secret("postgres"),
    tls: configEnum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"], "disable"),
  },
  production: {
    password: secret(),
    tls: "verify-full",
  },
});
