import { SQL } from "bun";
import { createToken, type InjectionToken } from "../../di";
import type { AppConfig, ConfigRegistry, Secret } from "../../kernel";
import { reader, requireValue } from "../connectorConfig";
import { errorMessage, InfraError, type InfraConnector } from "../InfraConnector";

/** Клиент PostgreSQL (нативный Bun `SQL`, без внешних зависимостей). */
export const POSTGRES: InjectionToken<SQL> = createToken<SQL>("Postgres");

/**
 * Интерфейс конфига, который требует коннектор PostgreSQL. Конфиг подсистемы БД
 * (`defineConfig<DbConfig>("db", ...)`) должен предоставлять эти ключи.
 */
export interface PostgresConfigShape {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: Secret;
  readonly tls?: PostgresSslMode;
  readonly max?: number;
  readonly connectionTimeout?: number;
  readonly idleTimeout?: number;
  readonly maxLifetime?: number;
}

export type PostgresSslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
export interface PostgresConnectorOptions {
  readonly token?: InjectionToken<SQL>;
  /** Maximum pool drain before closing connections. Default 1000ms; 0 closes immediately. */
  readonly shutdownTimeoutMs?: number;
}

/** Shared raw SQL/ORM options. Driver timeout fields are in seconds. */
export function postgresConnectionOptions(config: AppConfig<PostgresConfigShape>, configs?: ConfigRegistry): Bun.SQL.Options {
  const c = reader(config, configs);
  const integer = (key: string, min: number, max: number): number | undefined => {
    const value = c.has(key) ? c.get(key) : undefined;
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new InfraError(`postgres ${key} must be an integer ${min}..${max}`);
    return value;
  };
  const tls = c.has("tls") ? c.get("tls") : undefined;
  if (tls !== undefined && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(String(tls))) throw new InfraError("postgres tls is invalid");
  return {
    hostname: requireValue(c.get("host"), "host", "postgres"),
    port: integer("port", 1, 65535),
    database: requireValue(c.get("database"), "database", "postgres"),
    username: requireValue(c.get("username"), "username", "postgres"),
    password: (c.get("password") as Secret).reveal(),
    ...(tls === undefined ? {} : { tls: tls as PostgresSslMode }),
    max: integer("max", 1, 2147483647),
    connectionTimeout: integer("connectionTimeout", 1, 2147483647),
    idleTimeout: integer("idleTimeout", 0, 2147483647),
    maxLifetime: integer("maxLifetime", 0, 2147483647),
  };
}

/**
 * Коннектор PostgreSQL для манифеста `@Infra`. Конфигурация берётся целиком из
 * переданного объекта `dbConfig` (`defineConfig("db", ...)`): коннектор сам читает
 * объявленные ключи (`host`/`port`/`database`/`username`/`password`), никаких
 * строк-ключей в манифесте. Открывает соединение на старте (`SELECT 1`) и
 * закрывает на остановке.
 *
 * ```ts
 * export const dbConfig = defineConfig("db", {
 *   default: { host: "localhost", port: 5432, database: "app", username: "postgres", password: secret("dev") },
 * });
 * @Infra({ db: postgres(dbConfig) })
 * export class AppInfra {}
 * // инъекция: constructor(private readonly sql: SQL) {}  // токен POSTGRES
 * ```
 */
export function postgres<T extends PostgresConfigShape>(config: AppConfig<T>, options: PostgresConnectorOptions = {}): InfraConnector<SQL> {
  const shutdownTimeoutMs = options.shutdownTimeoutMs === undefined ? 1000 : options.shutdownTimeoutMs;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 2147483647) {
    throw new InfraError("postgres shutdownTimeoutMs must be an integer 0..2147483647");
  }
  return {
    token: options.token ?? POSTGRES,
    config,
    create(configs) {
      return new SQL(postgresConnectionOptions(config, configs));
    },
    async connect(client) {
      try {
        await client.unsafe("SELECT 1");
      } catch (error) {
        throw new InfraError(`Infra connector "postgres": failed to connect — ${errorMessage(error)}`);
      }
    },
    async dispose(client) {
      await client.close({ timeout: shutdownTimeoutMs / 1000 });
    },
    async healthCheck(client) {
      try {
        await client.unsafe("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}
