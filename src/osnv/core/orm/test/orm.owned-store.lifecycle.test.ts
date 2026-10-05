import { describe, expect, test } from "bun:test";
import { createContainer, DI, Global, HOSTED_SERVICE, Module, type HostedService } from "@/core/di";
import { HEALTH_CHECK, LifecycleCoordinator } from "@/core/kernel";
import { Column, DATABASE_PROVIDER, DbContext, DbContextOptions, defineOrmOwnedStoreV1, Entity, EntityNotMappedError, ForeignKey, Key, ormModule, type DatabaseProvider } from "osnv/core/orm";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreScopeHashV1 } from "../../../library/orm/Schema/OwnedStoreCanonical";
import { registerPostgresOwnedStoreCapability, type OwnedStoreCreateOperationV1, type OwnedStoreIdentityInsertV1, type OwnedStoreSecondaryLockPlanV1, type RegistryLockedOwnedStoreSessionV1, type SecondaryLockedOwnedStoreSessionV1 } from "../../../library/orm/Providers/ormOwnedStoreRuntime";
import { parseOwnedStoreCatalogSnapshotV1, parseOwnedStoreRegistrySnapshotV1, type OwnedStoreCatalogSnapshotV1 } from "../../../library/orm/Schema/OwnedStoreCatalog";
import { OrmOwnedStoreLifecycle } from "../OrmOwnedStoreLifecycle";
import { attachOwnedStoreRegistration, readOwnedStoreRegistration } from "../ownedStoreContributions";

@Entity({ table: "osnv_td_jobs" })
class OwnedRow { @Key({ generated: false, name: "pk_jobs" }) @Column({ type: "integer", nullable: false }) id!: number; }
class OwnedContext extends DbContext { constructor(options: DbContextOptions) { super(options); } }
@Entity({ table: "osnv_td_tasks" })
class OwnedTask { @Key({ generated: false, name: "pk_tasks" }) @Column({ type: "integer", nullable: false }) id!: number; }
class OwnedTaskContext extends DbContext { constructor(options: DbContextOptions) { super(options); } }
const definition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "owned.lifecycle", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnv_td_j" } });
const taskDefinition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "owned.tasks", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnv_td_tasks" } });

function catalogue(): OwnedStoreCatalogSnapshotV1 { return {
  contract: "osnv.orm-owned-store-catalog-snapshot/v1", requestedScopes: [{ schema: "public", tablePrefix: "osnv_td_j" }], existingSchemas: ["public"],
  catalogClasses: [{ oid: "1", schema: "pg_catalog", name: "pg_class", kind: "pg_class" }, { oid: "2", schema: "pg_catalog", name: "pg_type", kind: "pg_type" }, { oid: "3", schema: "pg_catalog", name: "pg_constraint", kind: "pg_constraint" }, { oid: "4", schema: "pg_catalog", name: "pg_attrdef", kind: "pg_attrdef" }, { oid: "5", schema: "pg_catalog", name: "pg_namespace", kind: "pg_namespace" }],
  relations: [{ oid: "10", namespaceOid: "12000", schema: "public", name: "osnv_td_jobs", kind: "ordinaryTable", rawKind: "r", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options: [], rowTypeOid: "11", toastRelationOid: null }, { oid: "12", namespaceOid: "12000", schema: "public", name: "pk_jobs", kind: "index", rawKind: "i", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "nothing", tablespaceOid: "0", accessMethod: "btree", options: [], rowTypeOid: null, toastRelationOid: null }],
  rowTypes: [{ oid: "11", relationOid: "10", schema: "public", name: "osnv_td_jobs", kind: "composite", arrayTypeOid: "15" }], arrayTypes: [{ oid: "15", elementTypeOid: "11", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_osnv_td_jobs", kind: "base", category: "array" }],
  columns: [{ relationOid: "10", attnum: "1", name: "id", dropped: false, local: true, inheritanceCount: "0", physicalType: "integer", typeOid: "23", notNull: true, default: { kind: "none" }, defaultObjectOid: null, generation: "none", identityCode: "", generatedCode: "", collationOid: "0", typeDefaultCollationOid: "0", storageCode: "p", typeDefaultStorageCode: "p", compressionCode: "" }],
  indexes: [{ indexRelationOid: "12", tableRelationOid: "10", name: "pk_jobs", method: "btree", unique: true, primary: true, exclusion: false, immediate: true, valid: true, ready: true, live: true, replicaIdentity: false, nullsNotDistinct: false, keyAttributeCount: "1", totalAttributeCount: "1", attributeNumbers: ["1"], columnNames: ["id"], collationOids: ["0"], opclassOids: ["99"], defaultOpclassOids: ["99"], options: ["0"], expression: null, predicate: null, backingConstraintOid: "16" }],
  constraints: [{ oid: "16", relationOid: "10", referencedRelationOid: null, name: "pk_jobs", kind: "primaryKey", columns: ["id"], referencedColumns: [], backingIndexOid: "12", onDelete: null, onUpdate: null, match: null, deferrable: false, initiallyDeferred: false, validated: true, parentConstraintOid: null, inheritanceCount: "0", noInherit: true, deleteSetColumns: [], primaryForeignEqualityOperatorOids: [], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: [], defaultEqualityOperatorOids: [], checkExpression: null }], triggers: [], rules: [], policies: [], inheritance: [], sequences: [],
  dependencies: [{ dependentClassOid: "1", dependentOid: "10", dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" }, { dependentClassOid: "2", dependentOid: "11", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "2", dependentOid: "15", dependentSubId: "0", referencedClassOid: "2", referencedOid: "11", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "3", dependentOid: "16", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "1", dependentOid: "12", dependentSubId: "0", referencedClassOid: "3", referencedOid: "16", referencedSubId: "0", kind: "internal" }],
}; }
function expectedSchema() { return { tables: [{ schema: "public", table: "osnv_td_jobs", columns: [{ property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "none" as const }, generation: "none" as const }], primaryKey: { name: "pk_jobs", columns: ["id"] }, indexes: [], foreignKeys: [], checks: [] }] }; }
/** Two disjoint one-table stores with separate physical identities, no mocks. */
function taskFixture<T>(source: T): T { const oidMap: Readonly<Record<string, string>> = { "10": "110", "11": "111", "12": "112", "15": "115", "16": "116" }; const copy = (value: unknown): unknown => typeof value === "string" ? oidMap[value] ?? value.replaceAll("osnv_td_jobs", "osnv_td_tasks").replaceAll("pk_jobs", "pk_tasks") : Array.isArray(value) ? value.map(copy) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)])) : value; return copy(source) as T; }
function twoStoreRecordingProvider(gate: Promise<void>) {
  const events: string[] = []; let closes = 0;
  const provider = { name: "postgres", dialect: { name: "recording", supportsReturning: false }, limits: { maxParametersPerCommand: 1 }, async query() { throw new Error("unexpected query"); }, async execute() { throw new Error("unexpected execute"); }, async transaction<T>() { throw new Error("unexpected transaction"); }, async ping() { return true; }, async introspect() { throw new Error("unexpected introspect"); }, async close() { closes++; } } as unknown as DatabaseProvider;
  const first = catalogue(), second = taskFixture(first), combined: Record<string, unknown> = { ...first, requestedScopes: [definition.ownedScope, taskDefinition.ownedScope] };
  for (const key of ["relations", "rowTypes", "arrayTypes", "columns", "indexes", "constraints", "triggers", "rules", "policies", "inheritance", "sequences", "dependencies"] as const) combined[key] = [...first[key], ...second[key]];
  const rawRegistry = registry(expectedSchema()), taskExpected = taskFixture(expectedSchema());
  rawRegistry.state.rows.push({ ...rawRegistry.state.rows[0]!, storeKey: taskDefinition.storeKey, contract: taskDefinition.contract, tablePrefix: taskDefinition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(taskDefinition), modelHash: canonicalOwnedStoreModelHashV1(taskDefinition, taskExpected) });
  const parsedRegistry = parseOwnedStoreRegistrySnapshotV1(rawRegistry, [definition, taskDefinition], { maxIdentifierLength: 63n }), parsedCatalogue = parseOwnedStoreCatalogSnapshotV1(combined, { maxIdentifierLength: 63n });
  const secondary: SecondaryLockedOwnedStoreSessionV1 = { async inspectCatalog() { events.push("catalogue"); return parsedCatalogue; }, async createRegistryV1() { throw new Error("unexpected create registry"); }, async applyCreateOperations() { throw new Error("unexpected create"); }, async insertIdentities() { throw new Error("unexpected insert"); }, async inspectRegistry() { events.push("finalRegistry"); return parsedRegistry; } };
  const locked: RegistryLockedOwnedStoreSessionV1 = { maxIdentifierLength: 63n, async inspectRegistry() { events.push("registry"); return parsedRegistry; }, async lockSecondary() { events.push("lock"); return secondary; } };
  registerPostgresOwnedStoreCapability(provider, { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("admit"); await gate; return work(locked); } });
  return { provider, events, closes: () => closes };
}
function registry(expected: ReturnType<typeof expectedSchema>) {
  const source = catalogue(), rootOid = "50", rowOid = "51", arrayOid = "52", constraintOid = "53", indexOid = "54", root = { ...source.relations[0]!, oid: rootOid, name: "__osnv_orm_owned_stores_v1", rowTypeOid: rowOid };
  const names = ["store_key", "contract", "format_version", "owned_schema", "table_prefix", "owned_scope_hash", "model_hash", "created_at"] as const, types = ["text", "text", "integer", "text", "text", "text", "text", "datetime"] as const;
  const columns = names.map((name, index) => ({ ...source.columns[0]!, relationOid: rootOid, attnum: String(index + 1), name, physicalType: types[index]!, typeOid: types[index] === "text" ? "25" : types[index] === "datetime" ? "1184" : "20", notNull: true, collationOid: types[index] === "text" ? "100" : "0", typeDefaultCollationOid: types[index] === "text" ? "100" : "0", storageCode: types[index] === "text" ? "x" : "p", typeDefaultStorageCode: types[index] === "text" ? "x" : "p" }));
  return { contract: "osnv.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "present" as const, rows: [{ storeKey: definition.storeKey, contract: definition.contract, formatVersion: "1", ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition), modelHash: canonicalOwnedStoreModelHashV1(definition, expected), createdAtEpochMicroseconds: "0" }], shape: { catalogClasses: source.catalogClasses, relation: root, rowType: { ...source.rowTypes[0]!, oid: rowOid, relationOid: rootOid, name: root.name, arrayTypeOid: arrayOid }, arrayType: { ...source.arrayTypes[0]!, oid: arrayOid, elementTypeOid: rowOid, name: "_osnv_orm_owned_stores_v1" }, columns, indexes: [{ ...source.indexes[0]!, indexRelationOid: indexOid, tableRelationOid: rootOid, name: "__osnv_orm_owned_stores_v1_pkey", backingConstraintOid: constraintOid, columnNames: ["store_key"], collationOids: ["100"], opclassOids: ["3126"], defaultOpclassOids: ["3126"] }], indexRelations: [{ ...source.relations[1]!, oid: indexOid, name: "__osnv_orm_owned_stores_v1_pkey" }], constraints: [{ ...source.constraints[0]!, oid: constraintOid, relationOid: rootOid, name: "__osnv_orm_owned_stores_v1_pkey", columns: ["store_key"], backingIndexOid: indexOid }], triggers: [], rules: [], policies: [], inheritance: [], sequences: [], toast: null, dependencies: [{ dependentClassOid: "1", dependentOid: rootOid, dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" }, { dependentClassOid: "2", dependentOid: rowOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "0", kind: "internal" }, { dependentClassOid: "2", dependentOid: arrayOid, dependentSubId: "0", referencedClassOid: "2", referencedOid: rowOid, referencedSubId: "0", kind: "internal" }, { dependentClassOid: "3", dependentOid: constraintOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "1", dependentOid: indexOid, dependentSubId: "0", referencedClassOid: "3", referencedOid: constraintOid, referencedSubId: "0", kind: "internal" }] } } };
}
function recordingProvider(options: { readonly beforeWork?: Promise<void>; readonly afterWork?: () => void; readonly failAdmission?: (attempt: number) => boolean } = {}): { readonly provider: DatabaseProvider; readonly events: string[]; readonly closes: () => number } {
  const events: string[] = []; let closeCount = 0;
  const provider = { name: "postgres", dialect: { name: "recording", supportsReturning: false }, limits: { maxParametersPerCommand: 1 }, async query() { throw new Error("unexpected query"); }, async execute() { throw new Error("unexpected execute"); }, async transaction<T>() { throw new Error("unexpected transaction"); }, async ping() { events.push("ping"); return true; }, async introspect() { throw new Error("unexpected introspect"); }, async close() { closeCount++; } } as unknown as DatabaseProvider;
  const expected = expectedSchema(), parsedRegistry = parseOwnedStoreRegistrySnapshotV1(registry(expected), [definition], { maxIdentifierLength: 63n }), parsedCatalogue = parseOwnedStoreCatalogSnapshotV1(catalogue(), { maxIdentifierLength: 63n });
  const secondary: SecondaryLockedOwnedStoreSessionV1 = { async inspectCatalog() { events.push("catalogue"); return parsedCatalogue; }, async createRegistryV1() { throw new Error("unexpected create registry"); }, async applyCreateOperations(_operations: readonly OwnedStoreCreateOperationV1[]) { throw new Error("unexpected create"); }, async insertIdentities(_rows: readonly OwnedStoreIdentityInsertV1[]) { throw new Error("unexpected insert"); }, async inspectRegistry() { events.push("finalRegistry"); return parsedRegistry; } };
  const locked: RegistryLockedOwnedStoreSessionV1 = { maxIdentifierLength: 63n, async inspectRegistry() { events.push("registry"); return parsedRegistry; }, async lockSecondary(_plan: OwnedStoreSecondaryLockPlanV1) { events.push("lock"); return secondary; } };
  let attempts = 0;
  registerPostgresOwnedStoreCapability(provider, { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { attempts++; events.push("admit"); if (options.failAdmission?.(attempts)) throw new Error("recorded admission failure"); await options.beforeWork; const value = await work(locked); options.afterWork?.(); return value; } });
  return { provider, events, closes: () => closeCount };
}
function ownedRoot(provider: DatabaseProvider) { @Module({ imports: [ormModule({ provider })], ormOsnv: { context: OwnedContext, entities: [OwnedRow], ownedStore: definition, healthCheck: false } }) class Root {} return Root; }
describe("owned-store core lifecycle", () => {
  test("two owned stores share one real DI admission plan and retain per-store local readiness", async () => {
    let release!: () => void;
    const fixture = twoStoreRecordingProvider(new Promise<void>((resolve) => { release = resolve; }));
    @Module({ imports: [ormModule({ provider: fixture.provider, healthCheck: false })], ormOsnv: [{ context: OwnedContext, entities: [OwnedRow], ownedStore: definition, registerRepositories: false, healthCheck: false }, { context: OwnedTaskContext, entities: [OwnedTask], ownedStore: taskDefinition, registerRepositories: false, healthCheck: false }] }) class Root {}
    const container = createContainer(Root), owned = container.resolveAll(HOSTED_SERVICE).filter((service) => service.phase === -105), health = container.resolveAll(HEALTH_CHECK);
    expect(owned).toHaveLength(2); expect(owned[0]).toBe(owned[1]); expect(health.map((entry) => entry.name).sort()).toEqual(["orm-owned-store:owned.lifecycle", "orm-owned-store:owned.tasks"]);
    const starts = owned.map((service) => service.start()); expect(fixture.events).toEqual(["admit"]);
    for (const entry of health) await expect(entry.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
    release(); await Promise.all(starts); expect(fixture.events).toEqual(["admit", "registry", "lock", "catalogue", "finalRegistry"]);
    for (const entry of health) await expect(entry.check()).resolves.toEqual({ healthy: true });
    await Promise.all(owned.map((service) => service.start())); expect(fixture.events).toEqual(["admit", "registry", "lock", "catalogue", "finalRegistry"]);
    await Promise.all(owned.map((service) => service.stop())); for (const entry of health) await expect(entry.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" }); expect(fixture.closes()).toBe(0);
  });
  test("two owned stores in one module start through the kernel lifecycle as one hosted service", async () => {
    // Regression: both ownedStore registrations resolve the shared plan, which the
    // hosted plan used to reject as a duplicate identity before any admission.
    const fixture = twoStoreRecordingProvider(Promise.resolve());
    @Module({ imports: [ormModule({ provider: fixture.provider, healthCheck: false })], ormOsnv: [{ context: OwnedContext, entities: [OwnedRow], ownedStore: definition, registerRepositories: false, healthCheck: false }, { context: OwnedTaskContext, entities: [OwnedTask], ownedStore: taskDefinition, registerRepositories: false, healthCheck: false }] }) class Root {}
    const container = createContainer(Root), coordinator = new LifecycleCoordinator(container);
    await coordinator.start();
    expect(fixture.events).toEqual(["admit", "registry", "lock", "catalogue", "finalRegistry"]);
    for (const entry of container.resolveAll(HEALTH_CHECK)) await expect(entry.check()).resolves.toEqual({ healthy: true });
    await coordinator.stopServices();
    for (const entry of container.resolveAll(HEALTH_CHECK)) await expect(entry.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
    // The connection module owns the provider; the owned-store plan never closes it.
    expect(fixture.closes()).toBe(1);
  });
  test("uses actual ormOsnv shared provider admission and container-local leases", async () => {
    const fixture = recordingProvider(), Root = ownedRoot(fixture.provider), first = createContainer(Root), second = createContainer(Root);
    const firstCoordinator = new LifecycleCoordinator(first), secondCoordinator = new LifecycleCoordinator(second);
    await firstCoordinator.start();
    expect(fixture.events).toEqual(["admit", "registry", "lock", "catalogue", "finalRegistry"]);
    const firstLifecycle = first.resolveAll(HOSTED_SERVICE).find((service) => (service as { phase?: number }).phase === -105) as HostedService & { health: { check(): Promise<unknown> } };
    await expect(firstLifecycle.health.check()).resolves.toEqual({ healthy: true });
    await secondCoordinator.start();
    expect(fixture.events.filter((event) => event === "admit")).toHaveLength(2);
    await firstCoordinator.stopServices();
    await expect(firstLifecycle.health.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
    await secondCoordinator.stopServices();
    expect(fixture.closes()).toBe(2);
  });

  test("single-flights repeated start and fences idle, pending, and post-commit abort without closing its provider", async () => {
    const valid = recordingProvider();
    const lifecycle = new OrmOwnedStoreLifecycle(valid.provider, [attachOwnedStoreRegistration({}, OwnedContext as never, [OwnedRow], definition)]);
    await lifecycle.stop();
    await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()]);
    expect(valid.events.filter((event) => event === "admit")).toHaveLength(1);
    await lifecycle.stop(); await lifecycle.stop();
    await expect(lifecycle.health.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
    expect(valid.closes()).toBe(0);

    const pre = recordingProvider(), preAbort = new AbortController(); preAbort.abort();
    await expect(new OrmOwnedStoreLifecycle(pre.provider, [attachOwnedStoreRegistration({}, OwnedContext as never, [OwnedRow], definition)]).start(preAbort.signal)).rejects.toMatchObject({ code: "ORM_OWNED_STORE_LOCK_UNAVAILABLE" });
    expect(pre.events).toEqual([]);

    let release: (() => void) | undefined;
    const pending = recordingProvider({ beforeWork: new Promise<void>((resolve) => { release = resolve; }) });
    const pendingLifecycle = new OrmOwnedStoreLifecycle(pending.provider, [attachOwnedStoreRegistration({}, OwnedContext as never, [OwnedRow], definition)]);
    const starting = pendingLifecycle.start(); const stopping = pendingLifecycle.stop(); release?.();
    await expect(starting).rejects.toMatchObject({ code: "ORM_OWNED_STORE_LOCK_UNAVAILABLE" }); await stopping;
    await expect(pendingLifecycle.health.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });

    const postAbort = new AbortController();
    const post = recordingProvider({ afterWork: () => postAbort.abort() });
    const postLifecycle = new OrmOwnedStoreLifecycle(post.provider, [attachOwnedStoreRegistration({}, OwnedContext as never, [OwnedRow], definition)]);
    await expect(postLifecycle.start(postAbort.signal)).rejects.toMatchObject({ code: "ORM_OWNED_STORE_LOCK_UNAVAILABLE" });
    await expect(postLifecycle.health.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
  });

  test("a failed second container admission cannot revoke the first container lease or health", async () => {
    const fixture = recordingProvider({ failAdmission: (attempt) => attempt === 2 });
    const Root = ownedRoot(fixture.provider), first = createContainer(Root), second = createContainer(Root);
    const firstPlan = first.resolveAll(HOSTED_SERVICE).find((service) => (service as { phase?: number }).phase === -105) as HostedService & { health: { check(): Promise<unknown> } };
    const secondPlan = second.resolveAll(HOSTED_SERVICE).find((service) => (service as { phase?: number }).phase === -105) as HostedService;
    await firstPlan.start();
    await expect(secondPlan.start()).rejects.toMatchObject({ code: "ORM_OWNED_STORE_LOCK_UNAVAILABLE" });
    await secondPlan.stop();
    await expect(firstPlan.health.check()).resolves.toEqual({ healthy: true });
    expect(fixture.closes()).toBe(0);
  });
});

@Entity({ table: "probe_a_item" }) class ProbeItemA { @Key() @Column({ type: "integer" }) id = 0; }
@Entity({ table: "probe_a_other" }) class ProbeOtherA { @Key() @Column({ type: "integer" }) id = 0; }
@Entity({ table: "probe_b_item" }) class ProbeItemB { @Key() @Column({ type: "integer" }) id = 0; }
@Entity({ table: "__osnv_orm_probe" }) class ProbeRegistryClaim { @Key() @Column({ type: "integer" }) id = 0; }
class ProbeContextA extends DbContext {}
class ProbeContextB extends DbContext {}
@Entity({ table: "outside_parent" }) class ForeignParent { @Key() @Column({ type: "integer" }) id = 0; }
@Entity({ table: "probe_a_child" }) class ForeignChild { @Key() @Column({ type: "integer" }) id = 0; @ForeignKey(() => ForeignParent) @Column({ type: "integer" }) parentId = 0; }
const probeDefinition = (storeKey = "probe-a", tablePrefix = "probe_a_") => defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey, formatVersion: 1, ownedScope: { schema: "public", tablePrefix } });
function probeRoot(config: object) { @Module({ ormOsnv: config as never }) class Root {} return Root; }
function probeReject(work: () => unknown, code: string): void { let error: unknown; try { work(); } catch (caught) { error = caught; } expect((error as { code?: unknown })?.code).toBe(code); }
const probeMismatch = (work: () => unknown) => probeReject(work, "ORM_OWNED_STORE_IDENTITY_MISMATCH");
const probeConflict = (work: () => unknown) => probeReject(work, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");

function directProbeProvider(activations: { value: number }) {
  @Global() @Module({ providers: [DI.singleton(DI.factoryProvider(DATABASE_PROVIDER, [], () => { activations.value += 1; return recordingProvider().provider; }))], exports: [DATABASE_PROVIDER] }) class Provider {}
  return Provider;
}

function resolveProbeContext<T extends DbContext>(container: ReturnType<typeof createContainer>, token: new (...args: any[]) => T): T {
  const scope = container.createScope();
  try { return scope.resolve(token); } finally { void scope.dispose(); }
}

function generatedEntity(table: string): new () => object {
  const metadata: object = {};
  class GeneratedRow { id = 0; }
  Object.defineProperty(GeneratedRow, Symbol.metadata, { value: metadata });
  const classContext = { metadata } as ClassDecoratorContext;
  const fieldContext = { metadata, name: "id", static: false, private: false } as ClassFieldDecoratorContext;
  Entity({ table })(GeneratedRow, classContext);
  Column({ type: "integer", nullable: false })(undefined, fieldContext);
  Key({ generated: false, name: `pk_${table}` })(undefined, fieldContext);
  return GeneratedRow;
}
function generatedContext(): new (options: DbContextOptions) => DbContext { return class GeneratedContext extends DbContext {}; }

describe("owned-store graph and declarative-cache fences", () => {
  test("preflights valid, duplicate, ordinary-overlap, registry and self-reject graphs before provider work", () => {
    expect(() => createContainer(probeRoot({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }))).not.toThrow();
    @Module({ imports: [ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }), ormModule({ context: ProbeContextB, entities: [ProbeItemB], ownedStore: probeDefinition("probe-a", "probe_b_"), registerRepositories: false })] }) class Duplicate {}
    probeConflict(() => createContainer(Duplicate));
    @Module({ imports: [ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }), ormModule({ context: ProbeContextB, entities: [ProbeItemA], registerRepositories: false })] }) class OrdinaryOverlap {}
    probeConflict(() => createContainer(OrdinaryOverlap));
    probeConflict(() => createContainer(probeRoot({ context: ProbeContextA, entities: [ProbeRegistryClaim], ownedStore: probeDefinition("registry", "__osnv_orm_"), registerRepositories: false })));
    const selfReject = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "self", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "probe_a_" }, rejectIfPresent: [{ schema: "public", tablePrefix: "probe_a_reserved_" }] });
    probeConflict(() => createContainer(probeRoot({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: selfReject, registerRepositories: false })));
  });

  test("rejects every cached owned and mixed-graph mutation", () => {
    const config = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false, migrateOnStart: false };
    const Root = probeRoot(config); createContainer(Root); config.context = ProbeContextB; probeMismatch(() => createContainer(Root));
    const entities = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false };
    const EntitiesRoot = probeRoot(entities); createContainer(EntitiesRoot); entities.entities[0] = ProbeOtherA; probeMismatch(() => createContainer(EntitiesRoot));
    const descriptor = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false };
    const DescriptorRoot = probeRoot(descriptor); createContainer(DescriptorRoot); descriptor.ownedStore = probeDefinition(); probeMismatch(() => createContainer(DescriptorRoot));
    const raw = { contract: "osnv.orm-owned-store/v1" as const, storeKey: "raw", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "probe_a_" } };
    const RawRoot = probeRoot({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: raw, registerRepositories: false }); createContainer(RawRoot); raw.ownedScope.tablePrefix = "probe_b_"; probeMismatch(() => createContainer(RawRoot));
    const authority = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false, migrateOnStart: false };
    const AuthorityRoot = probeRoot(authority); createContainer(AuthorityRoot); authority.migrateOnStart = true; probeMismatch(() => createContainer(AuthorityRoot));
    const removed: Record<string, unknown> = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false };
    const RemovedRoot = probeRoot(removed); createContainer(RemovedRoot); delete removed.ownedStore; probeMismatch(() => createContainer(RemovedRoot));
    const owned = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }, ordinary = { context: ProbeContextB, entities: [ProbeItemB], registerRepositories: false };
    const MixedRoot = probeRoot([owned, ordinary]); createContainer(MixedRoot); ordinary.entities[0] = ProbeItemA; probeMismatch(() => createContainer(MixedRoot));
  });

  test("rejects an ownedStore accessor without invoking it", () => {
    let calls = 0;
    const config = Object.defineProperty({ context: ProbeContextA, entities: [ProbeItemA], registerRepositories: false }, "ownedStore", { enumerable: true, get() { calls++; return probeDefinition(); } });
    probeMismatch(() => createContainer(probeRoot(config)));
    expect(calls).toBe(0);
  });

  test("health before startup observes no provider activation", async () => {
    let activations = 0;
    @Global() @Module({ providers: [DI.singleton(DI.factoryProvider(DATABASE_PROVIDER, [], () => { activations++; return {} as never; }))], exports: [DATABASE_PROVIDER] }) class Provider {}
    @Module({ imports: [Provider], ormOsnv: { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false, healthCheck: false } }) class Root {}
    const built = createContainer(Root), health = built.resolveAll(HEALTH_CHECK).find((item) => item.name === "orm-owned-store:probe-a");
    expect(activations).toBe(0);
    await expect(health?.check()).resolves.toEqual({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" });
    expect(activations).toBe(0);
  });

  test("preflights exact owned store and table cardinality limits before provider activation", () => {
    const stores = (count: number) => Array.from({ length: count }, (_, index) => {
      const prefix = `limit_${index}_`, table = `${prefix}row`;
      return ormModule({ context: generatedContext(), entities: [generatedEntity(table)], ownedStore: probeDefinition(`limit-${index}`, prefix), registerRepositories: false });
    });
    @Module({ imports: stores(128) }) class Stores128 {}
    expect(() => createContainer(Stores128)).not.toThrow();
    @Module({ imports: stores(129) }) class Stores129 {}
    probeConflict(() => createContainer(Stores129));

    const tables = (count: number) => Array.from({ length: count }, (_, index) => generatedEntity(`table_limit_${index}`));
    expect(() => ormModule({ context: generatedContext(), entities: tables(512), ownedStore: probeDefinition("tables-512", "table_limit_"), registerRepositories: false })).not.toThrow();
    probeMismatch(() => ormModule({ context: generatedContext(), entities: tables(513), ownedStore: probeDefinition("tables-513", "table_limit_"), registerRepositories: false }));
  });

  test("retains disjoint ordinary startup compatibility and fences an owned table even with false flags", () => {
    @Module({ imports: [
      ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }),
      ormModule({ context: ProbeContextB, entities: [ProbeItemB], ensureCreated: true, registerRepositories: false }),
    ] }) class Disjoint {}
    expect(() => createContainer(Disjoint)).not.toThrow();
    @Module({ imports: [
      ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }),
      ormModule({ context: ProbeContextB, entities: [ProbeItemA], ensureCreated: false, migrateOnStart: false, runMigrationsOnStart: false, registerRepositories: false }),
    ] }) class FalseFlagsOverlap {}
    probeConflict(() => createContainer(FalseFlagsOverlap));
  });

  test("rejects initial owned startup authority variants and preserves direct nominal registration identity", () => {
    for (const invalid of [{ migrations: [] }, { migrateOnStart: true }, { runMigrationsOnStart: true }, { ensureCreated: true }, { provider: {} as DatabaseProvider }]) {
      expect(() => ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false, ...invalid })).toThrow();
    }
    const helper = probeDefinition(), raw = { contract: "osnv.orm-owned-store/v1" as const, storeKey: "raw-identity", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "probe_a_" } };
    const helperRegistration = readOwnedStoreRegistration(ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: helper, registerRepositories: false }))!;
    const rawRegistration = readOwnedStoreRegistration(ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: raw, registerRepositories: false }))!;
    const copiedRegistration = readOwnedStoreRegistration(ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: { ...raw }, registerRepositories: false }))!;
    expect(helperRegistration.definition).toBe(helper); expect(rawRegistration.definition).not.toBe(raw); expect(copiedRegistration.identity).not.toBe(rawRegistration.identity);
  });

  test("rejects cached config array length and order mutation while disjoint migration contexts remain valid", () => {
    const first = { context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false }, second = { context: ProbeContextB, entities: [ProbeItemB], registerRepositories: false };
    const configs = [first, second], Root = probeRoot(configs); createContainer(Root); configs.reverse(); probeMismatch(() => createContainer(Root)); configs.reverse(); configs.push({ context: ProbeContextB, entities: [ProbeItemB], registerRepositories: false }); probeMismatch(() => createContainer(Root));
    @Module({ imports: [ormModule({ context: ProbeContextA, entities: [ProbeItemA], migrateOnStart: true, registerRepositories: false }), ormModule({ context: ProbeContextB, entities: [ProbeItemB], runMigrationsOnStart: true, migrations: [], registerRepositories: false })] }) class Migrations {}
    expect(() => createContainer(Migrations)).not.toThrow();
  });

  test("rejects an exact compiled foreign-key target outside its owned boundary before provider work", () => {
    probeConflict(() => createContainer(probeRoot({ context: ProbeContextA, entities: [ForeignParent, ForeignChild], ownedStore: probeDefinition("fk-boundary", "probe_a_"), registerRepositories: false })));
  });

  test("preserves direct ordinary shared resolve-time and standalone call-time compatibility", () => {
    const sharedConfig = { context: ProbeContextB, entities: [ProbeItemA], registerRepositories: false };
    const shared = ormModule(sharedConfig);
    sharedConfig.entities[0] = ProbeItemB;
    const activations = { value: 0 };
    @Module({ imports: [directProbeProvider(activations), shared] }) class SharedRoot {}
    const sharedContext = resolveProbeContext(createContainer(SharedRoot), ProbeContextB);
    expect(() => sharedContext.setOf(ProbeItemB)).not.toThrow();
    expect(() => sharedContext.setOf(ProbeItemA)).toThrow(EntityNotMappedError);
    expect(activations.value).toBe(1);

    const standaloneConfig = { context: ProbeContextB, entities: [ProbeItemA], provider: recordingProvider().provider, registerRepositories: false, healthCheck: false };
    const standalone = ormModule(standaloneConfig);
    standaloneConfig.entities[0] = ProbeItemB;
    @Module({ imports: [standalone] }) class StandaloneRoot {}
    const standaloneContext = resolveProbeContext(createContainer(StandaloneRoot), ProbeContextB);
    expect(() => standaloneContext.setOf(ProbeItemA)).not.toThrow();
    expect(() => standaloneContext.setOf(ProbeItemB)).toThrow(EntityNotMappedError);

    const standaloneMixedConfig = { context: ProbeContextB, entities: [ProbeItemB], provider: recordingProvider().provider, registerRepositories: false, healthCheck: false, migrateOnStart: false };
    const standaloneMixed = ormModule(standaloneMixedConfig);
    standaloneMixedConfig.entities[0] = ForeignParent;
    standaloneMixedConfig.migrateOnStart = true;
    const owned = ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false });
    @Module({ imports: [directProbeProvider(activations), owned, standaloneMixed] }) class MixedStandaloneRoot {}
    const mixedStandaloneContainer = createContainer(MixedStandaloneRoot);
    const mixedStandaloneContext = resolveProbeContext(mixedStandaloneContainer, ProbeContextB);
    expect(() => mixedStandaloneContext.setOf(ForeignParent)).not.toThrow();
    expect(() => mixedStandaloneContext.setOf(ProbeItemB)).toThrow(EntityNotMappedError);
    const standaloneLifecycle = mixedStandaloneContainer.resolveAll(HOSTED_SERVICE).find((service) => service.phase === -100) as { readonly __osnvLegacySchemaAuthority?: boolean };
    expect(standaloneLifecycle.__osnvLegacySchemaAuthority).toBe(true);
  });

  test("uses the same direct ordinary snapshot for owned preflight and A/B runtime contexts", () => {
    const activations = { value: 0 };
    const ordinaryConfig = { context: ProbeContextB, entities: [ProbeItemB], registerRepositories: false };
    const ordinary = ormModule(ordinaryConfig);
    const owned = ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false });
    ordinaryConfig.entities[0] = ProbeItemA;
    @Module({ imports: [directProbeProvider(activations), owned, ordinary] }) class ConflictRoot {}
    probeConflict(() => createContainer(ConflictRoot));
    expect(activations.value).toBe(0);

    ordinaryConfig.entities[0] = ProbeItemB;
    @Module({ imports: [directProbeProvider(activations), owned, ordinary] }) class SnapshotRoot {}
    const containerA = createContainer(SnapshotRoot);
    ordinaryConfig.entities[0] = ForeignParent;
    const containerB = createContainer(SnapshotRoot);
    ordinaryConfig.entities[0] = ProbeItemA;
    const contextA = resolveProbeContext(containerA, ProbeContextB);
    expect(() => contextA.setOf(ProbeItemB)).not.toThrow();
    expect(() => contextA.setOf(ForeignParent)).toThrow(EntityNotMappedError);
    const contextB = resolveProbeContext(containerB, ProbeContextB);
    expect(() => contextB.setOf(ForeignParent)).not.toThrow();
    expect(() => contextB.setOf(ProbeItemB)).toThrow(EntityNotMappedError);
    expect(activations.value).toBe(2);
  });

  test("snapshots mixed standalone caller inputs at each container build", () => {
    const first = { id: "standalone-a", async up() {} }, second = { id: "standalone-b", async up() {} }, late = { id: "standalone-late", async up() {} };
    const config = { context: ProbeContextB, entities: [ProbeItemB], provider: recordingProvider().provider, migrateOnStart: false, runMigrationsOnStart: true, migrations: [] as typeof first[], registerRepositories: false, healthCheck: false };
    const ordinary = ormModule(config);
    const owned = ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false });
    @Module({ imports: [directProbeProvider({ value: 0 }), owned, ordinary] }) class Root {}
    config.entities[0] = ForeignParent; config.migrateOnStart = true; config.migrations.push(first);
    const containerA = createContainer(Root);
    config.entities[0] = ProbeItemB; config.migrateOnStart = false; config.runMigrationsOnStart = false; config.migrations = [second];
    const containerB = createContainer(Root);
    config.entities[0] = ForeignChild; config.migrateOnStart = true; config.migrations.push(late);
    const lifecycle = (container: ReturnType<typeof createContainer>) => container.resolveAll(HOSTED_SERVICE).find((service) => (service as { readonly __osnvOrmLegacyLifecycle?: boolean }).__osnvOrmLegacyLifecycle === true) as unknown as { readonly __osnvLegacySchemaAuthority: boolean; readonly migrations: readonly { readonly id: string }[] };
    const a = resolveProbeContext(containerA, ProbeContextB), b = resolveProbeContext(containerB, ProbeContextB);
    expect(() => a.setOf(ForeignParent)).not.toThrow();
    expect(() => a.setOf(ProbeItemB)).toThrow(EntityNotMappedError);
    expect(() => b.setOf(ProbeItemB)).not.toThrow();
    expect(() => b.setOf(ForeignParent)).toThrow(EntityNotMappedError);
    expect({ a: { authority: lifecycle(containerA).__osnvLegacySchemaAuthority, migrations: lifecycle(containerA).migrations.map((item) => item.id) }, b: { authority: lifecycle(containerB).__osnvLegacySchemaAuthority, migrations: lifecycle(containerB).migrations.map((item) => item.id) } }).toEqual({
      a: { authority: true, migrations: [first.id] }, b: { authority: false, migrations: [second.id] },
    });
  });

  test("snapshots mixed shared migration membership and order per container without freezing callers", async () => {
    const calls = { value: 0 };
    const provider = {
      name: "migration-snapshot", dialect: { name: "migration-snapshot", supportsReturning: false }, limits: { maxParametersPerCommand: 1 },
      async query() { calls.value += 1; throw new Error("unexpected query"); }, async execute() { calls.value += 1; throw new Error("unexpected execute"); }, async transaction<T>() { calls.value += 1; throw new Error("unexpected transaction"); }, async ping() { return true; }, async introspect() { calls.value += 1; throw new Error("unexpected introspect"); }, async close() {},
    } as unknown as DatabaseProvider;
    const first = { id: "migration-snapshot-1", async up() {} }, second = { id: "migration-snapshot-2", async up() {} }, third = { id: "migration-snapshot-3", async up() {} };
    const migrations: typeof first[] = [];
    const ordinary = ormModule({ context: ProbeContextB, entities: [ProbeItemB], runMigrationsOnStart: true, migrations, registerRepositories: false });
    const owned = ormModule({ context: ProbeContextA, entities: [ProbeItemA], ownedStore: probeDefinition(), registerRepositories: false });
    @Module({ imports: [ormModule({ provider, healthCheck: false }), owned, ordinary] }) class Root {}
    const containerA = createContainer(Root);
    migrations.push(first, second);
    const containerB = createContainer(Root);
    migrations.reverse(); migrations.push(third);
    const lifecycle = (container: ReturnType<typeof createContainer>) => container.resolveAll(HOSTED_SERVICE).find((service) => (service as { readonly __osnvOrmLegacyLifecycle?: boolean }).__osnvOrmLegacyLifecycle === true) as unknown as { readonly __osnvLegacySchemaAuthority: boolean; readonly migrations: readonly { readonly id: string }[]; start(): Promise<void> };
    const a = lifecycle(containerA), b = lifecycle(containerB);
    expect(a.__osnvLegacySchemaAuthority).toBe(false);
    await a.start();
    expect(calls.value).toBe(0);
    expect({ a: a.migrations.map((item) => item.id), b: b.migrations.map((item) => item.id), caller: migrations.map((item) => item.id) }).toEqual({
      a: [], b: [first.id, second.id], caller: [second.id, first.id, third.id],
    });
  });

  test("keeps ordinary-only shared and standalone lifecycle migrations resolve-time", () => {
    const sharedMigrations = [{ id: "shared", async up() {} }];
    const shared = ormModule({ context: ProbeContextB, entities: [ProbeItemB], runMigrationsOnStart: true, migrations: sharedMigrations, registerRepositories: false });
    sharedMigrations.push({ id: "shared-late", async up() {} });
    @Module({ imports: [ormModule({ provider: recordingProvider().provider, healthCheck: false }), shared] }) class SharedRoot {}
    const sharedLifecycle = createContainer(SharedRoot).resolveAll(HOSTED_SERVICE).find((service) => (service as { readonly __osnvOrmLegacyLifecycle?: boolean }).__osnvOrmLegacyLifecycle === true) as unknown as { readonly migrations: readonly { readonly id: string }[] };
    expect(sharedLifecycle.migrations.map((item) => item.id)).toEqual(["shared", "shared-late"]);

    const standaloneMigrations = [{ id: "standalone", async up() {} }];
    const standalone = ormModule({ context: ProbeContextB, entities: [ProbeItemB], provider: recordingProvider().provider, runMigrationsOnStart: true, migrations: standaloneMigrations, registerRepositories: false, healthCheck: false });
    standaloneMigrations.push({ id: "standalone-late", async up() {} });
    @Module({ imports: [standalone] }) class StandaloneRoot {}
    const standaloneLifecycle = createContainer(StandaloneRoot).resolveAll(HOSTED_SERVICE).find((service) => (service as { readonly __osnvOrmLegacyLifecycle?: boolean }).__osnvOrmLegacyLifecycle === true) as unknown as { readonly migrations: readonly { readonly id: string }[] };
    expect(standaloneLifecycle.migrations.map((item) => item.id)).toEqual(["standalone", "standalone-late"]);
  });
});
