import { expect, test } from "bun:test";
import * as bazis from "bazis";
import * as coreOrm from "bazis/core/orm";
import * as libraryOrm from "bazis/library/orm";

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type TransactionKeys = keyof libraryOrm.OrmTransaction;
type _transactionSurface = Assert<Equal<TransactionKeys, "use" | "databaseTime" | "afterCommit">>;
type _transactionNoPrivate = Assert<Equal<Extract<TransactionKeys, "provider" | "sql" | "executor" | "commit" | "rollback" | "frame">, never>>;
type _coreTimeIdentity = Assert<Equal<coreOrm.OrmDatabaseTimeV1, libraryOrm.OrmDatabaseTimeV1>>;
type _coreLockIdentity = Assert<Equal<coreOrm.ForUpdateOptionsV1, libraryOrm.ForUpdateOptionsV1>>;
type _rootTimeIdentity = Assert<Equal<bazis.orm.OrmDatabaseTimeV1, libraryOrm.OrmDatabaseTimeV1>>;
type _rootLockIdentity = Assert<Equal<bazis.orm.ForUpdateOptionsV1, libraryOrm.ForUpdateOptionsV1>>;
type _coreMutationIdentity = Assert<Equal<coreOrm.OrmMutationResultV1, libraryOrm.OrmMutationResultV1>>;
type _rootInsertIdentity = Assert<Equal<bazis.orm.OrmInsertIfAbsentResultV1, libraryOrm.OrmInsertIfAbsentResultV1>>;
type _rootMutationIdentity = Assert<Equal<bazis.orm.OrmMutationResultV1, libraryOrm.OrmMutationResultV1>>;
type _coreInsertIdentity = Assert<Equal<coreOrm.OrmInsertIfAbsentResultV1, libraryOrm.OrmInsertIfAbsentResultV1>>;
type _coreUpdateIdentity = Assert<Equal<coreOrm.OrmUpdateValuesV1<object>, libraryOrm.OrmUpdateValuesV1<object>>>;
type _rootSelectorIdentity = Assert<Equal<bazis.orm.OrmUniqueKeySelectorV1<object>, libraryOrm.OrmUniqueKeySelectorV1<object>>>;
type _rootUpdateIdentity = Assert<Equal<bazis.orm.OrmUpdateValuesV1<object>, libraryOrm.OrmUpdateValuesV1<object>>>;
type _coreSelectorIdentity = Assert<Equal<coreOrm.OrmUniqueKeySelectorV1<object>, libraryOrm.OrmUniqueKeySelectorV1<object>>>;
type _errorIdentity = Assert<Equal<typeof coreOrm.OrmUnsafeImmediateMutationError, typeof libraryOrm.OrmUnsafeImmediateMutationError>>;
type _ownedStoreIdentity = Assert<Equal<coreOrm.OrmOwnedStoreDefinitionV1, libraryOrm.OrmOwnedStoreDefinitionV1>>;
type _ownedStoreCodeIdentity = Assert<Equal<coreOrm.OrmOwnedStoreAdmissionErrorCode, libraryOrm.OrmOwnedStoreAdmissionErrorCode>>;
const approvedOwnedCodes = ["ORM_OWNED_STORE_PROVIDER_UNSUPPORTED", "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "ORM_OWNED_STORE_IDENTITY_MISSING", "ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_OWNERSHIP_CONFLICT", "ORM_OWNED_STORE_DRIFT", "ORM_OWNED_STORE_CREATE_FAILED"] as const;
type _ownedStoreExactCodes = Assert<Equal<libraryOrm.OrmOwnedStoreAdmissionErrorCode, typeof approvedOwnedCodes[number]>>;
type Sample = { id: number; name: string };
type _updateSignature = Assert<Equal<ReturnType<coreOrm.EntityQuery<Sample>["executeUpdate"]>, Promise<libraryOrm.OrmMutationResultV1>>>;
type _deleteSignature = Assert<Equal<ReturnType<coreOrm.EntityQuery<Sample>["executeDelete"]>, Promise<libraryOrm.OrmMutationResultV1>>>;
type _insertSignature = Assert<Equal<ReturnType<coreOrm.DbSet<Sample>["insertIfAbsent"]>, Promise<libraryOrm.OrmInsertIfAbsentResultV1>>>;
const typeLedger: [_transactionSurface, _transactionNoPrivate, _coreTimeIdentity, _coreLockIdentity, _rootTimeIdentity, _rootLockIdentity, _coreMutationIdentity, _rootInsertIdentity, _rootMutationIdentity, _coreInsertIdentity, _coreUpdateIdentity, _rootUpdateIdentity, _rootSelectorIdentity, _coreSelectorIdentity, _errorIdentity, _ownedStoreIdentity, _ownedStoreCodeIdentity, _ownedStoreExactCodes, _updateSignature, _deleteSignature, _insertSignature] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

test("ORM public barrels retain PostgreSQL and generic contracts without SQLite", async () => {
  expect(typeLedger).toEqual([true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
  expect(coreOrm.ormBazisConnect).toBeFunction();
  expect("OrmOwnedStoreLifecycle" in coreOrm).toBe(false);
  expect(libraryOrm.postgres).toBeFunction();
  expect(libraryOrm.PostgresProvider).toBeDefined();
  expect(libraryOrm.PostgresDialect).toBeDefined();
  expect(libraryOrm.OrmTransaction).toBeDefined();
  expect(libraryOrm.OrmTransactionScopeError).toBeDefined();
  expect(libraryOrm.OrmProviderIdentityMismatchError).toBeDefined();
  expect(libraryOrm.OrmDatabaseTimeError).toBeDefined();
  expect(libraryOrm.OrmTrackedMutationConflictError).toBeDefined();
  expect(libraryOrm.OrmUnsafeImmediateMutationError).toBeDefined();
  expect(libraryOrm.OrmUndeclaredConflictTargetError).toBeDefined();
  expect(libraryOrm.defineOrmOwnedStoreV1).toBeFunction();
  expect(libraryOrm.OrmOwnedStoreAdmissionError).toBeDefined();
  expect(coreOrm.defineOrmOwnedStoreV1).toBe(libraryOrm.defineOrmOwnedStoreV1);
  expect(bazis.orm.defineOrmOwnedStoreV1).toBe(libraryOrm.defineOrmOwnedStoreV1);
  expect(coreOrm.OrmOwnedStoreAdmissionError).toBe(libraryOrm.OrmOwnedStoreAdmissionError);
  expect(bazis.orm.OrmOwnedStoreAdmissionError).toBe(libraryOrm.OrmOwnedStoreAdmissionError);
  for (const code of approvedOwnedCodes) { const ownedError = new libraryOrm.OrmOwnedStoreAdmissionError(code, "safe"); expect(ownedError.code).toBe(code); expect(ownedError.cause).toBeUndefined(); }
  for (const error of ["OrmTrackedMutationConflictError", "OrmUnsafeImmediateMutationError", "OrmUndeclaredConflictTargetError"] as const) {
    expect(coreOrm[error]).toBe(libraryOrm[error]); expect(bazis.orm[error]).toBe(libraryOrm[error]);
    const instance = new libraryOrm[error](); expect(instance.message).not.toContain("SQL"); expect(instance.cause).toBeUndefined();
  }
  expect(coreOrm.OrmTransaction).toBeDefined();
  expect(coreOrm.OrmTransactionScopeError).toBeDefined();
  expect(coreOrm.OrmProviderIdentityMismatchError).toBeDefined();
  expect(coreOrm.OrmDatabaseTimeError).toBeDefined();
  expect(bazis.postgres).toBeFunction();
  expect(bazis.orm.OrmTransaction).toBeDefined();

  const time: libraryOrm.OrmDatabaseTimeV1 = { instant: new Date(0), epochMilliseconds: 0, precision: "millisecond" };
  const lock: libraryOrm.ForUpdateOptionsV1 = { skipLocked: true };
  expect(time.epochMilliseconds).toBe(0);
  expect(lock.skipLocked).toBe(true);

  expect("sqlite" in bazis).toBe(false);
  expect("sqlite" in coreOrm).toBe(false);
  expect("sqlite" in libraryOrm).toBe(false);
  expect("SqliteProvider" in libraryOrm).toBe(false);
  expect("SqliteDialect" in libraryOrm).toBe(false);
  for (const privateName of ["postgresTransactionCapability", "rootAuthority", "baseProvider", "observeProviderDispatch", "CancellableProviderDispatch", "Frame", "DbExecutor", "commit", "rollback", "sql", "monitorImmediateOperation", "executeImmediateUpdate", "executeImmediateDelete", "hasTrackedEntriesForModel", "canonicalOwnedStoreScopeHashV1", "canonicalOwnedStoreModelHashV1", "canonicalOwnedStoreScopePreimageV1", "ownedStoreAdvisoryLockV1", "isDefinedOrmOwnedStoreV1", "ORM_OWNED_STORE_CHANNEL", "preparedOwnedStoreRegistration"]) {
    expect(privateName in libraryOrm).toBe(false);
    expect(privateName in coreOrm).toBe(false);
    expect(privateName in bazis.orm).toBe(false);
  }
  expect("OrmTransaction" in bazis).toBe(false);
  expect("OrmDatabaseTimeError" in bazis).toBe(false);
  expect("OrmTrackedMutationConflictError" in bazis).toBe(false);
  expect("OrmUnsafeImmediateMutationError" in bazis).toBe(false);
  expect("OrmUndeclaredConflictTargetError" in bazis).toBe(false);

  const manifest = JSON.parse(await Bun.file("src/bazis/package.json").text()) as {
    readonly exports: Record<string, string>;
  };
  expect(manifest.exports["./library/orm/Providers/SqliteProvider"]).toBeUndefined();
});
