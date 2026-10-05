import type { ValidationError } from "../validation";
import type { SchemaVerificationResult } from "./Schema/ExactSchemaVerifier";
import { formatSchemaDifferences } from "./Schema/formatSchemaDifferences";

/** Базовая ошибка ORM. */
export class OrmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type SchemaAdmissionErrorCode = "ORM_SCHEMA_PROVIDER_UNSUPPORTED" | "ORM_SCHEMA_LOCK_UNAVAILABLE" | "ORM_SCHEMA_LOCK_KEY_COLLISION" | "ORM_SCHEMA_ATOMICITY_UNAVAILABLE" | "ORM_SCHEMA_MODEL_INVALID" | "ORM_SCHEMA_CATALOG_UNSUPPORTED" | "ORM_SCHEMA_CREATE_FAILED" | "ORM_SCHEMA_ADDITIVE_DATA_VIOLATION" | "ORM_SCHEMA_ADDITIVE_DDL_FAILED" | "ORM_SCHEMA_MIGRATION_REQUIRED" | "ORM_SCHEMA_DRIFT" | "ORM_SCHEMA_OWNERSHIP_CONFLICT" | "ORM_SCHEMA_HOSTED_PHASE_CONFLICT";
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
    "Check the application version and target database. Align the ORM model and database schema; apply an explicit migration if a database change is intended.",
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

/** Ошибка построения модели (конфигурации сущности). Бросается на старте. */
export class ModelBuildError extends OrmError {}

/** Запрос `first()` не нашёл ни одной строки. */
export class EntityNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(`Sequence contains no elements for entity "${entityName}".`);
  }
}

/** Класс не зарегистрирован как сущность в этом контексте. */
export class EntityNotMappedError extends OrmError {
  constructor(name: string) {
    super(
      `Type "${name}" is not mapped in this DbContext. Add it to ormModule({ entities: [...] }) and annotate it with @Entity().`,
    );
  }
}

/** Ошибка во время применения изменений (SaveChanges). */
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
  constructor(message = "ORM transaction scope is not active for this operation.") { super(message); }
}

/** Contexts may share transaction work only when their configured provider is the same object. */
export class OrmProviderIdentityMismatchError extends OrmError {
  constructor() { super("ORM transaction context belongs to a different provider identity."); }
}

/** The provider did not return an exact safe millisecond database timestamp. */
export class OrmDatabaseTimeError extends OrmError {
  constructor() { super("ORM provider returned an invalid database time value."); }
}

/** Immediate DML is deliberately isolated from tracked state. */
export class OrmTrackedMutationConflictError extends OrmError {
  constructor() { super("Immediate ORM mutation conflicts with tracked entities."); }
}
/** Immediate DML accepts only the small, closed descriptor-safe input domain. */
export class OrmUnsafeImmediateMutationError extends OrmError {
  constructor() { super("Immediate ORM mutation input is unsafe or unsupported."); }
}
/** INSERT ON CONFLICT may name only an exactly declared unique target. */
export class OrmUndeclaredConflictTargetError extends OrmError {
  constructor() { super("Immediate ORM mutation conflict target is not a declared unique key."); }
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

/** Сущность не прошла валидацию перед сохранением. */
export class OrmValidationError extends DbUpdateError {
  constructor(
    readonly entityName: string,
    readonly errors: readonly ValidationError[],
  ) {
    super(`Validation failed for "${entityName}": ${errors.map((error) => error.message).join("; ")}`);
  }
}
