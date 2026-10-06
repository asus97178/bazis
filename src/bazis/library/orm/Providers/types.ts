import type { ColumnType, EntityModel, IndexModel, PropertyModel } from "../Metadata/types";
import type { IntrospectedSchema } from "../Schema/introspection";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";

/**
 * A value that can be bound as a query parameter. A wide union, because
 * PostgreSQL accepts native `boolean`, `Date` and `jsonb` objects. A concrete
 * provider receives values after `SqlDialect.encode`.
 */
export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | Date
  | readonly unknown[]
  | Record<string, unknown>;

/** A query result row. */
export type Row = Record<string, unknown>;

/**
 * Minimal SQL executor. The provider implements it directly (outside a
 * transaction), and inside a transaction `transaction()` passes a scoped
 * executor; this is needed for pooled providers (PostgreSQL), where a
 * transaction is bound to a reserved connection.
 */
export interface DbExecutor {
  query(sql: string, params: readonly SqlParam[]): Promise<Row[]>;
  execute(sql: string, params: readonly SqlParam[]): Promise<ExecuteResult>;
}

/** Work tied to completion of the surrounding top-level transaction. */
export type TransactionCallback = () => Promise<void> | void;

/** Work that must run only after the surrounding top-level transaction commits. */
export type AfterCommitCallback = TransactionCallback;

/** Row-level lock requested by a SELECT query. */
export type RowLockMode = "update";

/** Result of a modifying command. */
export interface ExecuteResult {
  /** Number of affected rows. */
  readonly changes: number;
  /** Id of the last inserted row (for identity keys). */
  readonly lastInsertId: number | bigint;
}

/** SQL provider limits that affect the size of batch commands. */
export interface DatabaseProviderLimits {
  /** Maximum number of bound parameters in one SQL command. */
  readonly maxParametersPerCommand: number;
  /** Optional upper limit of rows in one multi-row INSERT. */
  readonly maxRowsPerInsert?: number;
  /** Upper limit of values in one `WHERE ... IN (...)`. */
  readonly maxParametersPerInList?: number;
}

/** Provider diagnostic signal for the health check and startup warnings. */
export interface DatabaseProviderDiagnostic {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
}

/** PostgreSQL-only capability: locks, transaction, DDL and catalog reads share one reserved session. */
export interface SchemaAdmissionCapabilityV1 {
  readonly version: 1;
  readonly provider: "postgres";
  readonly distributedLock: true;
  readonly transactionalDdl: true;
  readonly exactIntrospection: true;
  withSchemaAdmission<T>(schemas: readonly string[], work: (scope: SchemaAdmissionScope) => Promise<T>): Promise<T>;
}
export interface SchemaAdmissionScope extends DbExecutor { introspectExpected(expected: OrmExpectedSchema): Promise<IntrospectedSchema> }

/**
 * SQL dialect: everything that differs between DBMSs (quoting, parameter
 * placeholders, column types, auto-increment). A new provider can be added by
 * implementing a dialect + a transport.
 */
export interface SqlDialect {
  readonly name: string;
  /** Quotes one identifier; a dot inside the name is kept literally. */
  quoteId(name: string): string;
  /** Qualified table name, taking `EntityModel.schema` into account. */
  qualifyTable(model: EntityModel): string;
  /** PostgreSQL parameter placeholder by index (0-based): `$1`, `$2`, …. */
  parameter(index: number): string;
  /** Column type in DDL. */
  columnType(type: ColumnType): string;
  /** Whether `INSERT ... RETURNING` is supported. */
  readonly supportsReturning: boolean;
  /** Encodes a property value into a query parameter for this DBMS. */
  encode(value: unknown, type: ColumnType): SqlParam;
  /** Decodes a column value into a property value. */
  decode(value: unknown, type: ColumnType): unknown;
  /** SQL suffix for a row-locking SELECT; empty when the dialect has no such clause. */
  rowLockClause(mode: RowLockMode): string;
  /** DDL that creates the table (`CREATE TABLE IF NOT EXISTS ...`) with FK constraints. */
  createTableSql(model: EntityModel, foreignKeys: readonly ForeignKeyConstraint[]): string;
  /** DDL that creates all indexes of the entity. */
  createIndexSql(model: EntityModel): readonly string[];
  /** DDL that creates one index. */
  createIndexSqlOne(model: EntityModel, index: IndexModel): string;
  /** DDL that adds a column (`ALTER TABLE ... ADD COLUMN ...`). */
  addColumnSql(model: EntityModel, property: PropertyModel, foreignKey?: ForeignKeyConstraint): string;
  /**
   * DDL that drops a column (`ALTER TABLE ... DROP COLUMN ...`). A destructive
   * operation: the auto-migration never calls it (see `SchemaDiffer`); only
   * explicit schema management scenarios do.
   */
  dropColumnSql(model: EntityModel, columnName: string): string;
}

/** FK constraint description for DDL (already resolved into column/table names). */
export interface ForeignKeyConstraint {
  readonly column: string;
  readonly columns?: readonly string[];
  readonly name?: string;
  readonly referencedTable: string;
  readonly referencedColumn: string;
  readonly referencedColumns?: readonly string[];
  readonly onDelete?: "noAction" | "restrict" | "cascade" | "setNull";
  readonly onUpdate?: "noAction" | "restrict" | "cascade" | "setNull";
  /** Physical type of the FK column when it is more precise than the general `PropertyModel.type` (for example native PostgreSQL UUID). */
  readonly columnType?: ColumnType | "uuid";
}

/**
 * Transport to a concrete DBMS. The methods are async for providers with
 * network I/O (PostgreSQL). Only parameterized queries are used everywhere.
 */
export interface DatabaseProvider {
  readonly name: string;
  readonly dialect: SqlDialect;
  readonly schemaAdmissionCapability?: SchemaAdmissionCapabilityV1;
  /** Batch command limits of the concrete provider. */
  readonly limits?: DatabaseProviderLimits;
  /** Diagnostics of provider capabilities (for example a degraded migration lock). */
  diagnostics?(): readonly DatabaseProviderDiagnostic[];
  /** SELECT: returns rows. */
  query(sql: string, params: readonly SqlParam[]): Promise<Row[]>;
  /** INSERT/UPDATE/DELETE/DDL: returns the number of changes and lastInsertId. */
  execute(sql: string, params: readonly SqlParam[]): Promise<ExecuteResult>;
  /**
   * Runs work in a transaction (BEGIN/COMMIT, ROLLBACK on exception).
   * The callback gets an executor bound to the transaction's connection;
   * all queries inside must go through it.
   */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>;
  /**
   * Runs an atomic transaction scope.
   *
   * Outside an ambient transaction this is equivalent to {@link transaction}.
   * Inside an ambient transaction a capable provider creates a real database
   * savepoint, so a caught inner failure cannot leak partial writes into the
   * outer commit. The capability is optional for third-party providers; code
   * that requires composable atomic work must fail fast when it is absent.
   */
  transactionScope?<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>;
  /** True only in the current async flow while it is joined to an ambient transaction. */
  isTransactionActive?(): boolean;
  /**
   * Registers work after the ambient top-level commit. Outside a transaction
   * the callback runs immediately. Useful for notifications that must never
   * expose uncommitted state.
   */
  afterCommit?(callback: AfterCommitCallback): Promise<void> | void;
  /**
   * Registers compensation after rollback of the ambient top-level
   * transaction. Intended for restoring in-memory ORM state that was updated
   * while SQL was executing. Outside a transaction the callback is ignored.
   */
  afterRollback?(callback: TransactionCallback): void;
  /** Connection check for the health check. */
  ping(signal?: AbortSignal): Promise<boolean>;
  /** Introspection of the actual database schema (for the auto-migration). */
  introspect(): Promise<IntrospectedSchema>;
  /**
   * Runs `work` under a cross-process migration lock (optional).
   * PostgreSQL uses an advisory lock so that two instances starting at the
   * same time do not race to apply migrations.
   */
  withMigrationLock?<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Subscribes to an async notification channel (PostgreSQL `LISTEN`). Optional:
   * providers without push support do not implement it, and the subscriber falls
   * back to polling. `handler` is called for every incoming notification with
   * its payload.
   */
  listen?(channel: string, handler: (payload: string) => void | Promise<void>): Promise<NotificationSubscription>;
  /**
   * Sends a notification to a channel (PostgreSQL `NOTIFY` through `pg_notify`). Optional.
   * Delivered to all channel subscribers, including the sender.
   */
  notify?(channel: string, payload?: string): Promise<void>;
  close(): Promise<void>;
}

/** Active notification channel subscription; `close()` removes it. */
export interface NotificationSubscription {
  close(): Promise<void> | void;
}
