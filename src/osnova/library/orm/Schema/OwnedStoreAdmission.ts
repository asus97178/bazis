import type { DatabaseProvider } from "../Providers/types";
import { knownExecutionStrategyBase } from "../Saving/ExecutionStrategy";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreRegistryLockPreimageV1, canonicalOwnedStoreScopeHashV1, canonicalOwnedStoreScopeLockPreimageV1, canonicalOwnedStoreStoreLockPreimageV1, ownedStoreAdvisoryLockV1 } from "./OwnedStoreCanonical";
import { validateCheckAst, type CheckAst, type CheckScalar } from "./CheckExpression";
import type { PropertyModel } from "../Metadata/types";
import type { CanonicalDefault, GenerationStrategy } from "./introspection";
import type { ExpectedTable, OrmExpectedSchema } from "./ExpectedSchema";
import type { OwnedStoreCatalogSemanticContextV1 } from "./OwnedStoreCatalog";
import { inspectOwnedStoreCatalogPreCreateV1, parseOwnedStoreCatalogSnapshotV1, parseOwnedStoreRegistrySnapshotV1, validateFixedRegistryShapeV1, verifyOwnedStoreCatalogAllV1 } from "./OwnedStoreCatalog";
import type { OrmCatalogScopeV1, OrmOwnedStoreDefinitionV1 } from "./OrmOwnedStore";
import { isDefinedOrmOwnedStoreV1 } from "./OrmOwnedStore";
import { failure, postgresOwnedStoreCapability, type OwnedStoreCreateOperationV1, type OwnedStoreIdentityInsertV1, type OwnedStoreSecondaryLockEntryV1 } from "../Providers/ormOwnedStoreRuntime";
import { OrmOwnedStoreAdmissionError } from "../errors";
import { types } from "node:util";

export interface PreparedOwnedStoreV1 { readonly definition: Readonly<OrmOwnedStoreDefinitionV1>; readonly expected: OrmExpectedSchema; readonly ownedScopeHash: `sha256:${string}`; readonly modelHash: `sha256:${string}`; }
export interface OwnedStoreAdmissionRequestV1 { readonly stores: readonly PreparedOwnedStoreV1[]; readonly signal?: AbortSignal; }
export interface CommittedOwnedStoreAdmissionV1 {}
export interface OwnedStoreLeaseV1 { readonly active: boolean; revoke(): void; }
type Prepared = Readonly<PreparedOwnedStoreV1>;
type ReceiptState = { readonly provider: DatabaseProvider; readonly definitions: readonly Readonly<OrmOwnedStoreDefinitionV1>[]; state: "available" | "published" | "discarded"; };
const receipts = new WeakMap<object, ReceiptState>();
type LeaseState = { readonly provider: DatabaseProvider; readonly definition: Readonly<OrmOwnedStoreDefinitionV1>; readonly graph: object; active: boolean; };
const leaseStates = new WeakMap<object, LeaseState>();
const leaseCounts = new WeakMap<DatabaseProvider, WeakMap<object, number>>();
const preimages = new Map<string, Buffer>();

export async function admitOwnedStoresV1(provider: DatabaseProvider, request: OwnedStoreAdmissionRequestV1): Promise<CommittedOwnedStoreAdmissionV1> {
  const admitted = prepare(request); const prepared = admitted.prepared; const signal = admitted.signal; if (aborted(signal)) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  const base = knownExecutionStrategyBase(provider); const capability = base === undefined ? undefined : postgresOwnedStoreCapability(provider);
  if (!base || !capability) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  let done: object | undefined;
  let marker: object | undefined;
  let callbackEntries = 0;
  let callbackCompletions = 0;
  try {
    done = await capability.withOwnedStoreAdmission(signal, async session => {
      if (++callbackEntries !== 1) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      let maximum: unknown;
      try { maximum = session.maxIdentifierLength; } catch { throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
      if (typeof maximum !== "bigint") throw failure("ORM_OWNED_STORE_DRIFT");
      const context = Object.freeze({ maxIdentifierLength: maximum });
      if (context.maxIdentifierLength < 63n) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
      const definitions = prepared.map(item => item.definition);
      const registry = await operational(() => session.inspectRegistry()).then(snapshot => parseOwnedStoreRegistrySnapshotV1(snapshot, definitions, context));
      if (registry.state.kind === "present") validateFixedRegistryShapeV1(registry.state.shape);
      assertCurrent(registry, prepared);
      const rows = registry.state.kind === "present" ? registry.state.rows : [];
      const catalogueScopes = scopeUnion(prepared, []);
      const plan = lockPlan(prepared, rows);
      const locked = await session.lockSecondary(plan);
      const catalogue = await operational(() => locked.inspectCatalog(catalogueScopes)).then(snapshot => parseOwnedStoreCatalogSnapshotV1(snapshot, context));
      const semantic: OwnedStoreCatalogSemanticContextV1 = Object.freeze({ stores: Object.freeze(prepared.map(item => Object.freeze({ definition: item.definition, expectedSchema: item.expected }))), requestedScopes: catalogueScopes });
      const result = inspectOwnedStoreCatalogPreCreateV1(catalogue, registry, semantic);
      if (result.kind === "occupiedMissingIdentity") throw failure("ORM_OWNED_STORE_IDENTITY_MISSING");
      const missing = result.emptyMissingIdentityStoreKeys;
      let mutationAttempted = false;
      if (registry.state.kind === "absent") {
        try {
          mutationAttempted = true; await locked.createRegistryV1();
        } catch { throw failure("ORM_OWNED_STORE_CREATE_FAILED"); }
        try { const reread = parseOwnedStoreRegistrySnapshotV1(await operational(() => locked.inspectRegistry()), definitions, context);
          if (reread.state.kind !== "present" || reread.state.rows.length) throw failure("ORM_OWNED_STORE_CREATE_FAILED"); validateFixedRegistryShapeV1(reread.state.shape);
        } catch (error) { throw createFailure(error); }
      }
      if (missing.length) {
        try {
          mutationAttempted = true; await locked.applyCreateOperations(createPlan(prepared.filter(item => missing.includes(item.definition.storeKey)), catalogue.existingSchemas));
        } catch { throw failure("ORM_OWNED_STORE_CREATE_FAILED"); }
        try {
          verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(await operational(() => locked.inspectCatalog(catalogueScopes)), context), semantic);
        } catch (error) { throw createFailure(error); }
        try { mutationAttempted = true; await locked.insertIdentities(identityRows(prepared.filter(item => missing.includes(item.definition.storeKey)))); }
        catch { throw failure("ORM_OWNED_STORE_CREATE_FAILED"); }
      } else verifyOwnedStoreCatalogAllV1(catalogue, semantic);
      let final: ReturnType<typeof parseOwnedStoreRegistrySnapshotV1>;
      let finalRaw: Awaited<ReturnType<typeof locked.inspectRegistry>>;
      try { finalRaw = await operational(() => locked.inspectRegistry()); }
      catch (error) { throw mutationAttempted ? createFailure(error) : safe(error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
      try { final = parseOwnedStoreRegistrySnapshotV1(finalRaw, definitions, context); }
      catch (error) { throw mutationAttempted ? createFailure(error) : safe(error, "ORM_OWNED_STORE_DRIFT"); }
      try {
        if (final.state.kind !== "present") throw failure(mutationAttempted ? "ORM_OWNED_STORE_CREATE_FAILED" : "ORM_OWNED_STORE_DRIFT"); validateFixedRegistryShapeV1(final.state.shape); assertCurrent(final, prepared);
        if (final.state.rows.filter(row => prepared.some(item => item.definition.storeKey === row.storeKey)).length !== prepared.length) throw failure(mutationAttempted ? "ORM_OWNED_STORE_CREATE_FAILED" : "ORM_OWNED_STORE_DRIFT");
        if (!final.publicSchemaExists) throw failure(mutationAttempted ? "ORM_OWNED_STORE_CREATE_FAILED" : "ORM_OWNED_STORE_DRIFT");
      } catch (error) { throw mutationAttempted ? createFailure(error) : safe(error, "ORM_OWNED_STORE_DRIFT"); }
      if (++callbackCompletions !== 1 || callbackEntries !== 1) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
      marker = Object.freeze({}); return marker;
    });
  } catch (error) { throw callbackCompletions === 1 ? failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE") : safe(error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
  if (!done || done !== marker || callbackEntries !== 1 || callbackCompletions !== 1) throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  const receipt = Object.freeze({}) as CommittedOwnedStoreAdmissionV1; receipts.set(receipt, { provider: base, definitions: Object.freeze(prepared.map(item => item.definition)), state: "available" });
  if (aborted(signal)) { discardOwnedStoreAdmissionV1(receipt); throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }
  return receipt;
}
export function publishOwnedStoreAdmissionV1(provider: DatabaseProvider, receipt: CommittedOwnedStoreAdmissionV1): readonly OwnedStoreLeaseV1[] { const base = knownExecutionStrategyBase(provider); if (!base) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); const state = receipts.get(receipt as object); if (!state) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); if (base !== state.provider) throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); if (state.state !== "available") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); state.state = "published"; return Object.freeze(state.definitions.map(definition => lease(base, definition, receipt as object))); }
export function discardOwnedStoreAdmissionV1(receipt: CommittedOwnedStoreAdmissionV1): void { const state = receipts.get(receipt as object); if (!state || state.state !== "available") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); state.state = "discarded"; }

function prepare(request: OwnedStoreAdmissionRequestV1): { readonly prepared: readonly Prepared[]; readonly signal: AbortSignal | undefined } { try { const root=own(request,["stores","signal"],["stores"]), stores=ownArray(root.stores,128); if (!stores.length) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const signal=root.signal===undefined?undefined:admitSignal(root.signal); const keys = new Set<string>(); const out = stores.map(value => { const item=own(value,["definition","expected","ownedScopeHash","modelHash"]); if (!isDefinedOrmOwnedStoreV1(item.definition)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const definition=item.definition as Readonly<OrmOwnedStoreDefinitionV1>; if (keys.has(definition.storeKey)) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); keys.add(definition.storeKey); if ([definition.ownedScope, ...(definition.rejectIfPresent ?? [])].some(scopeClaimsRegistry)) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); if ((definition.rejectIfPresent ?? []).some(scope => overlap(definition.ownedScope, scope))) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); const expected = cloneExpected(item.expected as OrmExpectedSchema); if (!expected.tables.every((table) => table.schema === definition.ownedScope.schema && table.table.startsWith(definition.ownedScope.tablePrefix))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); if (canonicalOwnedStoreScopeHashV1(definition) !== item.ownedScopeHash || canonicalOwnedStoreModelHashV1(definition, expected) !== item.modelHash) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); return Object.freeze({ definition, expected, ownedScopeHash: item.ownedScopeHash as `sha256:${string}`, modelHash: item.modelHash as `sha256:${string}` }); }); const owners = new Map<ExpectedTable, number>(); out.forEach((item, index) => item.expected.tables.forEach(table => owners.set(table, index))); validateExpected(out.flatMap(item => item.expected.tables), owners); for (const a of out) for (const b of out) if ((a !== b && overlap(a.definition.ownedScope, b.definition.ownedScope)) || [b.definition.ownedScope, ...(b.definition.rejectIfPresent ?? [])].some(scope => overlap(a.definition.ownedScope, scope) && (a !== b || scope !== a.definition.ownedScope))) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); return Object.freeze({prepared:Object.freeze(out.sort((a,b) => compareScope(a.definition.ownedScope,b.definition.ownedScope) || Buffer.compare(Buffer.from(a.definition.storeKey),Buffer.from(b.definition.storeKey)) || a.definition.formatVersion-b.definition.formatVersion)),signal}); } catch (error) { throw safe(error,"ORM_OWNED_STORE_IDENTITY_MISMATCH"); } }
function scopeClaimsRegistry(scope: OrmCatalogScopeV1): boolean { return scope.schema === "public" && ["__osnova_orm_owned_stores_v1", "__osnova_orm_owned_stores_v1_pkey"].some(relation => relation.startsWith(scope.tablePrefix)); }
function admitSignal(value: unknown): AbortSignal { if (value === null || (typeof value !== "object" && typeof value !== "function") || types.isProxy(value)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get; try { if (!getter || typeof getter.call(value) !== "boolean") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); } catch { throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); } return value as AbortSignal; }
function cloneExpected(expected: OrmExpectedSchema): OrmExpectedSchema {
  const charge = new SnapshotCharge();
  const root = own(expected, ["tables"]), tables = ownArray(root.tables, 512);
  if (!tables.length) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  charge.add(4); // model record, contract, formatVersion and tables array.
  const copied = Object.freeze(tables.map((value): ExpectedTable => {
    charge.add(7); // table record, schema, table and the four non-PK collections.
    const table = own(value, ["schema", "table", "columns", "primaryKey", "indexes", "foreignKeys", "checks"]);
    const columns = Object.freeze(ownArray(table.columns, 65536).map((column): ExpectedTable["columns"][number] => {
      charge.add(5); // record, column, physicalType, nullable, generation.
      const item = own(column, ["property", "column", "physicalType", "nullable", "default", "generation"]);
      const physicalType = item.physicalType;
      if (!identifier(item.property) || !identifier(item.column) || typeof physicalType !== "string" || !["integer", "real", "text", "boolean", "datetime", "json", "uuid"].includes(physicalType) || typeof item.nullable !== "boolean") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
      return Object.freeze({ property: item.property, column: item.column, physicalType, nullable: item.nullable, default: cloneDefault(item.default, charge), generation: cloneGeneration(item.generation) });
    }));
    const primaryKey = own(table.primaryKey, ["name", "columns"]);
    if (!identifier(table.schema) || !identifier(table.table) || !identifier(primaryKey.name)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    charge.add(2); // primary-key record and name; columns charges its array.
    return Object.freeze({
      schema: table.schema, table: table.table, columns,
      primaryKey: Object.freeze({ name: primaryKey.name, columns: strings(primaryKey.columns, charge) }),
      indexes: Object.freeze(ownArray(table.indexes, 65536).map((index): ExpectedTable["indexes"][number] => {
        charge.add(4); // record, name, unique, method; columns charges its array.
        const item = own(index, ["name", "columns", "unique", "method"]);
        if (!identifier(item.name) || typeof item.unique !== "boolean" || item.method !== "btree") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
        return Object.freeze({ name: item.name, columns: strings(item.columns, charge), unique: item.unique, method: "btree" });
      })),
      foreignKeys: Object.freeze(ownArray(table.foreignKeys, 65536).map((foreignKey): ExpectedTable["foreignKeys"][number] => {
        charge.add(6); // record, name, target schema/table, delete/update; arrays charge themselves.
        const item = own(foreignKey, ["name", "columns", "target", "targetColumns", "onDelete", "onUpdate"]), target = own(item.target, ["schema", "table"]);
        if (!identifier(item.name) || !identifier(target.schema) || !identifier(target.table) || typeof item.onDelete !== "string" || typeof item.onUpdate !== "string") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
        return Object.freeze({ name: item.name, columns: strings(item.columns, charge), target: Object.freeze({ schema: target.schema, table: target.table }), targetColumns: strings(item.targetColumns, charge), onDelete: item.onDelete, onUpdate: item.onUpdate });
      })),
      checks: Object.freeze(ownArray(table.checks, 65536).map((check): ExpectedTable["checks"][number] => {
        charge.add(2); // check record and name.
        const item = own(check, ["name", "expression"]); if (!identifier(item.name)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); return Object.freeze({ name: item.name, expression: cloneCheck(item.expression, 1, { nodes: 0, active: new Set<object>() }, charge) });
      })),
    });
  }));
  return Object.freeze({ tables: copied });
}
class SnapshotCharge { private nodes = 0; add(amount = 1): void { this.nodes += amount; if (this.nodes > 1_000_000) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); } }
function strings(value: unknown, charge: SnapshotCharge): readonly string[] { const result = ownArray(value, 65536); if (!result.length || result.some((entry) => !identifier(entry)) || new Set(result).size !== result.length) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); charge.add(1 + result.length); return Object.freeze(result as string[]); }
function identifier(value: unknown): value is string { return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 63 && !/[\0-\x1f\x7f-\x9f]/u.test(value) && !/[\ud800-\udfff]/u.test(value); }
function cloneGeneration(value: unknown): GenerationStrategy { if (value !== "none" && value !== "identityByDefault" && value !== "uuidDefault") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); return value; }
function cloneDefault(value: unknown, charge: SnapshotCharge): CanonicalDefault { const item = own(value, ["kind", "value"], ["kind"]); if (item.kind === "none" || item.kind === "null" || item.kind === "currentTimestamp" || item.kind === "uuidV4") { if (Object.hasOwn(item, "value")) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); charge.add(2); return Object.freeze({ kind: item.kind }); } if (item.kind === "boolean" && typeof item.value === "boolean") { charge.add(3); return Object.freeze({ kind: item.kind, value: item.value }); } if (item.kind === "number" && typeof item.value === "number" && Number.isFinite(item.value)) { charge.add(3); return Object.freeze({ kind: item.kind, value: item.value }); } if (item.kind === "string" && typeof item.value === "string" && item.value.length <= 1024 && !/[\ud800-\udfff]/u.test(item.value)) { charge.add(3); return Object.freeze({ kind: item.kind, value: item.value }); } throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); }
function scalar(value: unknown): value is CheckScalar { return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) || (typeof value === "string" && value.length <= 1024 && !/[\ud800-\udfff]/u.test(value)); }
function cloneCheck(value: unknown, depth: number, state: { nodes: number; active: Set<object> }, charge: SnapshotCharge): CheckAst {
  if (depth > 64 || ++state.nodes > 4096 || value === null || typeof value !== "object" || state.active.has(value)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  state.active.add(value);
  try {
    const tag = kindOf(value);
    if (tag.kind === "compare") { const item = own(value, ["kind", "op", "left", "right"]); const op = item.op; if (!identifier(item.left) || (op !== "=" && op !== "<>" && op !== ">" && op !== ">=" && op !== "<" && op !== "<=") || !(scalar(item.right) || (typeof item.right === "string" && item.right.startsWith("\0") && identifier(item.right.slice(1))))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); charge.add(7); return Object.freeze({ kind: "compare", op, left: item.left, right: item.right as string | CheckScalar }); }
    if (tag.kind === "in") { const item = own(value, ["kind", "left", "values"]); if (!identifier(item.left)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const values = ownArray(item.values, 100); if (!values.length || values.some((entry) => !scalar(entry))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); charge.add(4 + values.length); return Object.freeze({ kind: "in", left: item.left, values: Object.freeze(values as CheckScalar[]) }); }
    if (tag.kind === "null") { const item = own(value, ["kind", "left", "not"]); if (!identifier(item.left) || typeof item.not !== "boolean") throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); charge.add(4); return Object.freeze({ kind: "null", left: item.left, not: item.not }); }
    if (tag.kind === "and" || tag.kind === "or") { const item = own(value, ["kind", "left", "right"]); charge.add(2); return Object.freeze({ kind: tag.kind, left: cloneCheck(item.left, depth + 1, state, charge), right: cloneCheck(item.right, depth + 1, state, charge) }); }
    if (tag.kind === "not") { const item = own(value, ["kind", "inner"]); charge.add(2); return Object.freeze({ kind: "not", inner: cloneCheck(item.inner, depth + 1, state, charge) }); }
    throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  } finally { state.active.delete(value); }
}
function kindOf(value: unknown): { readonly kind: unknown } { if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const descriptor = Object.getOwnPropertyDescriptor(value, "kind"); if (!descriptor || !("value" in descriptor)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); return Object.freeze({ kind: descriptor.value }); }
function validateExpected(tables: readonly ExpectedTable[], owners: ReadonlyMap<ExpectedTable, number>): void {
  const registryRelations = new Set(["public\0__osnova_orm_owned_stores_v1", "public\0__osnova_orm_owned_stores_v1_pkey"]);
  const relations = new Set(registryRelations);
  for (const table of tables) {
    const relation = `${table.schema}\0${table.table}`;
    if (relations.has(relation)) throw failure(registryRelations.has(relation) ? "ORM_OWNED_STORE_OWNERSHIP_CONFLICT" : "ORM_OWNED_STORE_IDENTITY_MISMATCH");
    relations.add(relation);
    const columns = new Map(table.columns.map(column => [column.column, column]));
    if (columns.size !== table.columns.length || !table.primaryKey.columns.length || !table.primaryKey.columns.every(column => columns.has(column))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    const pk = table.primaryKey.columns.map(column => columns.get(column)!);
    if (pk.some(column => column.nullable)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    const names = new Set([table.primaryKey.name]);
    for (const name of [table.primaryKey.name, ...table.indexes.map(index => index.name)]) {
      const key = `${table.schema}\0${name}`;
      if (relations.has(key)) throw failure(registryRelations.has(key) ? "ORM_OWNED_STORE_OWNERSHIP_CONFLICT" : "ORM_OWNED_STORE_IDENTITY_MISMATCH");
      relations.add(key);
    }
    for (const column of table.columns) {
      const generated = column.generation !== "none";
      const isPk = table.primaryKey.columns.includes(column.column);
      const def = column.default;
      if (generated && !isPk ||
        column.generation === "identityByDefault" && (pk.length !== 1 || column.physicalType !== "integer" || def.kind !== "none") ||
        column.generation === "uuidDefault" && (pk.length !== 1 || !isPk || column.physicalType !== "uuid" || def.kind !== "uuidV4") ||
        column.generation === "none" && isPk && def.kind !== "none" ||
        def.kind === "uuidV4" && !(column.generation === "uuidDefault" && pk.length === 1 && isPk && column.physicalType === "uuid") ||
        column.physicalType === "uuid" && column.generation !== "uuidDefault" ||
        def.kind === "currentTimestamp" ||
        def.kind === "null" && !column.nullable ||
        def.kind === "boolean" && !["boolean", "json"].includes(column.physicalType) ||
        def.kind === "number" && (!["integer", "real", "json"].includes(column.physicalType) || column.physicalType === "integer" && !Number.isSafeInteger(def.value)) ||
        def.kind === "string" && (!["text", "datetime", "json"].includes(column.physicalType) || column.physicalType === "datetime" && !rfc3339(def.value))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    }
    for (const index of table.indexes) if (!index.columns.every(column => columns.has(column))) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    for (const check of table.checks) {
      if (names.has(check.name)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
      names.add(check.name);
      try { validateCheckAst(check.expression as CheckAst, propertyProjection(table, pk)); } catch { throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); }
      const ast = check.expression as CheckAst;
      checkColumns(ast).forEach(column => { if (!columns.has(column)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); });
      checkPhysicalTypes(ast, columns);
    }
    for (const fk of table.foreignKeys) {
      if (names.has(fk.name)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
      names.add(fk.name);
      const target = tables.find(candidate => candidate.schema === fk.target.schema && candidate.table === fk.target.table);
      if (!target || owners.get(target) !== owners.get(table) || !fk.columns.length || fk.columns.length !== fk.targetColumns.length || !fk.columns.every(column => columns.has(column)) || fk.targetColumns.join("\0") !== target.primaryKey.columns.join("\0") || !["noAction", "restrict", "cascade", "setNull"].includes(fk.onDelete) || !["noAction", "restrict", "cascade", "setNull"].includes(fk.onUpdate)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
      const source = fk.columns.map(column => columns.get(column)!);
      const targetColumns = fk.targetColumns.map(column => target.columns.find(entry => entry.column === column));
      if (targetColumns.some(column => !column) || source.some((column, index) => column.physicalType !== targetColumns[index]!.physicalType) || new Set(source.map(column => column.nullable)).size > 1 || (fk.onDelete === "setNull" || fk.onUpdate === "setNull") && !source.every(column => column.nullable)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    }
  }
}
function propertyProjection(table: ExpectedTable, primaryKey: readonly ExpectedTable["columns"][number][]): readonly PropertyModel[] {
  const keys = new Set(primaryKey.map(column => column.column));
  return table.columns.map(column => Object.freeze({ propertyName: column.column, columnName: column.column, type: checkPropertyType(column.physicalType), isKey: keys.has(column.column), generation: "none", required: !column.nullable, databaseDefault: column.default }));
}
function checkPropertyType(physicalType: string): PropertyModel["type"] { switch (physicalType) { case "integer": case "real": case "text": case "boolean": case "datetime": case "json": return physicalType; case "uuid": return "text"; default: throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); } }
function rfc3339(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  if ([year, month, day, hour, minute, second, zone].some(value => value === undefined)) return false;
  const numeric: readonly [number, number, number, number, number, number] = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)];
  if (numeric[1] < 1 || numeric[1] > 12 || numeric[2] < 1 || numeric[3] > 23 || numeric[4] > 59 || numeric[5] > 59) return false;
  if (numeric[2] > new Date(Date.UTC(numeric[0], numeric[1], 0)).getUTCDate()) return false;
  if (zone !== "Z") { const [offsetHourText, offsetMinuteText] = zone!.slice(1).split(":"); if (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59) return false; }
  return true;
}
function checkPhysicalTypes(ast:CheckAst,columns:ReadonlyMap<string,ExpectedTable["columns"][number]>):void{if(ast.kind==="compare"&&typeof ast.right==="string"&&ast.right.startsWith("\0")&&columns.get(ast.left)?.physicalType!==columns.get(ast.right.slice(1))?.physicalType)throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");if(ast.kind==="and"||ast.kind==="or"){checkPhysicalTypes(ast.left,columns);checkPhysicalTypes(ast.right,columns);}if(ast.kind==="not")checkPhysicalTypes(ast.inner,columns);}
function checkColumns(ast: CheckAst): readonly string[] { switch (ast.kind) { case "compare": return [ast.left, ...(typeof ast.right === "string" && ast.right.startsWith("\0") ? [ast.right.slice(1)] : [])]; case "in": case "null": return [ast.left]; case "and": case "or": return [...checkColumns(ast.left), ...checkColumns(ast.right)]; case "not": return checkColumns(ast.inner); } }
function own(value:unknown,keys:readonly string[],required=keys):Record<string,unknown>{if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.getOwnPropertySymbols(value).length)throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.keys(descriptors).some(key=>!keys.includes(key)||!("value" in descriptors[key]!))||required.some(key=>!Object.hasOwn(descriptors,key)))throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");return Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,(descriptor as PropertyDescriptor&{value:unknown}).value]));}
function ownArray(value:unknown,max:number):unknown[]{if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length||value.length>max)throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");const descriptors=Object.getOwnPropertyDescriptors(value),expected=new Set(["length",...Array.from({length:value.length},(_,index)=>String(index))]);for(let i=0;i<value.length;i++)if(!descriptors[String(i)]||!("value" in descriptors[String(i)]!))throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");if(Object.keys(descriptors).some(key=>!expected.has(key)))throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");return Array.from({length:value.length},(_,i)=>(descriptors[String(i)] as PropertyDescriptor&{value:unknown}).value);}
function assertCurrent(registry: ReturnType<typeof parseOwnedStoreRegistrySnapshotV1>, prepared: readonly Prepared[]): void { if (registry.state.kind === "present") { const scopes: OrmCatalogScopeV1[]=[]; for (const row of registry.state.rows) { const current=prepared.find(item=>item.definition.storeKey===row.storeKey); if(current && (row.modelHash!==current.modelHash || row.ownedScopeHash!==current.ownedScopeHash || row.ownedSchema!==current.definition.ownedScope.schema || row.tablePrefix!==current.definition.ownedScope.tablePrefix || Number(row.formatVersion)!==current.definition.formatVersion)) throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH"); const scope={schema:row.ownedSchema,tablePrefix:row.tablePrefix}; if(scopes.some(other=>overlap(other,scope))) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); scopes.push(scope); } for(const item of prepared) for(const scope of scopes) if(!(scope.schema===item.definition.ownedScope.schema&&scope.tablePrefix===item.definition.ownedScope.tablePrefix) && overlap(scope,item.definition.ownedScope)) throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); } }
function scopeUnion(prepared:readonly Prepared[],rows:readonly {readonly ownedSchema:string;readonly tablePrefix:string}[]):readonly OrmCatalogScopeV1[]{const all=[...prepared.flatMap(item=>[item.definition.ownedScope,...(item.definition.rejectIfPresent??[])]),...rows.map(row=>({schema:row.ownedSchema,tablePrefix:row.tablePrefix}))].sort(compareScope);return Object.freeze(all.filter((x,i)=>!i||x.schema!==all[i-1]!.schema||x.tablePrefix!==all[i-1]!.tablePrefix));}
function lockPlan(prepared:readonly Prepared[],rows:readonly {readonly storeKey:string;readonly ownedSchema:string;readonly tablePrefix:string;readonly formatVersion:string}[]){const definitions=[...prepared.map(item=>item.definition),...rows.map(row=>({contract:"osnova.orm-owned-store/v1" as const,storeKey:row.storeKey,formatVersion:Number(row.formatVersion),ownedScope:{schema:row.ownedSchema,tablePrefix:row.tablePrefix}}))].sort(compareDefinition);const scopes=[...prepared.flatMap(item=>[item.definition.ownedScope,...(item.definition.rejectIfPresent??[])]),...rows.map(row=>({schema:row.ownedSchema,tablePrefix:row.tablePrefix}))].sort(compareScope);remember(canonicalOwnedStoreRegistryLockPreimageV1());return Object.freeze({stores:lockEntries("store",definitions.map(canonicalOwnedStoreStoreLockPreimageV1)),scopes:lockEntries("scope",scopes.map(canonicalOwnedStoreScopeLockPreimageV1))});}
function lockEntries(kind:"store"|"scope",values:readonly Buffer[]):readonly OwnedStoreSecondaryLockEntryV1[]{const unique=new Map<string,Buffer>();for(const preimage of values)unique.set(preimage.toString("hex"),preimage);return Object.freeze([...unique.values()].map(preimage=>{const key=remember(preimage);return Object.freeze({kind,preimage:Buffer.from(preimage),key});}));}
function remember(preimage:Buffer):bigint{const key=ownedStoreAdvisoryLockV1(preimage),prior=preimages.get(key.toString());if(prior&&!prior.equals(preimage))throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");preimages.set(key.toString(),Buffer.from(preimage));return key;}
function createPlan(prepared:readonly Prepared[],existingSchemas:readonly string[]):readonly OwnedStoreCreateOperationV1[]{const existing=new Set(existingSchemas);const schemas=[...new Set(prepared.map(item=>item.definition.ownedScope.schema).filter(schema=>!existing.has(schema)))].sort(compareText);const tables=prepared.flatMap(item=>item.expected.tables).sort(compareTable);const foreignKeys=tables.flatMap(table=>table.foreignKeys.map(foreignKey=>({table,foreignKey}))).sort((a,b)=>compareTable(a.table,b.table)||compareText(a.foreignKey.name,b.foreignKey.name));const indexes=tables.flatMap(table=>table.indexes.map(index=>({table,index}))).sort((a,b)=>compareTable(a.table,b.table)||compareText(a.index.name,b.index.name));return Object.freeze([...schemas.map(schema=>Object.freeze({kind:"createSchema" as const,schema})),...tables.map(table=>Object.freeze({kind:"createTable" as const,table})),...foreignKeys.map(({table,foreignKey})=>Object.freeze({kind:"addForeignKey" as const,table,foreignKey})),...indexes.map(({table,index})=>Object.freeze({kind:"createIndex" as const,table,index}))]);}
function identityRows(prepared:readonly Prepared[]):readonly OwnedStoreIdentityInsertV1[]{return Object.freeze([...prepared].sort((a,b)=>Buffer.compare(Buffer.from(a.definition.storeKey),Buffer.from(b.definition.storeKey))).map(item=>Object.freeze({storeKey:item.definition.storeKey,contract:"osnova.orm-owned-store/v1" as const,formatVersion:item.definition.formatVersion,ownedSchema:item.definition.ownedScope.schema,tablePrefix:item.definition.ownedScope.tablePrefix,ownedScopeHash:item.ownedScopeHash,modelHash:item.modelHash})));}
function lease(provider:DatabaseProvider,definition:Readonly<OrmOwnedStoreDefinitionV1>,graph:object):OwnedStoreLeaseV1{let counts=leaseCounts.get(provider);if(!counts){counts=new WeakMap();leaseCounts.set(provider,counts);}counts.set(definition,(counts.get(definition)??0)+1);let lease:OwnedStoreLeaseV1;lease=Object.freeze({get active():boolean{return leaseStates.get(lease)?.active===true;},revoke():void{const state=leaseStates.get(lease);if(!state||!state.active)return;state.active=false;const count=counts!.get(state.definition)??0;if(count<=1)counts!.delete(state.definition);else counts!.set(state.definition,count-1);}});leaseStates.set(lease,{provider,definition,graph,active:true});return lease;}
function aborted(signal:AbortSignal|undefined):boolean{if(!signal)return false;const getter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")?.get;if(!getter)throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");try{return getter.call(signal);}catch{throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE");}}
function compareText(a:string,b:string):number{return Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8"));}function compareScope(a:OrmCatalogScopeV1,b:OrmCatalogScopeV1):number{return compareText(a.schema,b.schema)||compareText(a.tablePrefix,b.tablePrefix);}function compareDefinition(a:OrmOwnedStoreDefinitionV1,b:OrmOwnedStoreDefinitionV1):number{return compareScope(a.ownedScope,b.ownedScope)||compareText(a.storeKey,b.storeKey)||a.formatVersion-b.formatVersion;}function compareTable(a:ExpectedTable,b:ExpectedTable):number{return compareText(a.schema,b.schema)||compareText(a.table,b.table);}function overlap(a:OrmCatalogScopeV1,b:OrmCatalogScopeV1):boolean{return a.schema===b.schema&&(a.tablePrefix.startsWith(b.tablePrefix)||b.tablePrefix.startsWith(a.tablePrefix));}async function operational<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){throw safe(error,"ORM_OWNED_STORE_LOCK_UNAVAILABLE");}}function createFailure(error:unknown):OrmOwnedStoreAdmissionError{const admitted=safe(error,"ORM_OWNED_STORE_CREATE_FAILED");return admitted.code==="ORM_OWNED_STORE_OWNERSHIP_CONFLICT"||admitted.code==="ORM_OWNED_STORE_LOCK_UNAVAILABLE"?admitted:failure("ORM_OWNED_STORE_CREATE_FAILED");}function safe(error:unknown,fallback:OrmOwnedStoreAdmissionError["code"]):OrmOwnedStoreAdmissionError{try{if(error===null||typeof error!=="object"||types.isProxy(error)||Object.getPrototypeOf(error)!==OrmOwnedStoreAdmissionError.prototype)return failure(fallback);const code=Object.getOwnPropertyDescriptor(error,"code"),message=Object.getOwnPropertyDescriptor(error,"message");const known=["ORM_OWNED_STORE_PROVIDER_UNSUPPORTED","ORM_OWNED_STORE_LOCK_UNAVAILABLE","ORM_OWNED_STORE_IDENTITY_MISSING","ORM_OWNED_STORE_IDENTITY_MISMATCH","ORM_OWNED_STORE_OWNERSHIP_CONFLICT","ORM_OWNED_STORE_DRIFT","ORM_OWNED_STORE_CREATE_FAILED"];if(!code||!("value"in code)||!message||!("value"in message)||typeof code.value!=="string"||code.value!==message.value||!known.includes(code.value))return failure(fallback);return failure(code.value as OrmOwnedStoreAdmissionError["code"]);}catch{return failure(fallback);}}
