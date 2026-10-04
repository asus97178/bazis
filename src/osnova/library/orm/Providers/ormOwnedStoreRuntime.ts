import type { DatabaseProvider } from "./types";
import { knownExecutionStrategyBase } from "../Saving/ExecutionStrategy";
import type { OrmOwnedStoreDefinitionV1 } from "../Schema/OrmOwnedStore";
import { isDefinedOrmOwnedStoreV1 } from "../Schema/OrmOwnedStore";
import { OrmOwnedStoreAdmissionError } from "../errors";
import type { ExpectedTable } from "../Schema/ExpectedSchema";
import type { OwnedStoreCatalogSnapshotV1, OwnedStoreRegistrySnapshotV1 } from "../Schema/OwnedStoreCatalog";
import type { OrmCatalogScopeV1 } from "../Schema/OrmOwnedStore";

export interface OwnedStoreSecondaryLockEntryV1 { readonly kind: "store" | "scope"; readonly preimage: Uint8Array; readonly key: bigint; }
export interface OwnedStoreSecondaryLockPlanV1 { readonly stores: readonly OwnedStoreSecondaryLockEntryV1[]; readonly scopes: readonly OwnedStoreSecondaryLockEntryV1[]; }
export type OwnedStoreCreateOperationV1 = { readonly kind: "createSchema"; readonly schema: string } | { readonly kind: "createTable"; readonly table: ExpectedTable } | { readonly kind: "addForeignKey"; readonly table: ExpectedTable; readonly foreignKey: ExpectedTable["foreignKeys"][number] } | { readonly kind: "createIndex"; readonly table: ExpectedTable; readonly index: ExpectedTable["indexes"][number] };
export interface OwnedStoreIdentityInsertV1 { readonly storeKey: string; readonly contract: "osnova.orm-owned-store/v1"; readonly formatVersion: number; readonly ownedSchema: string; readonly tablePrefix: string; readonly ownedScopeHash: `sha256:${string}`; readonly modelHash: `sha256:${string}`; }
export interface RegistryLockedOwnedStoreSessionV1 { readonly maxIdentifierLength: bigint; inspectRegistry(): Promise<OwnedStoreRegistrySnapshotV1>; lockSecondary(plan: OwnedStoreSecondaryLockPlanV1): Promise<SecondaryLockedOwnedStoreSessionV1>; }
export interface SecondaryLockedOwnedStoreSessionV1 { inspectCatalog(scopes: readonly OrmCatalogScopeV1[]): Promise<OwnedStoreCatalogSnapshotV1>; createRegistryV1(): Promise<void>; applyCreateOperations(operations: readonly OwnedStoreCreateOperationV1[]): Promise<void>; insertIdentities(rows: readonly OwnedStoreIdentityInsertV1[]): Promise<void>; inspectRegistry(): Promise<OwnedStoreRegistrySnapshotV1>; }
export interface PostgresOwnedStoreCapability { withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T>; }
const capabilities = new WeakMap<DatabaseProvider, PostgresOwnedStoreCapability>();
const leases = new WeakMap<DatabaseProvider, WeakMap<object, number>>();

export function registerPostgresOwnedStoreCapability(provider: DatabaseProvider, capability: PostgresOwnedStoreCapability): void { capabilities.set(provider, capability); }
export function postgresOwnedStoreCapability(provider: DatabaseProvider): PostgresOwnedStoreCapability | undefined { const base = knownExecutionStrategyBase(provider); return base === undefined ? undefined : capabilities.get(base); }
export function failure(code: OrmOwnedStoreAdmissionError["code"]): OrmOwnedStoreAdmissionError { return new OrmOwnedStoreAdmissionError(code, code); }
