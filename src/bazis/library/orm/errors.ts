import type { ValidationError } from "../validation";
import type { SchemaVerificationResult } from "./Schema/ExactSchemaVerifier";
import { formatSchemaDifferences } from "./Schema/formatSchemaDifferences";

/** Base ORM error. */
export class OrmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type SchemaAdmissionErrorCode = "ORM_SCHEMA_PROVIDER_UNSUPPORTED" | "ORM_SCHEMA_LOCK_UNAVAILABLE" | "ORM_SCHEMA_LOCK_KEY_COLLISION" | "ORM_SCHEMA_ATOMICITY_UNAVAILABLE" | "ORM_SCHEMA_MODEL_INVALID" | "ORM_SCHEMA_CATALOG_UNSUPPORTED" | "ORM_SCHEMA_CREATE_FAILED" | "ORM_SCHEMA_ADDITIVE_DATA_VIOLATION" | "ORM_SCHEMA_ADDITIVE_DDL_FAILED" | "ORM_SCHEMA_MIGRATION_REQUIRED" | "ORM_SCHEMA_DRIFT" | "ORM_SCHEMA_OWNERSHIP_CONFLICT" | "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" | "ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY";
/** Safe public admission failure; deliberately contains no driver cause or SQL. */
export class SchemaAdmissionError extends OrmError {
  constructor(readonly code: SchemaAdmissionErrorCode, message: string) { super(message); }
}
/** Drift carries only deterministic safe descriptors, never catalog rows or SQL. */
export class SchemaVerificationError extends SchemaAdmissionError {
  override readonly code = "ORM_SCHEMA_DRIFT" as const;
  constructor(readonly verification: SchemaVerificationResult) {
    super("ORM_SCHEMA_DRIFT", schemaVerificationMessage("PostgreSQL schema does not match the declared model.", verification));
  }
}
/** Preflight found a change which safe startup admission is forbidden to repair. */
export class SchemaMigrationRequiredError extends SchemaAdmissionError {
  readonly verification: SchemaVerificationResult;
  constructor(verification: SchemaVerificationResult) {
    super("ORM_SCHEMA_MIGRATION_REQUIRED", schemaVerificationMessage("PostgreSQL schema change requires an explicit migration.", verification));
    this.verification = verification;
  }
}

function schemaVerificationMessage(summary: string, verification: SchemaVerificationResult): string {
  return [summary, formatSchemaDifferences(verification),
    "Check the application version and target database. Align the ORM model and database schema; apply an explicit migration if a database change is intended (with ensureCreated: add it to the module's migrations with runMigrationsOnStart: true).",
  ].filter(Boolean).join("\n");
}

export type OrmOwnedStoreAdmissionErrorCode =
  | "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"
  | "ORM_OWNED_STORE_LOCK_UNAVAILABLE"
  | "ORM_OWNED_STORE_IDENTITY_MISSING"
  | "ORM_OWNED_STORE_IDENTITY_MISMATCH"
  | "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"
  | "ORM_OWNED_STORE_DRIFT"
  | "ORM_OWNED_STORE_CREATE_FAILED";
/** Safe owned-store admission failure; never carries a driver cause or catalog data. */
export class OrmOwnedStoreAdmissionError extends OrmError {
  constructor(readonly code: OrmOwnedStoreAdmissionErrorCode, message: string) { super(message); }
}

/**
 * The database transaction committed, but one or more callbacks registered
 * through `afterCommit()` failed afterwards. `committed` is deliberately
 * explicit so callers and retry policies cannot mistake this outcome for a
 * rolled-back/transient database failure.
 */
export class PostCommitError extends OrmError {
  readonly committed = true;
  readonly errors: readonly unknown[];
  override readonly cause: AggregateError;

  constructor(errors: readonly unknown[]) {
    const count = errors.length;
    super(`Transaction committed, but ${count} afterCommit callback${count === 1 ? "" : "s"} failed.`);
    this.errors = [...errors];
    this.cause = new AggregateError(this.errors, "One or more afterCommit callbacks failed.");
  }
}

/** Safe structural check also works across package/realm boundaries. */
export function isCommittedOutcome(error: unknown): error is { readonly committed: true } {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return false;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "committed");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    // A hostile Proxy/getOwnPropertyDescriptor trap is not allowed to replace
    // the original database error while a retry policy is classifying it.
    return false;
  }
}

/** Model building (entity configuration) error. Thrown at startup. */
export class ModelBuildError extends OrmError {}

/** A `first()` query found no rows. */
export class EntityNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(`Sequence contains no elements for entity "${entityName}".`);
  }
}

/** The class is not registered as an entity in this context. */
export class EntityNotMappedError extends OrmError {
  /** `dynamic`: looked up by name through `setByName`; `plain`: a plain object, not an entity instance. */
  constructor(name: string, kind: "class" | "dynamic" | "plain" = "class") {
    super(
      kind === "dynamic"
        ? `No entity or dynamic model named "${name}" is registered in this DbContext. Register a dynamic table first: options.model.registerModel(buildDynamicModel({ name: "${name}", fields: [...] })).`
        : kind === "plain"
          ? `A plain object is not an entity class. For a dynamic table add the row through its set: db.setByName("Table").add(row).`
          : `Type "${name}" is not mapped in this DbContext. Declare a set for it in the context (this.set(${name})) or add it to entities of ormBazis, and annotate it with @Entity().`,
    );
  }
}

/** Error while applying changes (SaveChanges). */
export class DbUpdateError extends OrmError {}

/**
 * Two sibling savepoint scopes tried to use one ambient connection at once.
 * Savepoint stacks are connection-ordered, so providers reject this before
 * either sibling can issue SQL instead of allowing cross-scope rollback.
 */
export class ConcurrentTransactionScopeError extends OrmError {
  constructor() {
    super("Concurrent sibling transaction scopes on one ambient connection are not supported; await each scope sequentially.");
  }
}

/** Safe failure for a stale, closing, or unenrolled ORM transaction capability. */
export class OrmTransactionScopeError extends OrmError {
  constructor(message = "ORM transaction scope is not active for this operation.", options?: ErrorOptions) { super(message, options); }
}

/** Contexts may share transaction work only when their configured provider is the same object. */
export class OrmProviderIdentityMismatchError extends OrmError {
  constructor(contextName = "This DbContext") { super(differentProviderMessage(contextName)); }
}

export function differentProviderMessage(contextName: string): string {
  return `${contextName} uses a different database provider than the surrounding transaction scope. Contexts share one transaction only when they are created with the same provider object.`;
}

/** The provider did not return an exact safe millisecond database timestamp. */
export class OrmDatabaseTimeError extends OrmError {
  constructor() { super("ORM provider returned an invalid database time value."); }
}

/** Immediate DML is deliberately isolated from tracked state. */
export class OrmTrackedMutationConflictError extends OrmError {
  constructor(entityName?: string) {
    super(entityName === undefined
      ? "Immediate ORM mutation conflicts with tracked entities."
      : `Immediate ORM mutation conflicts with tracked entities: this context tracks "${entityName}" entities (loaded with tracking or saved through saveChanges()), which the mutation would make stale. Load them with .asNoTracking(), or run the mutation in a separate DbContext.`);
  }
}
/** Immediate DML accepts only the small, closed descriptor-safe input domain. */
export class OrmUnsafeImmediateMutationError extends OrmError {
  constructor(reason?: string) { super(reason === undefined ? "Immediate ORM mutation input is unsafe or unsupported." : `Immediate ORM mutation input is unsafe or unsupported: ${reason}.`); }
}
/** INSERT ON CONFLICT may name only an exactly declared unique target. */
export class OrmUndeclaredConflictTargetError extends OrmError {
  constructor(detail?: string) { super(detail === undefined ? "Immediate ORM mutation conflict target is not a declared unique key." : `Immediate ORM mutation conflict target is not a declared unique key: ${detail}.`); }
}

/**
 * SaveChanges hit a unique constraint (PostgreSQL SQLSTATE 23505); its changes
 * were rolled back. `constraint` and `table` come from the server when it
 * reports them. The original driver error is `cause`; its own `errno`/`code`
 * are copied so transaction-outcome classification sees the same server
 * rejection as before.
 */
export class UniqueViolationError extends DbUpdateError {
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  /**
   * The properties of the index or key that rejected the value, when a context
   * with the entity of the table made the call; otherwise empty.
   */
  properties: readonly string[] = [];
  /** `conflict` of the index: what to tell the client. */
  conflict: string | undefined;

  constructor(cause: object) {
    const field = (name: string): string | undefined => {
      const value = (cause as Record<string, unknown>)[name];
      return typeof value === "string" && value !== "" ? value : undefined;
    };
    const constraint = field("constraint");
    super(constraint === undefined ? "Unique constraint violated." : `Unique constraint "${constraint}" violated.`, { cause });
    this.constraint = constraint;
    this.table = field("table");
    for (const name of ["errno", "code"]) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, name);
      if (descriptor && "value" in descriptor) Object.defineProperty(this, name, { value: descriptor.value, enumerable: true });
    }
  }

  /** The driver error as UniqueViolationError when it is SQLSTATE 23505, else unchanged. */
  static from(error: unknown): unknown {
    if (error === null || typeof error !== "object" || error instanceof OrmError) return error;
    const errno = Object.getOwnPropertyDescriptor(error, "errno");
    return errno && "value" in errno && errno.value === "23505" ? new UniqueViolationError(error) : error;
  }
}

/** Reads a non-empty string field of a driver error. */
function driverField(cause: object, name: string): string | undefined {
  const value = (cause as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Copies the SQLSTATE so transaction-outcome checks see the same server rejection. */
function copyServerCode(target: object, cause: object): void {
  for (const name of ["errno", "code"]) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, name);
    if (descriptor && "value" in descriptor) Object.defineProperty(target, name, { value: descriptor.value, enumerable: true });
  }
}

/** A foreign key constraint was violated (SQLSTATE 23503). */
export class ForeignKeyViolationError extends DbUpdateError {
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  constructor(cause: object) {
    const constraint = driverField(cause, "constraint");
    super(`Foreign key constraint${constraint === undefined ? "" : ` "${constraint}"`} violated: the row refers to a missing row, or a row that other rows refer to was deleted.`, { cause });
    this.constraint = constraint;
    this.table = driverField(cause, "table");
    copyServerCode(this, cause);
  }
}

/** A CHECK constraint was violated (SQLSTATE 23514). */
export class CheckViolationError extends DbUpdateError {
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  constructor(cause: object) {
    const constraint = driverField(cause, "constraint");
    super(constraint === undefined ? "Check constraint violated." : `Check constraint "${constraint}" violated.`, { cause });
    this.constraint = constraint;
    this.table = driverField(cause, "table");
    copyServerCode(this, cause);
  }
}

/** A NOT NULL column got NULL (SQLSTATE 23502). */
export class NotNullViolationError extends DbUpdateError {
  readonly column: string | undefined;
  readonly table: string | undefined;
  constructor(cause: object) {
    const column = driverField(cause, "column");
    const table = driverField(cause, "table");
    super(column === undefined ? "A NOT NULL column got NULL." : `Column "${column}"${table === undefined ? "" : ` of table "${table}"`} does not accept NULL.`, { cause });
    this.column = column;
    this.table = table;
    copyServerCode(this, cause);
  }
}

/** A lock was not granted within `lock_timeout` (SQLSTATE 55P03). */
export class LockTimeoutError extends OrmError {
  constructor(cause: object) {
    super("A lock was not granted within lockTimeoutMs: another transaction holds the row or table. Retry the operation, or shorten the transaction that holds the lock.", { cause });
    copyServerCode(this, cause);
  }
}

const TRANSLATED: Readonly<Record<string, new (cause: object) => OrmError>> = {
  "23505": UniqueViolationError,
  "23503": ForeignKeyViolationError,
  "23514": CheckViolationError,
  "23502": NotNullViolationError,
  "55P03": LockTimeoutError,
};

/**
 * A driver error with a known SQLSTATE as its ORM error (unique, foreign key,
 * check, not-null violation, lock timeout); anything else unchanged. The
 * original error is `cause`; messages carry constraint and column names only,
 * never row values.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error === null || typeof error !== "object" || error instanceof OrmError) return error;
  const errno = Object.getOwnPropertyDescriptor(error, "errno");
  const Translated = errno && "value" in errno && typeof errno.value === "string" ? TRANSLATED[errno.value] : undefined;
  return Translated === undefined ? error : new Translated(error);
}

/** The entity failed validation before saving. */
export class OrmValidationError extends DbUpdateError {
  constructor(
    readonly entityName: string,
    readonly errors: readonly ValidationError[],
  ) {
    super(`Validation failed for "${entityName}": ${errors.map((error) => error.message).join("; ")}`);
  }
}

/** What a context knows of a table, to name the properties of a violated constraint. */
export interface ViolationModels {
  readonly entities: readonly {
    readonly tableName: string;
    readonly keyName?: string;
    readonly key: readonly { readonly propertyName: string }[];
    readonly properties: readonly { readonly propertyName: string; readonly columnName: string }[];
    readonly indexes: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean; readonly conflict?: string }[];
  }[];
}

/** Names the properties behind a unique violation by the model of the context. Returns the same error. */
export function describeViolation(error: unknown, models: ViolationModels): unknown {
  if (!(error instanceof UniqueViolationError) || error.constraint === undefined || error.properties.length > 0) return error;
  for (const entity of models.entities) {
    if (error.table !== undefined && entity.tableName !== error.table) continue;
    const index = entity.indexes.find((item) => item.unique && item.name === error.constraint);
    if (index !== undefined) {
      error.properties = index.columns.map((column) => entity.properties.find((property) => property.columnName === column)?.propertyName ?? column);
      error.conflict = index.conflict;
      return error;
    }
    // `pk_<table>` is the name this ORM gives; `<table>_pkey` is PostgreSQL's own, from an older schema.
    if (error.constraint === (entity.keyName ?? `pk_${entity.tableName}`) || error.constraint === `${entity.tableName}_pkey`) {
      error.properties = entity.key.map((property) => property.propertyName);
      return error;
    }
  }
  return error;
}
