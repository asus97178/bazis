import { OwnedStoreCatalogReader, selectOwnedStoreRows } from "./OwnedStoreCatalog.reader";
import { canonicalPostgresColumn, canonicalPostgresCheck, exactPostgresType, collectPostgresIndexes, collectPostgresForeignKeys } from "./PostgresSchema.decoder";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { types } from "node:util";
import { SQL } from "bun";
import { redactTraceValues } from "../../redaction";
import type { IntrospectedColumn, IntrospectedForeignKey, IntrospectedIndex, IntrospectedSchema, IntrospectedTable } from "../Schema/introspection";
import { PostgresDialect } from "./PostgresDialect";
import { currentPostgresScopeOptions, withPostgresScopeOptions, withoutPostgresScopeOptions, observeProviderDispatch, registerPostgresTransactionCapability, withoutProviderDispatchObserver } from "./ormTransactionRuntime";
import { runPostCommitCallbacks, runRollbackCallbacks } from "./transactionCallbacks";
import { isUnknownTransactionOutcome, isConfirmedCommitRejection, isConfirmedStatementRejection, notifyTransactionUncertainty, TransactionOutcomeUnknownError } from "./transactionOutcome";
import {
  assertTransactionCanCommit,
  beginChildTransactionScope,
  endChildTransactionScope,
  markTransactionRollbackOnly,
  mergeTransactionScopeCallbacks,
  createTransactionCallbackScope,
  type TransactionCallbackScope,
} from "./transactionScopes";
import type {
  AfterCommitCallback,
  DatabaseProvider,
  DatabaseProviderDiagnostic,
  DatabaseProviderLimits,
  DbExecutor,
  ExecuteResult,
  NotificationSubscription,
  Row,
  SchemaAdmissionScope,
  SqlDialect,
  SqlParam,
  TransactionCallback,
} from "./types";
import { OperationDeadline, positiveTimeout } from "./operationDeadline";
import { OrmTransactionScopeError, OrmDatabaseTimeError, OrmOwnedStoreAdmissionError, PostCommitError, SchemaAdmissionError } from "../errors";
import type { OrmDatabaseTimeV1 } from "../Transactions/OrmTransaction";
import type { ExpectedTable, OrmExpectedSchema } from "../Schema/ExpectedSchema";
import { renderSafeAdditivePostgres } from "../Schema/SafeAdditiveSchema";
import { introspectedTableKey } from "../Schema/tableKey";
import { canonicalOwnedStoreRegistryLockPreimageV1, ownedStoreAdvisoryLockV1 } from "../Schema/OwnedStoreCanonical";
import { failure, registerPostgresOwnedStoreCapability, type OwnedStoreCreateOperationV1, type OwnedStoreIdentityInsertV1, type OwnedStoreSecondaryLockPlanV1, type RegistryLockedOwnedStoreSessionV1, type SecondaryLockedOwnedStoreSessionV1 } from "./ormOwnedStoreRuntime";
import type { OwnedStoreRegistrySnapshotV1 } from "../Schema/OwnedStoreCatalog";
import type { OrmCatalogScopeV1 } from "../Schema/OrmOwnedStore";

/** Нативная форма `sql.listen` Bun (PR oven-sh/bun#32089). */
type BunListen = (
  channel: string,
  handler: (payload: string) => void | Promise<void>,
) => Promise<{ unlisten?: () => Promise<void> | void } | void>;

/** Минимальная форма результата запроса Bun SQL (массив строк + метаданные). */
type BunSqlResult = Row[] & { affectedRows?: number; count?: number };

/** Поверхность Bun SQL, которую использует провайдер (общая для пула и транзакции). */
interface SqlLike {
  unsafe(query: string, values?: readonly unknown[]): Promise<BunSqlResult>;
  close?(options?: { timeout?: number }): Promise<void>;
}
type CancellableSqlQuery = Promise<BunSqlResult> & { cancel?: () => unknown };

/** Зарезервированное соединение Bun SQL (для session-level advisory lock). */
interface ReservedSqlLike extends SqlLike {
  release(): void | Promise<void>;
}

interface AmbientTransaction {
  readonly executor: DbExecutor;
  readonly session: SqlLike;
  readonly owner?: PhysicalTransactionOwner;
}

type OwnerState = "active" | "quarantining" | "quarantined" | "released";
interface BackendIdentity { readonly pid: string; readonly datid: string; readonly backendStart: string; readonly postmasterStart: string; readonly address: string; readonly port: string; }
const CANCEL_BACKEND_MATCH = "a.pid=$1::int AND a.datid=$2::oid AND extract(epoch FROM a.backend_start)=$3::numeric AND extract(epoch FROM pg_catalog.pg_postmaster_start_time())=$4::numeric AND host(inet_server_addr())=$5 AND inet_server_port()::text=$6 AND a.usename=current_user AND a.state='active'";
const CANCEL_INSPECT_SQL = `/* osnova:cancel-inspect */ SELECT extract(epoch FROM a.query_start)::numeric(20,6)::text AS query_start FROM pg_catalog.pg_stat_activity a WHERE ${CANCEL_BACKEND_MATCH}`;
const CANCEL_SIGNAL_SQL = `/* osnova:cancel-signal */ SELECT pg_catalog.pg_cancel_backend(a.pid) AS signaled FROM pg_catalog.pg_stat_activity a WHERE ${CANCEL_BACKEND_MATCH} AND extract(epoch FROM a.query_start)=$7::numeric`;
interface PhysicalTransactionOwner {
  readonly session: ReservedSqlLike;
  readonly lifetime: "owned" | "borrowed";
  state: OwnerState;
  backend?: BackendIdentity;
  quarantinePromise?: Promise<void>;
  releasePromise?: Promise<void>;
  unknownOutcome?: TransactionOutcomeUnknownError;
  operation?: OperationDeadline;
  callbacks?: TransactionCallbackScope;
  closePromise?: Promise<void>;
  /** Original native work, never the AbortSignal-facing projection. */
  pending?: Set<Promise<unknown>>;
  rollbackAcknowledged?: boolean;
  backendAbsenceAcknowledged?: boolean;
}
interface OwnedStoreAttemptV1 {
  readonly owner: PhysicalTransactionOwner;
  readonly signal: AbortSignal | undefined;
  phase: "starting" | "registryLocked" | "secondaryLocked" | "callbackClosed" | "committing" | "released";
  generation: number;
  poisoned: boolean;
  lockUncertainty: boolean;
  mutationFailure: boolean;
  semanticFailure: boolean;
  busy: boolean;
  readonly pending: Set<Promise<unknown>>;
  createRegistryCalls: number;
  applyCalls: number;
  insertCalls: number;
}

/** PostgreSQL-private trace boundary; the public scope deliberately omits it. */
type InternalSchemaAdmissionScope = SchemaAdmissionScope & {
  readonly executeSchemaAdmission: (sql: string, operation: string) => ReturnType<SchemaAdmissionScope["execute"]>;
};

/**
 * Ключ advisory-блокировки миграций (произвольная константа bigint). Все
 * инстансы приложения используют один ключ, поэтому конкурентный `migrate()`
 * сериализуется на стороне PostgreSQL.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 0x6f_73_6e_76; // "osnv"
const STRICT_LOCK_DOMAIN = "osnova.orm.strict-migration-lock/v1\0";
const ADMISSION_LOCK_DOMAIN = "osnova.orm.ensure-created/schema-lock/v1\0";
/** Detect the astronomically unlikely 64-bit truncation collision rather than merging owners. */
const strictLockOwners = new Map<string, string>();
const admissionLockOwners = new Map<string, string>();
/** Exact retained reservations are fenced by object identity, not ALS. */
const physicalOwners = new WeakMap<object, PhysicalTransactionOwner>();

/** PostgreSQL-private strict wire parser; no app clock or fallback is permitted. */
function postgresDatabaseTime(value: unknown): OrmDatabaseTimeV1 {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") throw new OrmDatabaseTimeError();
  const text = String(value);
  if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(text)) throw new OrmDatabaseTimeError();
  const milliseconds = Number(text);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(new Date(milliseconds).getTime())) throw new OrmDatabaseTimeError();
  return Object.freeze({ instant: Object.freeze(new Date(milliseconds)), epochMilliseconds: milliseconds, precision: "millisecond" });
}

function strictLockKey(owner: string): bigint {
  return createHash("sha256").update(STRICT_LOCK_DOMAIN + owner, "utf8").digest().readBigInt64BE(0);
}

const MIGRATION_LOCK_UNAVAILABLE: DatabaseProviderDiagnostic = {
  code: "postgres.migration_lock_unavailable",
  severity: "warning",
  message:
    "PostgreSQL advisory migration lock is unavailable because Bun.SQL.reserve() is not present. ORM migrations will run without an inter-process lock; avoid concurrent production startup or upgrade Bun.",
};

export interface PostgresServerTimeouts {
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  /** PostgreSQL 17+; terminates the session when exceeded. */
  readonly transactionTimeoutMs?: number;
}

export interface PostgresOperationEvent {
  readonly operation: "query" | "execute" | "admission" | "cancellation";
  readonly outcome: "success" | "error" | "unknown";
  readonly durationMs: number;
  readonly pendingNativeOperations: number;
}

export interface PostgresProviderOptions {
  readonly operationTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
  /** Server cancellation uses one additional, lazy control connection. */
  readonly cancellationMode?: "server" | "close";
  readonly maxPendingOperations?: number;
  readonly serverTimeouts?: PostgresServerTimeouts;
  /** Completion telemetry contains no SQL, parameters, credentials or error messages. */
  readonly onOperation?: (event: PostgresOperationEvent) => void;
  /** Строка подключения, напр. `postgres://user:pass@localhost:5432/db`. */
  readonly url?: string;
  /** Опции Bun SQL (host/port/user/password/database/max/idleTimeout/...). */
  readonly options?: Record<string, unknown>;
  /** Колбэк трассировки SQL — для логгирования/метрик. */
  readonly onSql?: (sql: string, params: readonly SqlParam[]) => void;
  /**
   * SQL trace params are redacted by default. Pass false only for trusted local
   * debugging where raw query values are acceptable.
   */
  readonly redactSqlParams?: boolean;
  /** Optional warning sink for provider diagnostics; defaults to console.warn. */
  readonly onWarning?: (warning: DatabaseProviderDiagnostic) => void;
}

/**
 * Провайдер PostgreSQL поверх нативного Bun `SQL` — без внешних зависимостей
 * (драйвер встроен в Bun).
 *
 * Все запросы параметризованы через `unsafe(sql, params)` с плейсхолдерами
 * `$1, $2, ...`. Транзакция резервирует выделенное соединение из пула через
 * `sql.begin`, поэтому в `transaction()` запросы идут через scoped-executor —
 * это безопасно при конкурентных scoped-контекстах (по одному на запрос).
 */
export class PostgresProvider implements DatabaseProvider {
  readonly name = "postgres";
  readonly dialect: SqlDialect = new PostgresDialect();
  readonly limits: DatabaseProviderLimits = {
    maxParametersPerCommand: 32767,
    maxRowsPerInsert: 5000,
    maxParametersPerInList: 10000,
  };
  readonly schemaAdmissionCapability = {
    version: 1 as const,
    provider: "postgres" as const,
    distributedLock: true as const,
    transactionalDdl: true as const,
    exactIntrospection: true as const,
    withSchemaAdmission: <T>(schemas: readonly string[], work: (scope: import("./types").SchemaAdmissionScope) => Promise<T>) => this.withSchemaAdmission(schemas, work),
  };

  private readonly operationTimeoutMs: number;
  private readonly cancellationTimeoutMs: number;
  private readonly cancellationMode: "server" | "close";
  private readonly controlConfig: Record<string, unknown>;
  private controlSql?: SQL;
  /** Bun may briefly reissue a retired TLS slot before its close callback.
   * After retirement, validate all later leases for this pool's lifetime. */
  private validateWorkerAdmissions = false;
  private validateControlAdmissions = false;
  private readonly reservationRetirements = new WeakMap<object, Promise<void>>();
  private readonly closing = new AbortController();
  private readonly maxPendingOperations: number;
  private readonly serverTimeouts: PostgresServerTimeouts;
  private readonly onOperation?: (event: PostgresOperationEvent) => void;
  private readonly uncertainErrors = new WeakSet<object>();
  private pendingNativeOperations = 0;
  private activeCancellations = 0;
  private unconfirmedCancellations = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly sql: SQL;
  private readonly onSql?: (sql: string, params: readonly SqlParam[]) => void;
  private readonly redactSqlParams: boolean;
  private readonly onWarning?: (warning: DatabaseProviderDiagnostic) => void;
  private migrationLockFallbackWarned = false;
  /** Окружающая транзакция текущего async-контекста (для join-семантики). */
  private readonly ambient = new AsyncLocalStorage<AmbientTransaction>();
  private readonly transactionCallbacks = new AsyncLocalStorage<TransactionCallbackScope>();
  /** Session reserved by an advisory lock; transactions reuse it to avoid pool starvation. */
  /** Advisory/schema owners are borrowed by nested transactions.  Keep their
   * exact physical lifetime, rather than recreating an owner per BEGIN. */
  private readonly lockedSession = new AsyncLocalStorage<PhysicalTransactionOwner>();
  private readonly strictLock = new AsyncLocalStorage<{ readonly owner: string; readonly key: bigint }>();
  private nextTransactionScopeId = 0;

  constructor(options: PostgresProviderOptions = {}) {
    this.operationTimeoutMs = positiveTimeout(options.operationTimeoutMs, 30_000, "operationTimeoutMs");
    this.cancellationTimeoutMs = positiveTimeout(options.cancellationTimeoutMs, 5_000, "cancellationTimeoutMs");
    if (options.cancellationMode !== undefined && options.cancellationMode !== "server" && options.cancellationMode !== "close") throw new TypeError("cancellationMode must be server or close.");
    this.cancellationMode = options.cancellationMode ?? "server";
    this.maxPendingOperations = positiveTimeout(options.maxPendingOperations, 256, "maxPendingOperations");
    this.serverTimeouts = Object.freeze({ ...options.serverTimeouts });
    for (const [name, value] of Object.entries(this.serverTimeouts)) positiveTimeout(value, 30_000, name);
    this.onOperation = options.onOperation;
    const config = options.url ?? options.options ?? {};
    this.sql = new SQL(config as never);
    this.controlConfig = { ...(typeof config === "string" ? { url: config } : config), max: 1 };
    this.onSql = options.onSql;
    this.redactSqlParams = options.redactSqlParams !== false;
    this.onWarning = options.onWarning;
    registerPostgresTransactionCapability(this, {
      operationTimeoutMs: this.operationTimeoutMs,
      isOutcomeUncertain: (error) => typeof error === "object" && error !== null && this.uncertainErrors.has(error),
      operationSignal: () => this.ambient.getStore()?.owner?.operation?.signal,
      quarantineOnPendingDispatch: true,
      databaseTime: async () => {
        try {
          return postgresDatabaseTime((await this.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS epoch_ms", []))[0]?.epoch_ms);
        } catch {
          throw new OrmDatabaseTimeError();
        }
      },
      assertScopedClose: async () => {
        const owner = this.ambient.getStore()?.owner;
        if (!owner || owner.state !== "active" || typeof owner.session.close !== "function") throw new Error("PostgreSQL scoped-session close capability is unavailable.");
        // Capture identity on the retained reservation. Socket polling also
        // supports the explicit connection-close fallback.
        await this.ownerCommand(owner, "SET LOCAL client_connection_check_interval = '250ms'");
        const readback = await this.ownerCommand(owner, "SELECT current_setting('client_connection_check_interval') AS interval");
        if (String(readback[0]?.interval ?? "") !== "250ms") throw new Error("PostgreSQL polling readback failed.");
        owner.backend ??= await this.readBackendIdentity(owner.session);
      },
      // Only an ambient transaction session is eligible. `this.sql` is the
      // root pool and is deliberately never reached by this path.
      quarantine: async () => {
        const owner = this.ambient.getStore()?.owner;
        if (!owner || typeof owner.session.close !== "function") {
          throw new Error("PostgreSQL scoped-session close capability is unavailable.");
        }
        return this.quarantineOwner(owner);
      },
    });
    registerPostgresOwnedStoreCapability(this, { withOwnedStoreAdmission: (signal, work) => this.withOwnedStoreAdmissionV1(signal, work) });
  }

  diagnostics(): readonly DatabaseProviderDiagnostic[] {
    return this.reserveConnection ? [] : [MIGRATION_LOCK_UNAVAILABLE];
  }

  async query(sql: string, params: readonly SqlParam[]): Promise<Row[]> {
    const ambient = this.ambient.getStore();
    if (ambient) {
      return ambient.executor.query(sql, params);
    }
    const locked = this.lockedSession.getStore();
    return locked ? this.runQuery(locked.session, sql, params) : this.pooledOperation((session) => this.runQuery(session, sql, params));
  }

  async execute(sql: string, params: readonly SqlParam[]): Promise<ExecuteResult> {
    const ambient = this.ambient.getStore();
    if (ambient) {
      return ambient.executor.execute(sql, params);
    }
    const locked = this.lockedSession.getStore();
    return locked ? this.runExecute(locked.session, sql, params) : this.pooledOperation((session) => this.runExecute(session, sql, params));
  }

  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    // Вложенный вызов присоединяется к окружающей транзакции (то же
    // зарезервированное соединение) — семантика "Required".
    const ambient = this.ambient.getStore();
    if (ambient) {
      const callbacks = this.transactionCallbacks.getStore();
      return Promise.resolve().then(() => work(ambient.executor)).catch((error) => {
        // Required joins have no independent rollback. Even if the caller
        // catches a conversion/application error, earlier writes must unwind.
        // Poison only this frame: a containing savepoint can still recover.
        if (callbacks) callbacks.rollbackOnly ??= error ?? new Error("Joined transaction failed.");
        throw error;
      });
    }
    const lockedOwner = this.lockedSession.getStore();
    if (lockedOwner) {
      return this.transactionOnReservedSession(lockedOwner, work);
    }
    const reserve = this.reserveConnection;
    if (reserve) return this.transactionOnOwnedReservedSession(reserve, work);
    // begin резервирует соединение из пула и передаёт scoped sql; ROLLBACK при
    // ошибке выполняется автоматически. Конкурентные транзакции безопасны (пул).
    const callbacks = createTransactionCallbackScope();
    let workCompleted = false;
    const transaction = this.sql.begin((scoped: SqlLike) => {
      const executor: DbExecutor = {
        query: (sql, params) => this.runQuery(scoped, sql, params),
        execute: (sql, params) => this.runExecute(scoped, sql, params),
      };
      return this.transactionCallbacks.run(
        callbacks,
        () => this.ambient.run({ executor, session: scoped }, async () => {
          const result = await work(executor);
          assertTransactionCanCommit(callbacks);
          workCompleted = true;
          return result;
        }),
      );
    }) as Promise<T>;
    return transaction.then(
      (result) => this.completeTransaction(result, callbacks.afterCommit),
      (error) => {
        if (workCompleted && !isConfirmedCommitRejection(error)) {
          notifyTransactionUncertainty(callbacks.afterRollback);
          throw this.uncertainty(error);
        }
        return this.completeRollback(error, callbacks.afterRollback);
      },
    );
  }

  transactionScope<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const ambient = this.ambient.getStore();
    if (ambient === undefined) {
      return this.transaction(work);
    }
    const parent = this.transactionCallbacks.getStore();
    if (parent === undefined) {
      return Promise.reject(new Error("PostgreSQL ambient transaction has no transaction callback scope."));
    }
    return this.runTransactionScope(ambient.executor, parent, work);
  }

  isTransactionActive(): boolean {
    return this.ambient.getStore() !== undefined;
  }

  afterCommit(callback: AfterCommitCallback): Promise<void> | void {
    const callbacks = this.transactionCallbacks.getStore()?.afterCommit;
    if (callbacks) {
      callbacks.push(callback);
      return;
    }
    return callback();
  }

  afterRollback(callback: TransactionCallback): void {
    this.transactionCallbacks.getStore()?.afterRollback.push(callback);
  }

  private completeTransaction<T>(result: T, callbacks: readonly AfterCommitCallback[]): Promise<T> {
    return withoutPostgresScopeOptions(() => this.ambient.exit(() => this.transactionCallbacks.exit(async () => {
      await runPostCommitCallbacks(callbacks);
      return result;
    })));
  }

  private completeRollback(error: unknown, callbacks: readonly TransactionCallback[]): Promise<never> {
    return withoutPostgresScopeOptions(() => this.ambient.exit(() =>
      this.transactionCallbacks.exit(() => runRollbackCallbacks(callbacks, error)),
    ));
  }

  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await withPostgresScopeOptions({ signal }, () => this.pooledOperation((session) => this.runQuery(session, "SELECT 1", [])));
      return true;
    } catch {
      return false;
    }
  }

  async introspect(): Promise<IntrospectedSchema> {
    const tableRows = await this.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE'
         AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      [],
    );

    return this.introspectTables(tableRows.map((row) => ({ schema: String(row.table_schema), table: String(row.table_name) })));
  }

  private async introspectExpected(expected: OrmExpectedSchema, executor: DbExecutor = this): Promise<IntrospectedSchema> {
    const schemas = new Set<string>();
    for (const schema of new Set(expected.tables.map((table) => table.schema))) {
      if ((await executor.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).length) schemas.add(schema);
    }
    const result = await this.introspectTables(
      expected.tables.map((table) => ({ schema: table.schema, table: table.table })),
      executor,
      (schema, table) => `${schema}.${table}`,
      true,
    );
    return { ...result, schemas };
  }

  private async introspectTables(
    targets: readonly { readonly schema: string; readonly table: string }[],
    executor: DbExecutor = this,
    keyOf: (schema: string, table: string) => string = introspectedTableKey,
    exact = false,
  ): Promise<IntrospectedSchema> {
    const tables = new Map<string, IntrospectedTable>();
    for (const target of targets) {
      const table = await this.introspectTable(target.schema, target.table, executor, exact);
      if (table) tables.set(keyOf(target.schema, target.table), table);
    }
    return { tables };
  }

  private async introspectTable(schema: string, name: string, executor: DbExecutor = this, exact = false): Promise<IntrospectedTable | undefined> {
    const exists = await executor.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')", [schema, name]);
    if (!exists.length) return undefined;
    const columnRows = await executor.query(`SELECT a.attname AS column_name, a.attnotnull AS not_null, format_type(a.atttypid, a.atttypmod) AS type_name, pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity AS identity_kind
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, name]);
    const primaryRows = await executor.query(`SELECT c.conname AS constraint_name, a.attname AS column_name, k.ord
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p' ORDER BY k.ord`, [schema, name]);
    const primaryKey = primaryRows.length ? { name: String(primaryRows[0]!.constraint_name), columns: primaryRows.map((row) => String(row.column_name)) } : undefined;
    const primaryColumns = new Set(primaryKey?.columns ?? []);
    const columns = new Map<string, IntrospectedColumn>(columnRows.map((row) => {
      const normalized = canonicalPostgresColumn(String(row.type_name), row.default_expr == null ? null : String(row.default_expr), String(row.identity_kind ?? ""));
      const column = String(row.column_name);
      return [column, { name: column, notNull: row.not_null === true, isPrimaryKey: primaryColumns.has(column), ...normalized, physicalType: exact ? exactPostgresType(String(row.type_name), normalized.physicalType) : normalized.physicalType }];
    }));
    const indexRows = await executor.query(`SELECT ic.relname AS index_name, ix.indisunique AS is_unique, am.amname AS method, ix.indpred IS NOT NULL AS has_predicate, ix.indisvalid AS is_valid, ix.indisready AS is_ready, ix.indnkeyatts AS key_count, k.ord, a.attname AS column_name, k.attnum = 0 AS is_expression, k.ord > ix.indnkeyatts AS is_include,
      EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u')) AS backing_constraint
      FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class tc ON tc.oid = ix.indrelid JOIN pg_namespace n ON n.oid = tc.relnamespace JOIN pg_am am ON am.oid = ic.relam JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY k(attnum, ord) ON true LEFT JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = k.attnum
      WHERE n.nspname = $1 AND tc.relname = $2 ORDER BY ic.relname, k.ord`, [schema, name]);
    const indexes = collectPostgresIndexes(indexRows, exact);
    const foreignRows = await executor.query(`SELECT c.conname AS constraint_name, ln.nspname AS target_schema, lt.relname AS target_table, la.attname AS column_name, ra.attname AS target_column, k.ord, c.confdeltype AS delete_code, c.confupdtype AS update_code, c.confmatchtype AS match_code, c.condeferrable AS deferrable, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class lt ON lt.oid = c.confrelid JOIN pg_namespace ln ON ln.oid = lt.relnamespace JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(local_attnum, ord) ON true JOIN LATERAL unnest(c.confkey) WITH ORDINALITY rk(target_attnum, target_ord) ON rk.target_ord = k.ord JOIN pg_attribute la ON la.attrelid = t.oid AND la.attnum = k.local_attnum JOIN pg_attribute ra ON ra.attrelid = lt.oid AND ra.attnum = rk.target_attnum
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f' ORDER BY c.conname, k.ord`, [schema, name]);
    const foreignKeys = collectPostgresForeignKeys(foreignRows, exact);
    const checkRows = await executor.query(`SELECT c.conname AS constraint_name, pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'c' ORDER BY c.conname`, [schema, name]);
    const checks = checkRows.map((row) => canonicalPostgresCheck(String(row.constraint_name), String(row.definition)));
    return { name, columns, indexes, primaryKey, foreignKeys, checks };
  }

  async withMigrationLock<T>(work: () => Promise<T>): Promise<T> {
    // Advisory locks are session-reentrant. Reuse the already locked session
    // instead of reserving a second connection and waiting on ourselves.
    if (this.lockedSession.getStore()) {
      return work();
    }
    const reserve = this.reserveConnection;
    if (!reserve) {
      this.emitWarning(MIGRATION_LOCK_UNAVAILABLE);
      return work();
    }
    const reserved = await reserve();
    const owner: PhysicalTransactionOwner = { session: reserved, lifetime: "borrowed", state: "active" }; physicalOwners.set(reserved, owner);
    try {
      await reserved.unsafe("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      return await this.lockedSession.run(owner, work);
    } finally {
      try {
        if (!owner.unknownOutcome && (owner.state === "active" || owner.rollbackAcknowledged)) await this.unlockOwner(owner, [MIGRATION_ADVISORY_LOCK_KEY]);
      } finally {
        await this.releaseOwner(owner);
      }
    }
  }

  private async withSchemaAdmission<T>(schemas: readonly string[], work: (scope: SchemaAdmissionScope) => Promise<T>): Promise<T> {
    const normalized = [...new Set(schemas.map((schema) => schema.trim() || "public"))].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    const keys = normalized.map((schema) => ({ schema, key: createHash("sha256").update(ADMISSION_LOCK_DOMAIN + schema, "utf8").digest().readBigInt64BE(0) }));
    for (const { schema, key } of keys) {
      const keyText = key.toString();
      const owner = admissionLockOwners.get(keyText);
      if (owner !== undefined && owner !== schema) {
        throw new SchemaAdmissionError("ORM_SCHEMA_LOCK_KEY_COLLISION", "PostgreSQL schema admission lock key collision was detected.");
      }
      admissionLockOwners.set(keyText, schema);
    }
    const ambient = this.ambient.getStore();
    if (ambient) {
      this.assertActiveOwner(ambient.session);
      for (const { key } of keys) await ambient.session.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
      return work(this.createSchemaAdmissionScope(ambient.executor, ambient.session));
    }
    const active = this.lockedSession.getStore();
    if (active) {
      try {
        return await this.transaction(async (tx) => {
          this.assertActiveOwner(active.session);
          for (const { key } of keys) await active.session.unsafe("SELECT pg_advisory_xact_lock($1)", [key]);
          return work(this.createSchemaAdmissionScope(tx, active.session));
        });
      } finally { /* collision ownership is process-lifetime, matching the existing hash-domain guard */ }
    }
    const reserve = this.reserveConnection;
    if (!reserve) {
      throw new SchemaAdmissionError("ORM_SCHEMA_LOCK_UNAVAILABLE", "PostgreSQL schema admission lock is unavailable.");
    }
    const reserved = await reserve();
    const owner: PhysicalTransactionOwner = { session: reserved, lifetime: "borrowed", state: "active" }; physicalOwners.set(reserved, owner);
    try {
      for (const { key } of keys) await reserved.unsafe("SELECT pg_advisory_lock($1)", [key]);
      return await this.lockedSession.run(owner, () => this.transaction(async (tx) => work(this.createSchemaAdmissionScope(tx, reserved))));
    } finally {
      try { if (!owner.unknownOutcome && (owner.state === "active" || owner.rollbackAcknowledged)) await this.unlockOwner(owner, [...keys].reverse().map(({ key }) => key)); }
      finally { await this.releaseOwner(owner); }
    }
  }

  private createSchemaAdmissionScope(executor: DbExecutor, session: SqlLike): InternalSchemaAdmissionScope {
    const sessionExecutor: DbExecutor = {
      query: (sql, params) => this.runQuery(session, sql, params),
      execute: (sql, params) => this.runExecute(session, sql, params),
    };
    return {
      ...executor,
      // DDL is issued on the advisory-lock session because Bun's transaction
      // facade does not expose its underlying raw connection. Exact final
      // introspection must use that same session or a pooled query cannot see
      // the still-uncommitted catalog rows.
      introspectExpected: (expected) => this.introspectExpected(expected, sessionExecutor),
      executeSchemaAdmission: (sql, operation) => this.runSchemaAdmissionExecute(session, sql, operation),
    };
  }

  /**
   * Шлёт уведомление через `pg_notify` (обычный пул — активный listener не
   * нужен). Работает на любой версии Bun.
   */
  async notify(channel: string, payload?: string): Promise<void> {
    await this.query("SELECT pg_notify($1, $2)", [channel, payload ?? ""]);
  }

  /**
   * Подписка на канал через нативный `sql.listen` Bun (если доступен в рантайме).
   * Bun сам держит выделенное соединение и переподключается с backoff. Если
   * рантайм ещё без `listen` — бросаем понятную ошибку, и подписчик уходит в
   * поллинг.
   */
  async listen(channel: string, handler: (payload: string) => void | Promise<void>): Promise<NotificationSubscription> {
    const native = (this.sql as unknown as { listen?: BunListen }).listen;
    if (typeof native !== "function") {
      throw new Error("PostgreSQL LISTEN is unavailable in this Bun runtime; falling back to polling.");
    }
    const subscription = await native.call(this.sql, channel, handler);
    const unlisten = subscription && typeof subscription.unlisten === "function" ? subscription.unlisten : undefined;
    return {
      close: () => unlisten?.call(subscription),
    };
  }

  statistics(): Readonly<{ pendingNativeOperations: number; activeCancellations: number; unconfirmedCancellations: number; closed: boolean }> {
    return Object.freeze({ pendingNativeOperations: this.pendingNativeOperations, activeCancellations: this.activeCancellations, unconfirmedCancellations: this.unconfirmedCancellations, closed: this.closed });
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    this.closePromise ??= (async () => {
      const deadline = new OperationDeadline(this.cancellationTimeoutMs);
      try {
        const results = await deadline.wait(Promise.allSettled([
          Promise.resolve().then(() => this.sql.close({ timeout: 0 })),
          Promise.resolve().then(() => this.controlSql?.close({ timeout: 0 })),
        ]));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally { deadline.dispose(); }
    })();
    return this.closePromise;
  }

  private native<T>(work: () => PromiseLike<T>, cleanup = false): Promise<T> {
    if (this.pendingNativeOperations >= this.maxPendingOperations * (cleanup ? 2 : 1)) return Promise.reject(new OrmTransactionScopeError("PostgreSQL pending operation limit reached."));
    this.pendingNativeOperations += 1;
    // A timed-out native promise keeps its slot until it actually settles.
    // Repeated outages cannot create an unbounded number of detached operations.
    return Promise.resolve().then(work).finally(() => { this.pendingNativeOperations -= 1; });
  }

  private event(operation: PostgresOperationEvent["operation"], start: number, ...errors: [] | [unknown]): void {
    try { this.onOperation?.(Object.freeze({ operation, outcome: errors.length === 0 ? "success" : isUnknownTransactionOutcome(errors[0]) ? "unknown" : "error", durationMs: performance.now() - start, pendingNativeOperations: this.pendingNativeOperations })); } catch { /* telemetry cannot change a database outcome */ }
  }

  private operation(): OperationDeadline {
    if (this.closed) throw new OrmTransactionScopeError("PostgreSQL provider is closed.");
    const options = currentPostgresScopeOptions();
    return new OperationDeadline(positiveTimeout(options?.timeoutMs, this.operationTimeoutMs, "timeoutMs"), options?.signal);
  }

  private async reserveSession(operation: OperationDeadline, reserve = this.reserveConnection, control = false): Promise<ReservedSqlLike> {
    if (!reserve) throw new OrmTransactionScopeError("PostgreSQL reservations are unavailable.");
    operation.signal.throwIfAborted();
    const start = performance.now();
    try {
      for (let attempt = 0; ; attempt++) {
        const pending = this.native(() => { operation.signal.throwIfAborted(); return reserve({ signal: operation.signal }); }, control);
        // Also defend against a driver that ignores signal and grants the slot late.
        void pending.then(async (session) => {
          if (operation.signal.aborted || this.closed) {
            try { await this.retireReservation(session, control); } catch { /* retained native slot supplies backpressure if cleanup hangs */ }
          }
        }, () => {});
        let session: ReservedSqlLike | undefined;
        try {
          session = await operation.wait(pending);
          operation.signal.throwIfAborted();
          if (this.closed) throw new OrmTransactionScopeError("PostgreSQL provider is closed.");
          if (control ? this.validateControlAdmissions : this.validateWorkerAdmissions) {
            const retained = session;
            await operation.wait(this.native(() => { operation.signal.throwIfAborted(); return retained.unsafe("/* osnova:admission-check */ SELECT 1"); }, control));
          }
        }
        catch (error) {
          if (session) {
            try { await operation.wait(this.retireReservation(session, control)); }
            catch { /* no release precedes native close settlement */ }
          }
          // Only the read-only admission check may have run. Business SQL,
          // BEGIN and the transaction callback have not been dispatched.
          if (attempt === 0 && !operation.signal.aborted && !this.closed && error instanceof Error && (error as { code?: string }).code === "ERR_POSTGRES_CONNECTION_TIMEOUT") {
            if (control) this.validateControlAdmissions = true; else this.validateWorkerAdmissions = true;
            continue;
          }
          throw error;
        }
        operation.signal.throwIfAborted(); this.event("admission", start); return session;
      }
    } catch (error) { this.event("admission", start, error); throw error; }
  }

  private retireReservation(session: ReservedSqlLike, control = false): Promise<void> {
    if (control) this.validateControlAdmissions = true; else this.validateWorkerAdmissions = true;
    const existing = this.reservationRetirements.get(session);
    if (existing) return existing;
    const retirement = this.native(async () => {
      if (!session.close) throw new OrmTransactionScopeError("PostgreSQL reservation close is unavailable.");
      await session.close({ timeout: 0 });
      await session.release();
    }, true);
    this.reservationRetirements.set(session, retirement);
    return retirement;
  }

  private async pooledOperation<T>(work: (session: SqlLike) => Promise<T>): Promise<T> {
    // Legacy test/custom clients without reserve retain their compatibility path.
    if (!this.reserveConnection) return work(this.sql);
    const operation = this.operation();
    let owner: PhysicalTransactionOwner | undefined;
    let completed = false;
    try {
      const session = await this.reserveSession(operation);
      owner = { session, lifetime: "owned", state: "active", operation };
      physicalOwners.set(session, owner);
      const result = await work(session);
      completed = true;
      return result;
    } finally {
      operation.dispose();
      if (owner) {
        try { await this.releaseOwner(owner); }
        catch (error) {
          if (completed) throw new PostCommitError([error]);
          throw error;
        }
      }
    }
  }

  private async ownerCommand(owner: PhysicalTransactionOwner, sql: string, params: readonly unknown[] = []): Promise<BunSqlResult> {
    const pending = this.ownerNative(owner, () => { this.assertActiveOwner(owner.session); owner.operation?.signal.throwIfAborted(); return owner.session.unsafe(sql, params); });
    return owner.operation ? owner.operation.wait(pending) : pending;
  }

  private ownerNative<T>(owner: PhysicalTransactionOwner, work: () => PromiseLike<T>, cleanup = false): Promise<T> {
    const pending = this.native(work, cleanup);
    (owner.pending ??= new Set()).add(pending);
    void pending.finally(() => { owner.pending!.delete(pending); }).catch(() => {});
    return pending;
  }

  private async executeQuery(executor: SqlLike, sql: string, params: readonly SqlParam[], kind: "query" | "execute"): Promise<BunSqlResult> {
    this.assertActiveOwner(executor);
    this.traceSql(sql, params);
    const owner = physicalOwners.get(executor);
    const autocommit = this.ambient.getStore() === undefined;
    const start = performance.now();
    let nativeQuery: CancellableSqlQuery | undefined;
    const dispatch = () => { this.assertActiveOwner(executor); nativeQuery = executor.unsafe(sql, params as readonly unknown[]) as CancellableSqlQuery; return nativeQuery; };
    const pending = owner ? this.ownerNative(owner, dispatch) : this.native(dispatch);
    const settled = (async () => {
      try {
        const result = owner?.operation ? await owner.operation.wait(pending) : await pending;
        if (owner?.quarantinePromise) await owner.quarantinePromise;
        this.event(kind, start);
        return result;
      } catch (error) {
        // Both query() and execute() can write in autocommit mode. Once handed
        // to the driver, a missing reply is not proof that replay is safe.
        if (autocommit && nativeQuery !== undefined && !isConfirmedStatementRejection(error)) {
          const unknown = this.uncertainty(error);
          if (owner) {
            owner.unknownOutcome ??= unknown;
            owner.state = "quarantined";
            void this.closeOwner(owner).catch(() => {});
          }
          this.event(kind, start, owner?.unknownOutcome ?? unknown);
          throw owner?.unknownOutcome ?? unknown;
        }
        try {
          if (owner?.operation?.signal.aborted && !owner.quarantinePromise) await this.quarantineOwner(owner);
          if (owner?.quarantinePromise) await owner.quarantinePromise;
        } catch (uncertain) { this.event(kind, start, uncertain); throw uncertain; }
        this.event(kind, start, error);
        throw error;
      }
    })();
    observeProviderDispatch({ cancel: () => {
      if (owner) {
        // A completed dispatch must not cancel later work or a new borrower.
        if (!owner.pending?.has(pending)) return;
        if (physicalOwners.get(executor) !== owner || owner.state === "released") throw new OrmTransactionScopeError("PostgreSQL cancellation owner expired.");
        return this.quarantineOwner(owner);
      }
      const query = nativeQuery; if (typeof query?.cancel !== "function") throw new Error("PostgreSQL query cancellation is unavailable."); return query.cancel();
    }, settled });
    return settled;
  }

  private async runQuery(executor: SqlLike, sql: string, params: readonly SqlParam[]): Promise<Row[]> {
    return Array.from(await this.executeQuery(executor, sql, params, "query"));
  }

  private async runExecute(executor: SqlLike, sql: string, params: readonly SqlParam[]): Promise<ExecuteResult> {
    const result = await this.executeQuery(executor, sql, params, "execute");
    return { changes: result.affectedRows ?? result.count ?? result.length, lastInsertId: 0 };
  }

  private async runSchemaAdmissionExecute(executor: SqlLike, sql: string, operation: string): Promise<ExecuteResult> {
    this.assertActiveOwner(executor);
    this.traceSchemaAdmission(operation);
    const result = await executor.unsafe(sql, []);
    const changes = result.affectedRows ?? result.count ?? (Array.isArray(result) ? result.length : 0);
    return { changes, lastInsertId: 0 };
  }

  private assertActiveOwner(executor: SqlLike): void {
    if (this.closed) throw new OrmTransactionScopeError("PostgreSQL provider is closed.");
    const owner = physicalOwners.get(executor);
    if (owner?.unknownOutcome) throw owner.unknownOutcome;
    if (owner && owner.state !== "active") throw new Error("PostgreSQL retained reservation is no longer active.");
  }

  private async transactionOnReservedSession<T>(owner: PhysicalTransactionOwner, work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.executeReservedTransaction(owner, work, false);
  }

  private async transactionOnOwnedReservedSession<T>(reserve: (options?: { signal?: AbortSignal }) => Promise<ReservedSqlLike>, work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const operation = this.operation();
    let session: ReservedSqlLike;
    try { session = await this.reserveSession(operation, reserve); }
    catch (error) { operation.dispose(); throw error; }
    const owner: PhysicalTransactionOwner = { session, lifetime: "owned", state: "active", operation };
    physicalOwners.set(session, owner);
    return this.executeReservedTransaction(owner, work, true);
  }

  private async executeReservedTransaction<T>(owner: PhysicalTransactionOwner, work: (tx: DbExecutor) => Promise<T>, release: boolean): Promise<T> {
    if (owner.unknownOutcome) throw owner.unknownOutcome;
    if (owner.state !== "active") throw new OrmTransactionScopeError("PostgreSQL retained reservation is unavailable.");
    const operation = owner.operation ?? this.operation();
    owner.operation = operation;
    const executor: DbExecutor = { query: (sql, params) => this.runQuery(owner.session, sql, params), execute: (sql, params) => this.runExecute(owner.session, sql, params) };
    const callbacks = createTransactionCallbackScope();
    owner.callbacks = callbacks;
    let committing = false, committed = false;
    let result!: T;
    let failure: unknown;
    try {
      await this.ownerCommand(owner, "BEGIN");
      await this.configureSession(owner);
      result = await this.transactionCallbacks.run(callbacks, () => this.ambient.run({ executor, session: owner.session, owner }, async () => {
        const value = await operation.wait(work(executor));
        assertTransactionCanCommit(callbacks);
        return value;
      }));
      operation.signal.throwIfAborted();
      committing = true;
      await this.ownerCommand(owner, "COMMIT");
      committed = true;
    } catch (error) {
      failure = error;
      if (committing && !isConfirmedCommitRejection(error)) {
        failure = owner.unknownOutcome = this.uncertainty(error);
      } else if (owner.unknownOutcome) {
        failure = owner.unknownOutcome;
      } else {
        try {
          if (operation.signal.aborted || owner.quarantinePromise) await this.quarantineOwner(owner);
          else {
            const cleanup = new OperationDeadline(this.cancellationTimeoutMs);
            try { await cleanup.wait(this.native(() => owner.session.unsafe("ROLLBACK"))); }
            catch { await this.quarantineOwner(owner); }
            finally { cleanup.dispose(); }
          }
        } catch (error) { failure = error; }
      }
      if (owner.unknownOutcome) notifyTransactionUncertainty(callbacks.afterRollback);
    } finally {
      operation.dispose();
      owner.operation = undefined;
    }
    let releaseError: unknown; let releaseFailed = false;
    if (release) { try { await this.releaseOwner(owner); } catch (error) { releaseFailed = true; releaseError = error; } }
    if (owner.unknownOutcome) throw owner.unknownOutcome;
    if (committed) return withoutPostgresScopeOptions(() => this.ambient.exit(() => this.transactionCallbacks.exit(async () => {
      try { await runPostCommitCallbacks(callbacks.afterCommit); }
      catch (error) {
        if (releaseFailed && error instanceof PostCommitError) throw new PostCommitError([releaseError, ...error.errors]);
        throw error;
      }
      if (releaseFailed) throw new PostCommitError([releaseError]);
      return result;
    })));
    return this.completeRollback(releaseFailed ? new AggregateError([failure, releaseError], "PostgreSQL rollback cleanup failed.") : failure, callbacks.afterRollback);
  }

  private async configureSession(owner: PhysicalTransactionOwner): Promise<void> {
    const settings = { statementTimeoutMs: "statement_timeout", lockTimeoutMs: "lock_timeout", idleInTransactionTimeoutMs: "idle_in_transaction_session_timeout", transactionTimeoutMs: "transaction_timeout" } as const;
    for (const [key, name] of Object.entries(settings)) {
      const value = this.serverTimeouts[key as keyof PostgresServerTimeouts];
      if (value === undefined) continue;
      await this.ownerCommand(owner, "SELECT set_config($1, $2, true)", [name, `${value}ms`]);
      const rows = await this.ownerCommand(owner, "SELECT setting::bigint AS value FROM pg_settings WHERE name = $1", [name]);
      if (String(rows[0]?.value) !== String(value)) throw new OrmTransactionScopeError("PostgreSQL timeout readback failed.");
    }
  }

  /** Private owned-store reservation: it never borrows the root pool after reserve. */
  private async withOwnedStoreAdmissionV1<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> {
    if (this.ambient.getStore() || this.lockedSession.getStore()) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    const reserve = this.reserveConnection;
    if (!reserve) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
    let owner: PhysicalTransactionOwner | undefined;
    let attempt: OwnedStoreAttemptV1 | undefined;
    let committed = false, rollbackCertain = false, releaseCertain = false, cleanupAborted = false, providerUnsupported = false, outcome!: T, outcomeSet = false, caught: unknown, caughtSet = false, callbackError: unknown, callbackErrorSet = false;
    try {
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const session = await reserve();
      owner = { session, lifetime: "owned", state: "active" };
      physicalOwners.set(session, owner);
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      await this.ownedStoreSql(session, "BEGIN", [], "begin", signal);
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const registryKey = ownedStoreAdvisoryLockV1(canonicalOwnedStoreRegistryLockPreimageV1());
      await this.ownedStoreSql(session, "SELECT pg_catalog.pg_advisory_xact_lock($1::pg_catalog.int8)", [registryKey], "registry-lock", signal);
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      await this.ownedStoreSql(session, "SET LOCAL search_path = pg_catalog, pg_temp", [], "search-path", signal);
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const contextResult = await this.ownedStoreSql(session, "SELECT pg_catalog.current_setting('max_identifier_length') AS max_identifier_length", [], "server-context", signal);
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const contextRows = selectOwnedStoreRows(contextResult, ["max_identifier_length"], 1);
      if (!contextRows || contextRows.length !== 1 || typeof contextRows[0]!.max_identifier_length !== "string") throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const maximum = this.ownedStoreMaximum(contextRows[0]!.max_identifier_length);
      if (maximum < 63n) { providerUnsupported = true; throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); }
      attempt = { owner, signal, phase: "registryLocked", generation: 1, poisoned: false, lockUncertainty: false, mutationFailure: false, semanticFailure: false, busy: false, pending: new Set(), createRegistryCalls: 0, applyCalls: 0, insertCalls: 0 };
      const activeAttempt = attempt;
      if (!activeAttempt) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      const registryGeneration = activeAttempt.generation;
      const registry = Object.freeze({
        get maxIdentifierLength() { return maximum; },
        inspectRegistry: () => this.ownedStoreRegistryV1(activeAttempt, registryGeneration),
        lockSecondary: (plan: OwnedStoreSecondaryLockPlanV1) => this.ownedStoreSecondaryV1(activeAttempt, plan),
      });
      try { outcome = await work(registry); outcomeSet = true; }
      catch (error) { callbackError = error; callbackErrorSet = true; }
      finally {
        activeAttempt.phase = "callbackClosed";
        activeAttempt.generation++;
        if (activeAttempt.pending.size !== 0 || activeAttempt.busy) this.ownedStoreLockUncertainty(activeAttempt);
      }
      if (callbackErrorSet) {
        const code = this.ownedStoreSafeCallbackError(callbackError);
        if (code === "ORM_OWNED_STORE_CREATE_FAILED") activeAttempt.mutationFailure = true;
        else if (code && code !== "ORM_OWNED_STORE_LOCK_UNAVAILABLE" && code !== "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED") activeAttempt.semanticFailure = true;
        throw callbackError;
      }
      if (activeAttempt.pending.size) await Promise.allSettled([...activeAttempt.pending]);
      if (activeAttempt.poisoned || activeAttempt.pending.size || this.ownedStoreAborted(signal)) {
        this.ownedStoreLockUncertainty(activeAttempt);
        throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      }
      activeAttempt.phase = "committing";
      await this.ownedStoreSql(session, "COMMIT", [], "commit", signal, activeAttempt);
      committed = true;
      if (this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    } catch (error) {
      caught = error;
      caughtSet = true;
      if (attempt?.pending.size) {
        this.ownedStoreLockUncertainty(attempt);
        await Promise.allSettled([...attempt.pending]);
      }
      cleanupAborted = this.ownedStoreAbortDuringCleanup(signal);
      if (owner && !committed) {
        try {
          if (owner.state === "active") await this.ownedStoreSql(owner.session, "ROLLBACK", [], "rollback", signal, attempt, false, true);
          rollbackCertain = true;
          cleanupAborted ||= this.ownedStoreAbortDuringCleanup(signal);
        } catch { /* final outcome remains closed */ }
      }
    } finally {
      if (owner) {
        try {
          await this.releaseOwner(owner);
          releaseCertain = true;
          cleanupAborted ||= this.ownedStoreAbortDuringCleanup(signal);
        } catch { /* final outcome remains closed */ }
      }
    }
    if (caughtSet) {
      const callbackCode = callbackErrorSet && caught === callbackError ? this.ownedStoreSafeCallbackError(caught) : undefined;
      if (cleanupAborted || attempt?.lockUncertainty || !rollbackCertain || !releaseCertain) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      if (providerUnsupported && rollbackCertain && releaseCertain) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
      if (attempt?.mutationFailure) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
      if (callbackCode && rollbackCertain && releaseCertain) throw failure(callbackCode);
      throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
    if (!committed || !releaseCertain || !outcomeSet || this.ownedStoreAborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    return outcome;
  }

  private async ownedStoreSql(session: ReservedSqlLike, sql: string, params: readonly unknown[], operation: string, signal: AbortSignal | undefined, attempt?: OwnedStoreAttemptV1, mutation = false, cleanup = false): Promise<BunSqlResult> {
    if (!cleanup && this.ownedStoreAborted(signal)) {
      if (attempt) this.ownedStoreLockUncertainty(attempt);
      throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
    try { this.traceOwnedStore(operation); }
    catch {
      if (attempt) mutation ? this.ownedStoreMutationFailure(attempt) : this.ownedStoreLockUncertainty(attempt);
      throw failure(mutation ? "ORM_OWNED_STORE_CREATE_FAILED" : "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
    if (!cleanup && this.ownedStoreAborted(signal)) {
      if (attempt) this.ownedStoreLockUncertainty(attempt);
      throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
    try { return await session.unsafe(sql, params); }
    catch {
      if (attempt) mutation ? this.ownedStoreMutationFailure(attempt) : this.ownedStoreLockUncertainty(attempt);
      throw failure(mutation ? "ORM_OWNED_STORE_CREATE_FAILED" : "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
  }

  private ownedStoreLockUncertainty(attempt: OwnedStoreAttemptV1): void {
    attempt.poisoned = true;
    attempt.lockUncertainty = true;
  }

  private ownedStoreMutationFailure(attempt: OwnedStoreAttemptV1): void {
    attempt.poisoned = true;
    attempt.mutationFailure = true;
  }

  private ownedStoreAbortDuringCleanup(signal: AbortSignal | undefined): boolean {
    try { return this.ownedStoreAborted(signal); }
    catch { return true; }
  }

  private ownedStoreMaximum(value: unknown): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    try { return BigInt(value); } catch { throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
  }

  /** Private wire boundary for the presently implemented small SELECTs only. */
  private ownedStoreAborted(signal: AbortSignal | undefined): boolean {
    if (!signal) return false;
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (!getter) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    try { return getter.call(signal); } catch { throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
  }

  private ownedStoreSafeCallbackError(error: unknown): OrmOwnedStoreAdmissionError["code"] | undefined {
    if (error === null || typeof error !== "object" || types.isProxy(error) || Object.getPrototypeOf(error) !== OrmOwnedStoreAdmissionError.prototype || Object.hasOwn(error, "cause")) return undefined;
    const code = Object.getOwnPropertyDescriptor(error, "code"), message = Object.getOwnPropertyDescriptor(error, "message");
    const known = ["ORM_OWNED_STORE_PROVIDER_UNSUPPORTED", "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "ORM_OWNED_STORE_IDENTITY_MISSING", "ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_OWNERSHIP_CONFLICT", "ORM_OWNED_STORE_DRIFT", "ORM_OWNED_STORE_CREATE_FAILED"];
    if (!code || !("value" in code) || typeof code.value !== "string" || !message || !("value" in message) || code.value !== message.value || !known.includes(code.value)) return undefined;
    return code.value as OrmOwnedStoreAdmissionError["code"];
  }

  /** Projection follows in the next C2 chunk; no partial snapshot is admitted. */
  private async ownedStoreRegistryV1(attempt: OwnedStoreAttemptV1, generation: number): Promise<OwnedStoreRegistrySnapshotV1> {
    if (attempt.phase !== "registryLocked" || attempt.generation !== generation || attempt.busy) { if (attempt.phase !== "callbackClosed" && attempt.phase !== "released" && attempt.phase !== "committing") this.ownedStoreLockUncertainty(attempt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
    attempt.busy = true;
    const pending = (async () => {
      try {
        const snapshot = await this.catalogReader(attempt).readRegistry();
        if (attempt.phase !== "registryLocked" || attempt.generation !== generation) {
          attempt.poisoned = true;
          throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
        }
        return snapshot;
      }
      finally { attempt.busy = false; }
    })();
    attempt.pending.add(pending);
    try { return await pending; }
    catch (error) { attempt.poisoned = true; throw error; }
    finally { attempt.pending.delete(pending); }
  }

  private async ownedStoreSecondaryV1(attempt: OwnedStoreAttemptV1, plan: OwnedStoreSecondaryLockPlanV1): Promise<SecondaryLockedOwnedStoreSessionV1> {
    if (attempt.phase !== "registryLocked" || attempt.busy) {
      if (attempt.phase !== "callbackClosed" && attempt.phase !== "released" && attempt.phase !== "committing") this.ownedStoreLockUncertainty(attempt);
      throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    }
    const generation = attempt.generation;
    const pending = (async () => {
      attempt.busy = true;
      try {
        for (const entry of [...plan.stores, ...plan.scopes]) {
          await this.ownedStoreSql(attempt.owner.session, "SELECT pg_catalog.pg_advisory_xact_lock($1::pg_catalog.int8)", [entry.key], entry.kind === "store" ? "store-lock" : "scope-lock", attempt.signal, attempt);
          if (this.ownedStoreAborted(attempt.signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
        }
        if (attempt.phase !== "registryLocked" || attempt.generation !== generation) { this.ownedStoreLockUncertainty(attempt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
        attempt.phase = "secondaryLocked";
        return Object.freeze({
          inspectCatalog: (scopes: readonly OrmCatalogScopeV1[]) => this.ownedStoreSecondaryOperation(attempt, generation, async () => this.catalogReader(attempt).readCatalog(scopes)),
          createRegistryV1: () => this.ownedStoreCreateRegistryV1(attempt, generation),
          applyCreateOperations: (operations: readonly OwnedStoreCreateOperationV1[]) => this.ownedStoreApplyCreateOperationsV1(attempt, generation, operations),
          insertIdentities: (rows: readonly OwnedStoreIdentityInsertV1[]) => this.ownedStoreInsertIdentitiesV1(attempt, generation, rows),
          inspectRegistry: () => this.ownedStoreSecondaryOperation(attempt, generation, async () => this.catalogReader(attempt).readRegistry()),
        });
      } catch (error) { attempt.poisoned = true; throw error; }
      finally { attempt.busy = false; }
    })();
    attempt.pending.add(pending);
    try { return await pending; }
    finally { attempt.pending.delete(pending); }
  }

  /**
   * Catalogue reads deliberately stay on the reservation which owns the
   * admission locks.  Scope admission is repeated here rather than trusting a
   * caller-owned array: this boundary must not invoke accessors or coerce
   * values before the SQL fence.
   */
  private catalogReader(attempt: OwnedStoreAttemptV1): OwnedStoreCatalogReader {
    return new OwnedStoreCatalogReader({
      query: (sql, params, operation) => this.ownedStoreSql(attempt.owner.session, sql, params, operation, attempt.signal, attempt),
      assertActive: () => { if (this.ownedStoreAborted(attempt.signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); },
      unavailable: (): never => { this.ownedStoreLockUncertainty(attempt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); },
      drift: (): never => { attempt.semanticFailure = true; throw failure("ORM_OWNED_STORE_DRIFT"); },
    });
  }

  private async ownedStoreSecondaryOperation<T>(attempt: OwnedStoreAttemptV1, generation: number, work: () => Promise<T>): Promise<T> {
    if (attempt.phase !== "secondaryLocked" || attempt.generation !== generation || attempt.busy) { if (attempt.phase !== "callbackClosed" && attempt.phase !== "released" && attempt.phase !== "committing") this.ownedStoreLockUncertainty(attempt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
    attempt.busy = true;
    const pending = work(); attempt.pending.add(pending);
    try { const result = await pending; if (this.ownedStoreAborted(attempt.signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); return result; }
    catch (error) { attempt.poisoned = true; throw error; }
    finally { attempt.pending.delete(pending); attempt.busy = false; }
  }

  private async ownedStoreMutation<T>(attempt: OwnedStoreAttemptV1, generation: number, counter: "createRegistryCalls" | "applyCalls" | "insertCalls", work: () => Promise<T>): Promise<T> {
    return this.ownedStoreSecondaryOperation(attempt, generation, async () => {
      attempt[counter]++;
      if (attempt[counter] !== 1) { this.ownedStoreLockUncertainty(attempt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
      try { return await work(); }
      catch {
        this.ownedStoreMutationFailure(attempt);
        throw failure("ORM_OWNED_STORE_CREATE_FAILED");
      }
    });
  }

  private async ownedStoreCreateRegistryV1(attempt: OwnedStoreAttemptV1, generation: number): Promise<void> {
    return this.ownedStoreMutation(attempt, generation, "createRegistryCalls", async () => {
      await this.ownedStoreSql(
        attempt.owner.session,
        'CREATE TABLE "public"."__osnova_orm_owned_stores_v1" ("store_key" pg_catalog.text NOT NULL, "contract" pg_catalog.text NOT NULL, "format_version" pg_catalog.int8 NOT NULL, "owned_schema" pg_catalog.text NOT NULL, "table_prefix" pg_catalog.text NOT NULL, "owned_scope_hash" pg_catalog.text NOT NULL, "model_hash" pg_catalog.text NOT NULL, "created_at" pg_catalog.timestamptz NOT NULL, CONSTRAINT "__osnova_orm_owned_stores_v1_pkey" PRIMARY KEY ("store_key"))',
        [],
        "registry-create",
        attempt.signal,
        attempt,
        true,
      );
    });
  }

  private async ownedStoreApplyCreateOperationsV1(attempt: OwnedStoreAttemptV1, generation: number, operations: readonly OwnedStoreCreateOperationV1[]): Promise<void> {
    return this.ownedStoreMutation(attempt, generation, "applyCalls", async () => {
      for (const operation of operations) {
        const rendered = this.ownedStoreRenderCreateOperationV1(operation);
        await this.ownedStoreSql(attempt.owner.session, rendered.sql, [], rendered.trace, attempt.signal, attempt, true);
      }
    });
  }

  private ownedStoreRenderCreateOperationV1(operation: unknown): { readonly sql: string; readonly trace: "schema-create" | "table-create" | "foreign-key-create" | "index-create" } {
    if (operation === null || typeof operation !== "object" || types.isProxy(operation)) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
    const candidate = operation as { readonly kind?: unknown; readonly schema?: unknown; readonly table?: unknown; readonly foreignKey?: unknown; readonly index?: unknown };
    switch (candidate.kind) {
      case "createSchema":
        if (typeof candidate.schema !== "string") throw failure("ORM_OWNED_STORE_CREATE_FAILED");
        return Object.freeze({ sql: renderSafeAdditivePostgres({ kind: "createSchema", schema: candidate.schema }), trace: "schema-create" as const });
      case "createTable":
        if (candidate.table === undefined) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
        return Object.freeze({ sql: renderSafeAdditivePostgres({ kind: "createTable", table: candidate.table as ExpectedTable }), trace: "table-create" as const });
      case "addForeignKey":
        if (candidate.table === undefined || candidate.foreignKey === undefined) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
        return Object.freeze({ sql: renderSafeAdditivePostgres({ kind: "addForeignKey", table: candidate.table as ExpectedTable, foreignKey: candidate.foreignKey as ExpectedTable["foreignKeys"][number] }), trace: "foreign-key-create" as const });
      case "createIndex":
        if (candidate.table === undefined || candidate.index === undefined) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
        return Object.freeze({ sql: renderSafeAdditivePostgres({ kind: "createIndex", table: candidate.table as ExpectedTable, index: candidate.index as ExpectedTable["indexes"][number] }), trace: "index-create" as const });
      default:
        throw failure("ORM_OWNED_STORE_CREATE_FAILED");
    }
  }

  private async ownedStoreInsertIdentitiesV1(attempt: OwnedStoreAttemptV1, generation: number, rows: readonly OwnedStoreIdentityInsertV1[]): Promise<void> {
    return this.ownedStoreMutation(attempt, generation, "insertCalls", async () => {
      for (const row of rows) {
        const result = await this.ownedStoreSql(
          attempt.owner.session,
          'INSERT INTO "public"."__osnova_orm_owned_stores_v1" ("store_key","contract","format_version","owned_schema","table_prefix","owned_scope_hash","model_hash","created_at") VALUES($1,$2,$3::pg_catalog.int8,$4,$5,$6,$7,pg_catalog.clock_timestamp())',
          [row.storeKey, row.contract, row.formatVersion, row.ownedSchema, row.tablePrefix, row.ownedScopeHash, row.modelHash],
          "identity-insert",
          attempt.signal,
          attempt,
          true,
        );
        if (!this.ownedStoreExactlyOneAffectedRow(result)) throw failure("ORM_OWNED_STORE_CREATE_FAILED");
      }
    });
  }

  private ownedStoreExactlyOneAffectedRow(result: BunSqlResult): boolean {
    try {
      if (!Array.isArray(result) || types.isProxy(result)) return false;
      const authority = (name: "affectedRows" | "count", nullUnavailable: boolean): "unavailable" | "one" | "invalid" => {
        const descriptor = Object.getOwnPropertyDescriptor(result, name);
        if (!descriptor) return "unavailable";
        if (!("value" in descriptor)) return "invalid";
        if (nullUnavailable && descriptor.value === null) return "unavailable";
        return typeof descriptor.value === "number" && Number.isSafeInteger(descriptor.value) && descriptor.value === 1 ? "one" : "invalid";
      };
      const affectedRows = authority("affectedRows", true), count = authority("count", false);
      if (affectedRows === "invalid" || count === "invalid") return false;
      return affectedRows === "one" || count === "one";
    } catch { return false; }
  }

  private uncertainty(cause?: unknown, phase: "commit" | "cancellation" = "commit"): TransactionOutcomeUnknownError {
    const error = new TransactionOutcomeUnknownError(cause, phase); this.uncertainErrors.add(error); return error;
  }

  private closeOwner(owner: PhysicalTransactionOwner): Promise<void> {
    this.validateWorkerAdmissions = true;
    owner.closePromise ??= this.native(async () => {
      if (!owner.session.close) throw new OrmTransactionScopeError("PostgreSQL scoped close is unavailable.");
      await owner.session.close({ timeout: 0 });
    }, true);
    return owner.closePromise;
  }

  private quarantineOwner(owner: PhysicalTransactionOwner): Promise<void> {
    if (owner.quarantinePromise) return owner.quarantinePromise;
    if (owner.state !== "active" || physicalOwners.get(owner.session) !== owner) return Promise.reject(new OrmTransactionScopeError("PostgreSQL cancellation owner expired."));
    const callbacks = this.transactionCallbacks.getStore() ?? owner.callbacks;
    if (callbacks) markTransactionRollbackOnly(callbacks, new OrmTransactionScopeError("ORM transaction was quarantined."));
    owner.state = "quarantining";
    const start = performance.now();
    this.activeCancellations += 1;
    owner.quarantinePromise = (async () => {
      const deadline = new OperationDeadline(this.cancellationTimeoutMs, this.closing.signal);
      try {
        if (this.activeCancellations > this.maxPendingOperations) throw new OrmTransactionScopeError("PostgreSQL cancellation admission limit reached.");
        if (this.cancellationMode === "server" && owner.backend) {
          await this.cancelThroughServer(owner, deadline);
        } else {
          try { await deadline.wait(this.closeOwner(owner)); }
          catch { deadline.signal.throwIfAborted(); /* Server proof decides even when close rejects. */ }
          if (!owner.backend) throw new OrmTransactionScopeError("PostgreSQL backend identity is unavailable for cancellation proof.");
          let delay = 25;
          for (;;) {
            try { if (await deadline.wait(this.backendAbsent(owner.backend))) break; }
            catch { deadline.signal.throwIfAborted(); }
            await deadline.wait(new Promise<void>((resolve) => setTimeout(resolve, delay)));
            delay = Math.min(delay * 2, 250);
          }
          owner.backendAbsenceAcknowledged = true;
        }
        owner.state = "quarantined";
        this.event("cancellation", start);
      } catch (error) {
        owner.unknownOutcome ??= this.uncertainty(error, "cancellation");
        // Never let failed control admission/replies leave this owner usable.
        // Native cleanup retains its capacity slot if the driver does not settle.
        void this.closeOwner(owner).catch(() => {});
        this.unconfirmedCancellations += 1;
        if (callbacks) notifyTransactionUncertainty(callbacks.afterRollback);
        this.event("cancellation", start, owner.unknownOutcome);
        throw owner.unknownOutcome;
      } finally { deadline.dispose(); this.activeCancellations -= 1; }
    })();
    void owner.quarantinePromise.catch(() => {});
    return owner.quarantinePromise;
  }

  private async cancelThroughServer(owner: PhysicalTransactionOwner, deadline: OperationDeadline): Promise<void> {
    const identity = owner.backend!;
    const args = [identity.pid, identity.datid, identity.backendStart, identity.postmasterStart, identity.address, identity.port];
    const rollback = async () => {
      // No further owner dispatch can pass the synchronous quarantine fence.
      await deadline.wait(Promise.allSettled([...(owner.pending ?? [])]));
      await deadline.wait(this.native(() => { deadline.signal.throwIfAborted(); return owner.session.unsafe("ROLLBACK"); }, true));
      const current = await this.readBackendIdentity(owner.session, deadline);
      if (Object.entries(identity).some(([key, value]) => current[key as keyof BackendIdentity] !== value)) throw new OrmTransactionScopeError("PostgreSQL rollback backend identity changed.");
      owner.rollbackAcknowledged = true;
    };
    if (!owner.pending?.size) { await rollback(); return; }
    await this.withCancellationConnection(deadline, async (control) => {
      let lastSignaledStart: string | undefined;
      while (owner.pending?.size) {
        const rows = await deadline.wait(this.native(() => { deadline.signal.throwIfAborted(); return control.unsafe(CANCEL_INSPECT_SQL, args); }, true));
        const queryStart = rows[0]?.query_start;
        if (rows.length > 1 || (rows.length === 1 && (typeof queryStart !== "string" || !/^-?(?:0|[1-9][0-9]{0,18})\.[0-9]{6}$/u.test(queryStart)))) throw new OrmTransactionScopeError("PostgreSQL cancellation query identity is unavailable.");
        if (owner.pending.size && typeof queryStart === "string" && queryStart !== lastSignaledStart) {
          // Inspect and signal both require the captured backend/server identity.
          // The retained owner fence prevents dispatch/reuse while this command
          // is in flight. This SQL API is not the PID+secret CancelRequest API:
          // OS PID reuse between the server-side check and signal is a limit.
          const response = await deadline.wait(this.native(() => {
            deadline.signal.throwIfAborted();
            if (!owner.pending?.size) return Promise.resolve([] as BunSqlResult);
            return control.unsafe(CANCEL_SIGNAL_SQL, [...args, queryStart]);
          }, true));
          if (response.length > 1 || (response.length === 1 && typeof response[0]?.signaled !== "boolean")) throw new OrmTransactionScopeError("PostgreSQL cancellation response is invalid.");
          if (response[0]?.signaled === true) lastSignaledStart = queryStart;
        }
        if (owner.pending.size) await deadline.wait(new Promise<void>((resolve) => setTimeout(resolve, 5)));
      }
      // A successful signal is insufficient. Native settlement and the actual
      // ROLLBACK response must precede control release and worker reuse.
      await rollback();
    });
  }

  private async withCancellationConnection<T>(deadline: OperationDeadline, work: (session: ReservedSqlLike) => Promise<T>): Promise<T> {
    deadline.signal.throwIfAborted();
    if (this.closed) throw new OrmTransactionScopeError("PostgreSQL provider is closed.");
    this.controlSql ??= new SQL(this.controlConfig as never);
    const control = this.controlSql;
    let session: ReservedSqlLike | undefined;
    let complete = false;
    try {
      session = await this.reserveSession(deadline, control.reserve.bind(control), true);
      deadline.signal.throwIfAborted();
      const result = await work(session);
      complete = true;
      return result;
    } finally {
      if (session) {
        const retained = session;
        const cleanup = complete ? this.native(async () => { await retained.release(); }, true) : this.retireReservation(retained, true);
        // A failed or lost response closes the control slot before any release;
        // a timeout only stops waiting, and never dispatches a late command.
        await deadline.wait(cleanup);
      }
    }
  }

  private async unlockOwner(owner: PhysicalTransactionOwner, keys: readonly (number | bigint)[]): Promise<void> {
    const deadline = new OperationDeadline(this.cancellationTimeoutMs);
    try {
      for (const key of keys) await deadline.wait(this.native(() => { deadline.signal.throwIfAborted(); return owner.session.unsafe("SELECT pg_advisory_unlock($1)", [key]); }, true));
    } catch (error) {
      // A session-level lock must not leak to the next borrower if unlock fails.
      await deadline.wait(this.closeOwner(owner));
      throw error;
    } finally { deadline.dispose(); }
  }

  private async releaseOwner(owner: PhysicalTransactionOwner): Promise<void> {
    if (owner.releasePromise) return owner.releasePromise;
    owner.releasePromise = (async () => {
      const deadline = new OperationDeadline(this.cancellationTimeoutMs);
      try {
        if (owner.quarantinePromise) { try { await deadline.wait(owner.quarantinePromise); } catch { /* preserve owner uncertainty below */ } }
        owner.state = "released";
        if (owner.unknownOutcome || (owner.closePromise && !owner.backendAbsenceAcknowledged)) await deadline.wait(this.closeOwner(owner));
        await deadline.wait(this.native(async () => { await owner.session.release(); }, true));
      } catch (error) {
        // Never return an unclosed, potentially busy connection to the pool.
        if (owner.unknownOutcome) throw owner.unknownOutcome;
        throw error;
      } finally { deadline.dispose(); }
      if (owner.unknownOutcome) throw owner.unknownOutcome;
    })();
    return owner.releasePromise;
  }

  private async readBackendIdentity(session: SqlLike, cleanup?: OperationDeadline): Promise<BackendIdentity> {
    const owner = physicalOwners.get(session);
    const work = () => session.unsafe("SELECT pg_backend_pid()::text AS pid, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS datid, extract(epoch FROM backend_start)::numeric(20,6)::text AS backend_start, extract(epoch FROM pg_postmaster_start_time())::numeric(20,6)::text AS postmaster_start, coalesce(host(inet_server_addr()),'') AS address, coalesce(inet_server_port()::text,'') AS port FROM pg_stat_activity WHERE pid = pg_backend_pid()");
    const pending = owner ? this.ownerNative(owner, () => { cleanup?.signal.throwIfAborted(); return work(); }, cleanup !== undefined) : this.native(work);
    const deadline = cleanup ?? owner?.operation;
    const rows = deadline ? await deadline.wait(pending) : await pending;
    const row = rows[0];
    const identity = row && this.parseBackendIdentity(row);
    if (!identity) throw new Error("PostgreSQL backend identity is unavailable.");
    return identity;
  }

  private parseBackendIdentity(row: Row): BackendIdentity | undefined {
    if (typeof row.pid !== "string" || typeof row.datid !== "string" || typeof row.backend_start !== "string" || typeof row.postmaster_start !== "string" || typeof row.address !== "string" || typeof row.port !== "string") return undefined;
    const identity = { pid: row.pid, datid: row.datid, backendStart: row.backend_start, postmasterStart: row.postmaster_start, address: row.address, port: row.port };
    const decimal = (value: string, max: bigint) => /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= max;
    const epoch = (value: string) => /^-?(?:0|[1-9][0-9]{0,18})\.[0-9]{6}$/u.test(value);
    const ip = (value: string) => isIP(value) !== 0;
    if (!decimal(identity.pid, 2147483647n) || !decimal(identity.datid, 4294967295n) || !epoch(identity.backendStart) || !epoch(identity.postmasterStart) || !ip(identity.address) || !decimal(identity.port, 65535n)) return undefined;
    return identity;
  }

  private async backendAbsent(identity: BackendIdentity): Promise<boolean> {
    const rows = await this.ambient.exit(() => this.transactionCallbacks.exit(() => withoutProviderDispatchObserver(() => this.native(() => this.sql.unsafe("SELECT a.pid::text AS pid, a.datid::text AS datid, extract(epoch FROM a.backend_start)::numeric(20,6)::text AS backend_start, extract(epoch FROM pg_postmaster_start_time())::numeric(20,6)::text AS postmaster_start, coalesce(host(inet_server_addr()),'') AS address, coalesce(inet_server_port()::text,'') AS port FROM (SELECT 1) root_probe LEFT JOIN pg_stat_activity a ON a.pid = $1::int", [identity.pid])))));
    const row = rows[0];
    if (!row || typeof row.postmaster_start !== "string" || typeof row.address !== "string" || typeof row.port !== "string" || row.postmaster_start !== identity.postmasterStart || row.address !== identity.address || row.port !== identity.port) return false;
    if (row.pid === null && row.datid === null && row.backend_start === null) return true;
    const current = this.parseBackendIdentity(row);
    if (!current || current.postmasterStart !== identity.postmasterStart || current.address !== identity.address || current.port !== identity.port) return false;
    return current.pid === identity.pid && (current.datid !== identity.datid || current.backendStart !== identity.backendStart);
  }

  private async runTransactionScope<T>(
    executor: DbExecutor,
    parent: TransactionCallbackScope,
    work: (tx: DbExecutor) => Promise<T>,
  ): Promise<T> {
    const child = beginChildTransactionScope(parent);
    const savepoint = this.nextSavepoint();
    let created = false;
    try {
      try {
        await executor.execute(`SAVEPOINT ${savepoint}`, []);
        created = true;
      } catch (error) {
        markTransactionRollbackOnly(parent, error);
        throw error;
      }

      try {
        const result = await this.transactionCallbacks.run(child.callbacks, () => work(executor));
        assertTransactionCanCommit(child.callbacks);
        await executor.execute(`RELEASE SAVEPOINT ${savepoint}`, []);
        mergeTransactionScopeCallbacks(parent, child.callbacks);
        return result;
      } catch (error) {
        const unknown = this.ambient.getStore()?.owner?.unknownOutcome;
        if (unknown) { notifyTransactionUncertainty(child.callbacks.afterRollback); throw unknown; }
        const failure = created
          ? await this.rollbackTransactionScope(executor, savepoint, parent, error)
          : error;
        return runRollbackCallbacks(child.callbacks.afterRollback, failure);
      }
    } finally {
      endChildTransactionScope(parent, child.ownership);
    }
  }

  private async rollbackTransactionScope(
    executor: DbExecutor,
    savepoint: string,
    parent: TransactionCallbackScope,
    cause: unknown,
  ): Promise<unknown> {
    if (this.ambient.getStore()?.owner?.rollbackAcknowledged) {
      markTransactionRollbackOnly(parent, cause);
      return cause;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await executor.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`, []);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await executor.execute(`RELEASE SAVEPOINT ${savepoint}`, []);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0) {
      return cause;
    }
    const failure = new AggregateError(
      [cause, ...cleanupErrors],
      "PostgreSQL transaction scope failed and its savepoint could not be cleaned up.",
    );
    markTransactionRollbackOnly(parent, failure);
    return failure;
  }

  private nextSavepoint(): string {
    this.nextTransactionScopeId = this.nextTransactionScopeId >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.nextTransactionScopeId + 1;
    return this.dialect.quoteId(`osnova_scope_${this.nextTransactionScopeId}`);
  }

  private traceSql(sql: string, params: readonly SqlParam[]): void {
    if (!this.onSql) {
      return;
    }
    this.onSql(sql, this.redactSqlParams ? redactTraceValues(params) : params);
  }

  private traceSchemaAdmission(operation: string): void {
    this.onSql?.(`osnova.schema-admission:${operation}`, []);
  }

  private traceOwnedStore(operation: string): void {
    this.onSql?.(`osnova.owned-store:${operation}`, []);
  }

  private get reserveConnection(): ((options?: { signal?: AbortSignal }) => Promise<ReservedSqlLike>) | undefined {
    const reserve = (this.sql as unknown as { reserve?: (options?: { signal?: AbortSignal }) => Promise<ReservedSqlLike> }).reserve;
    return typeof reserve === "function" ? reserve.bind(this.sql) : undefined;
  }

  private emitWarning(warning: DatabaseProviderDiagnostic): void {
    if (this.migrationLockFallbackWarned) {
      return;
    }
    this.migrationLockFallbackWarned = true;
    if (this.onWarning) {
      this.onWarning(warning);
      return;
    }
    console.warn(`[orm:postgres] ${warning.message}`);
  }
}

/** Значение-соединение PostgreSQL для `ormModule({ provider: postgres(...) })`. */
export function postgres(options: PostgresProviderOptions = {}): PostgresProvider {
  return new PostgresProvider(options);
}
