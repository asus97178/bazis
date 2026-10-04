import { InfraError, reader, requireValue, postgresConnectionOptions, type InfraConnector, type PostgresConfigShape } from "../infra";
import type { AppConfig, ConfigRegistry, Secret } from "../kernel";
import { postgres, type DatabaseProvider, type PostgresServerTimeouts } from "../../library/orm";
import { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";

/** Соединение раньше серверов и ORM-фич: открыть БД до того, как кто-то её спросит. */
const DATABASE_PHASE = -110;

/** Optional operational fields belong to the ORM connection contract. */
export interface PostgresOrmConfigShape extends PostgresConfigShape {
  readonly max?: number;
  readonly connectionTimeout?: number;
  readonly idleTimeout?: number;
  readonly maxLifetime?: number;
  readonly tls?: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  readonly tlsCa?: string;
  readonly operationTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
  readonly cancellationMode?: "server" | "close";
  readonly maxPendingOperations?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly transactionTimeoutMs?: number;
}

function buildPostgresProvider<T extends PostgresOrmConfigShape>(config: AppConfig<T>, configs?: ConfigRegistry): DatabaseProvider {
  const c = reader(config, configs);
  const optional = (key: string) => c.has(key) ? c.get(key) : undefined;
  const number = (key: string, allowZero = false): number | undefined => {
    const value = optional(key);
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 2_147_483_647) throw new InfraError(`Invalid PostgreSQL configuration field: ${key}.`);
    return value;
  };
  const hostname = requireValue(c.get("host"), "host", "database");
  const options: Record<string, unknown> = { ...postgresConnectionOptions(config, configs) };
  for (const key of ["max", "connectionTimeout", "idleTimeout", "maxLifetime"] as const) {
    const value = number(key, key === "idleTimeout" || key === "maxLifetime");
    if (value !== undefined) options[key] = value;
  }
  // defineConfig keys are always present, so an empty tlsCa means "no additional CA".
  const tls = optional("tls"), configuredCa = optional("tlsCa"), ca = configuredCa === "" ? undefined : configuredCa;
  if (tls !== undefined) {
    if (typeof tls !== "string" || !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(tls)) throw new InfraError("Invalid PostgreSQL configuration field: tls.");
    options.tls = tls;
  }
  if (ca !== undefined) {
    if (typeof ca !== "string" || !ca.trim() || tls !== "verify-full") throw new InfraError("tlsCa requires a non-empty certificate and tls=verify-full.");
    options.tls = { ca, serverName: hostname, rejectUnauthorized: true };
  }
  const serverTimeouts: Record<string, number> = {};
  const cancellationMode = optional("cancellationMode");
  if (cancellationMode !== undefined && cancellationMode !== "server" && cancellationMode !== "close") throw new InfraError("Invalid PostgreSQL configuration field: cancellationMode.");
  for (const key of ["statementTimeoutMs", "lockTimeoutMs", "idleInTransactionTimeoutMs", "transactionTimeoutMs"] as const) {
    const value = number(key); if (value !== undefined) serverTimeouts[key] = value;
  }
  return postgres({ options, operationTimeoutMs: number("operationTimeoutMs"), cancellationTimeoutMs: number("cancellationTimeoutMs"), cancellationMode, maxPendingOperations: number("maxPendingOperations"), serverTimeouts: serverTimeouts as PostgresServerTimeouts });
}

/**
 * Connection-коннектор БД для `@Infra` — мост между инфраструктурой и ORM
 * (модель «как в EF Core»: соединение даётся снаружи, ORM работает поверх него).
 *
 * Принимает конфиг PostgreSQL подсистемы целиком (`dbConfig` из
 * `defineConfig("db", ...)`) и сам читает объявленные ключи. Публикует `DatabaseProvider` под общим токеном
 * {@link DATABASE_PROVIDER}, открывает на старте (фаза −110, раньше ORM-фич и
 * серверов) и закрывает на остановке.
 *
 * Миграции остаются на фиче (модель-зависимы): `ormOsnova: { context, entities,
 * ensureCreated }` без `provider` работает поверх этого общего соединения.
 *
 * ```ts
 * export const dbConfig = defineConfig("db", {
 *   default: { host: "db", port: 5432, database: "app", username: "postgres", password: secret("dev") },
 * });
 * @Infra({ db: ormOsnovaConnect(dbConfig) })
 * export class AppInfra {}
 *
 * @Module({ ormOsnova: { context: UsersDbContext, entities: [User], ensureCreated: true } })
 * export class UsersModule {}  // потребитель общего DATABASE_PROVIDER
 * ```
 */
export function ormOsnovaConnect<T extends PostgresOrmConfigShape>(config: AppConfig<T>): InfraConnector<DatabaseProvider>;
export function ormOsnovaConnect(
  config: AppConfig<PostgresOrmConfigShape>,
): InfraConnector<DatabaseProvider> {
  return {
    token: DATABASE_PROVIDER,
    config,
    phase: DATABASE_PHASE,
    create(configs) {
      return buildPostgresProvider(config, configs);
    },
    async connect(provider, signal) {
      if (!(await provider.ping(signal))) {
        throw new InfraError('Infra connector "database": postgres is not reachable.');
      }
    },
    async dispose(provider) {
      await provider.close();
    },
    healthCheck(provider, signal) {
      return provider.ping(signal);
    },
  };
}
