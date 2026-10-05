import type { ColumnType, EntityModel, IndexModel, PropertyModel } from "../Metadata/types";
import type { IntrospectedSchema } from "../Schema/introspection";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";

/**
 * Значение, которое можно связать как параметр запроса. Широкий union, т.к.
 * PostgreSQL принимает нативные `boolean`, `Date` и `jsonb`-объекты. Конкретный
 * провайдер получает значения уже после `SqlDialect.encode`.
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

/** Строка результата запроса. */
export type Row = Record<string, unknown>;

/**
 * Минимальный исполнитель SQL. Провайдер реализует его напрямую (вне
 * транзакции), а внутри транзакции `transaction()` передаёт scoped-executor —
 * это нужно для провайдеров с пулом соединений (PostgreSQL), где транзакция
 * привязана к зарезервированному соединению.
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

/** Результат изменяющей команды. */
export interface ExecuteResult {
  /** Число затронутых строк. */
  readonly changes: number;
  /** Идентификатор последней вставленной строки (для identity-ключей). */
  readonly lastInsertId: number | bigint;
}

/** Ограничения SQL-провайдера, влияющие на размер batch-команд. */
export interface DatabaseProviderLimits {
  /** Максимум связываемых параметров в одной SQL-команде. */
  readonly maxParametersPerCommand: number;
  /** Дополнительный верхний предел строк в одном multi-row INSERT. */
  readonly maxRowsPerInsert?: number;
  /** Верхний предел значений в одном `WHERE ... IN (...)`. */
  readonly maxParametersPerInList?: number;
}

/** Диагностический сигнал провайдера для health-check и startup warnings. */
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
 * Диалект SQL: всё, что отличается между СУБД (кавычки, плейсхолдеры
 * параметров, типы колонок, автоинкремент). Архитектура позволяет добавить
 * новый провайдер, реализовав диалект + транспорт.
 */
export interface SqlDialect {
  readonly name: string;
  /** Экранирование одного идентификатора; точка внутри имени сохраняется буквально. */
  quoteId(name: string): string;
  /** Квалифицированное имя таблицы с учётом `EntityModel.schema`. */
  qualifyTable(model: EntityModel): string;
  /** Плейсхолдер параметра PostgreSQL по индексу (0-based): `$1`, `$2`, …. */
  parameter(index: number): string;
  /** Тип колонки в DDL. */
  columnType(type: ColumnType): string;
  /** Поддерживает ли `INSERT ... RETURNING`. */
  readonly supportsReturning: boolean;
  /** Кодирует значение свойства в параметр запроса для этой СУБД. */
  encode(value: unknown, type: ColumnType): SqlParam;
  /** Декодирует значение колонки в значение свойства. */
  decode(value: unknown, type: ColumnType): unknown;
  /** SQL suffix for a row-locking SELECT; empty when the dialect has no such clause. */
  rowLockClause(mode: RowLockMode): string;
  /** DDL создания таблицы (`CREATE TABLE IF NOT EXISTS ...`) с FK-ограничениями. */
  createTableSql(model: EntityModel, foreignKeys: readonly ForeignKeyConstraint[]): string;
  /** DDL создания всех индексов сущности. */
  createIndexSql(model: EntityModel): readonly string[];
  /** DDL создания одного индекса. */
  createIndexSqlOne(model: EntityModel, index: IndexModel): string;
  /** DDL добавления колонки (`ALTER TABLE ... ADD COLUMN ...`). */
  addColumnSql(model: EntityModel, property: PropertyModel, foreignKey?: ForeignKeyConstraint): string;
  /**
   * DDL удаления колонки (`ALTER TABLE ... DROP COLUMN ...`). Деструктивная
   * операция: авто-миграция её не вызывает (см. `SchemaDiffer`) — только явные
   * сценарии управления схемой.
   */
  dropColumnSql(model: EntityModel, columnName: string): string;
}

/** Описание FK-ограничения для DDL (уже разрешённое в имена колонок/таблиц). */
export interface ForeignKeyConstraint {
  readonly column: string;
  readonly columns?: readonly string[];
  readonly name?: string;
  readonly referencedTable: string;
  readonly referencedColumn: string;
  readonly referencedColumns?: readonly string[];
  readonly onDelete?: "noAction" | "restrict" | "cascade" | "setNull";
  readonly onUpdate?: "noAction" | "restrict" | "cascade" | "setNull";
  /** Физический тип FK-колонки, когда он точнее общего `PropertyModel.type` (например native PostgreSQL UUID). */
  readonly columnType?: ColumnType | "uuid";
}

/**
 * Транспорт к конкретной СУБД. Методы асинхронны ради провайдеров с сетевым
 * I/O (PostgreSQL).
 * Везде используются только параметризованные запросы.
 */
export interface DatabaseProvider {
  readonly name: string;
  readonly dialect: SqlDialect;
  readonly schemaAdmissionCapability?: SchemaAdmissionCapabilityV1;
  /** Лимиты batch-команд конкретного провайдера. */
  readonly limits?: DatabaseProviderLimits;
  /** Диагностика capabilities провайдера (например, degraded migration lock). */
  diagnostics?(): readonly DatabaseProviderDiagnostic[];
  /** SELECT: возвращает строки. */
  query(sql: string, params: readonly SqlParam[]): Promise<Row[]>;
  /** INSERT/UPDATE/DELETE/DDL: возвращает число изменений и lastInsertId. */
  execute(sql: string, params: readonly SqlParam[]): Promise<ExecuteResult>;
  /**
   * Выполняет работу в транзакции (BEGIN/COMMIT, ROLLBACK при исключении).
   * В callback передаётся исполнитель, привязанный к соединению транзакции —
   * все запросы внутри должны идти через него.
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
  /** Проверка соединения для health-check. */
  ping(signal?: AbortSignal): Promise<boolean>;
  /** Интроспекция фактической схемы БД (для авто-миграции). */
  introspect(): Promise<IntrospectedSchema>;
  /**
   * Выполняет `work` под межпроцессной блокировкой миграций (опционально).
   * PostgreSQL использует advisory lock, чтобы два инстанса, стартующие
   * одновременно, не применяли миграции наперегонки.
   */
  withMigrationLock?<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Подписка на канал асинхронных уведомлений (PostgreSQL `LISTEN`). Опционально:
   * провайдеры без поддержки push метод не реализуют — подписчик деградирует к
   * поллингу. `handler` вызывается на каждое
   * входящее уведомление с его payload.
   */
  listen?(channel: string, handler: (payload: string) => void | Promise<void>): Promise<NotificationSubscription>;
  /**
   * Шлёт уведомление в канал (PostgreSQL `NOTIFY` через `pg_notify`). Опционально.
   * Доставляется всем подписчикам канала, включая отправителя.
   */
  notify?(channel: string, payload?: string): Promise<void>;
  close(): Promise<void>;
}

/** Активная подписка на канал уведомлений; `close()` снимает её. */
export interface NotificationSubscription {
  close(): Promise<void> | void;
}
