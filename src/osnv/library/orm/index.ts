// Метаданные и конфигурация сущностей
export {
  Column,
  Check,
  CreatedAt,
  Entity,
  ForeignKey,
  HasConversion,
  Index,
  Key,
  ManyToOne,
  OneToMany,
  QueryFilter,
  Required,
  Schema,
  SoftDelete,
  UpdatedAt,
  UUID,
} from "./Metadata/decorators";
export type {
  ColumnOptions,
  ColumnDefaultValue,
  EntityOptions,
  IndexOptions,
  KeyOptions,
  RelationOptions,
  UUIDOptions,
  ReferentialAction,
} from "./Metadata/decorators";
export { OrmModel } from "./Metadata/OrmModel";
export { ModelBuilder } from "./Metadata/ModelBuilder";
export { KeyTuple } from "./Metadata/KeyTuple";
export {
  buildDynamicModel,
  type DynamicFieldDefinition,
  type DynamicEntityDefinition,
  type DynamicPrimaryKeyDefinition,
  type DynamicForeignKeyDefinition,
  type DynamicCheckDefinition,
  type DynamicIndexDefinition,
  type DynamicRelationDefinition,
  type DynamicTableDefinition,
  type DynamicTargetResolver,
  type LogicalFieldType,
  type ScalarLogicalFieldType,
} from "./Metadata/DynamicModelBuilder";
export { pluralize } from "./Metadata/conventions";
export { ValueConverters, type ValueConverter } from "./Metadata/ValueConverter";
export type {
  ColumnOptionsType,
  ColumnType,
  EntityModel,
  ForeignKeyModel,
  IndexModel,
  CheckModel,
  KeyGeneration,
  PropertyConvention,
  PropertyModel,
  RelationKind,
  RelationModel,
  SemanticColumnType,
  StorageColumnType,
} from "./Metadata/types";

// Контекст (чистый движок; DI-обвязка — в `@/core/orm`)
export { DbContext } from "./DbContext";
export { DbContextOptions, type DbContextOptionsConfig } from "./DbContextOptions";
export { DbContextFactory } from "./DbContextFactory";
export { DatabaseFacade } from "./DatabaseFacade";
export { OrmTransaction } from "./Transactions/OrmTransaction";
export type { OrmDatabaseTimeV1, OrmTransactionScopeOptions } from "./Transactions/OrmTransaction";

// Repository (реализация; контракт `IRepository<T>` и токены — в `@/core/orm`)
export { Repository } from "./Repository/Repository";

// Запросы
export { DbSet } from "./Query/DbSet";
export { EntityQuery, IncludableQuery, ProjectedQuery, type NavigationElement } from "./Query/EntityQuery";
export type { ForUpdateOptionsV1 } from "./Query/EntityQuery";
export type { OrmMutationResultV1, OrmInsertIfAbsentResultV1, OrmUpdateValuesV1, OrmUniqueKeySelectorV1 } from "./Query/ImmediateMutations";
export { Operand, Predicate } from "./Query/conditions";
export type { FieldSelector, KeySelectorFn, PredicateFn } from "./Query/conditions";

// Трекинг
export { ChangeTracker, type TrackedEntry } from "./Tracking/ChangeTracker";
export { EntityState } from "./Tracking/EntityState";
export {
  ExecutionStrategy,
  withRetry,
  withoutExecutionStrategyRetries,
  type ExecutionStrategyOptions,
} from "./Saving/ExecutionStrategy";

// Провайдеры (значения-соединения: `postgres(...)`).
export { PostgresProvider, postgres, type PostgresProviderOptions, type PostgresServerTimeouts, type PostgresOperationEvent } from "./Providers/PostgresProvider";
export { PostgresDialect } from "./Providers/PostgresDialect";
export type {
  AfterCommitCallback,
  DatabaseProvider,
  DatabaseProviderDiagnostic,
  DatabaseProviderLimits,
  DbExecutor,
  ExecuteResult,
  ForeignKeyConstraint,
  NotificationSubscription,
  RowLockMode,
  Row,
  SqlDialect,
  SqlParam,
  TransactionCallback,
} from "./Providers/types";

// Схема и миграции
export { SchemaDiffer, type SchemaDiff, type AdditiveSchemaOperation } from "./Schema/SchemaDiffer";
export { Migrator, type MigrationResult } from "./Schema/Migrator";
export {
  MigrationRunner,
  type Migration,
  type MigrationContext,
  type VersionedMigrationResult,
} from "./Schema/MigrationRunner";
export type {
  IntrospectedColumn,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
  CanonicalDefault,
  GenerationStrategy,
  IntrospectedPrimaryKey,
  IntrospectedForeignKey,
  IntrospectedCheck,
} from "./Schema/introspection";
export type { SchemaDifferenceCode, SafeSchemaDescriptor, SchemaDifference, SchemaVerificationResult } from "./Schema/ExactSchemaVerifier";
export { SchemaAdmissionError, SchemaMigrationRequiredError, SchemaVerificationError } from "./errors";
export type { SchemaAdmissionErrorCode } from "./errors";
export { compileCheck, renderCheck } from "./Schema/CheckExpression";
export type { CheckAst, CheckExpression, CheckOperand, CheckField, CheckPredicate, CheckScalar } from "./Schema/CheckExpression";
export { defineOrmOwnedStoreV1 } from "./Schema/OrmOwnedStore";
export type { OrmCatalogScopeV1, OrmOwnedStoreDefinitionV1 } from "./Schema/OrmOwnedStore";

// Ошибки
export { isUnknownTransactionOutcome, TransactionOutcomeUnknownError } from "./Providers/transactionOutcome";
export {
  ConcurrentTransactionScopeError,
  DbUpdateError,
  EntityNotFoundError,
  EntityNotMappedError,
  ModelBuildError,
  OrmError,
  OrmValidationError,
  UniqueViolationError,
  PostCommitError,
  isCommittedOutcome,
  OrmTransactionScopeError,
  OrmProviderIdentityMismatchError,
  OrmDatabaseTimeError,
  OrmTrackedMutationConflictError,
  OrmUnsafeImmediateMutationError,
  OrmUndeclaredConflictTargetError,
  OrmOwnedStoreAdmissionError,
} from "./errors";
export type { OrmOwnedStoreAdmissionErrorCode } from "./errors";
