import {
  createModuleOwnedMetadataChannel,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  type ModuleOwnedContributionSnapshot,
  type BazisModuleMetadata,
} from "../di";
import { OrmModel, type DbContext, type OrmOwnedStoreDefinitionV1 } from "../../library/orm";
import { compileExpectedSchema, type OrmExpectedSchema } from "../../library/orm/Schema/ExpectedSchema";
import { isDefinedOrmOwnedStoreV1 } from "../../library/orm/Schema/OrmOwnedStore";
import { defineOrmOwnedStoreV1 } from "../../library/orm/Schema/OrmOwnedStore";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreScopeHashV1 } from "../../library/orm/Schema/OwnedStoreCanonical";
import { OrmOwnedStoreAdmissionError } from "../../library/orm";

type EntityClass = new () => object;
type ContextClass<TContext extends DbContext> = new (...args: never[]) => TContext;

export interface OwnedStoreRegistration<TContext extends DbContext = DbContext> {
  readonly identity: object;
  readonly context: ContextClass<TContext>;
  readonly entities: readonly EntityClass[];
  readonly definition: Readonly<OrmOwnedStoreDefinitionV1>;
  readonly expected: OrmExpectedSchema;
  readonly source: unknown;
}
interface OrmGraphContribution {
  readonly identity: object;
  readonly context: ContextClass<DbContext>;
  readonly entities: readonly EntityClass[];
  /** Direct ordinary registrations retain this source until owned-mode preflight. */
  readonly config?: object;
  readonly owned?: OwnedStoreRegistration;
}

interface CompiledOwnedStoreGraph {
  readonly records: readonly OwnedStoreRegistration[];
  readonly effectiveConfigs: ReadonlyMap<object, object>;
}

const PAYLOAD = Symbol("bazis.orm.owned-store");
const CHANNEL = createModuleOwnedMetadataChannel<OrmGraphContribution>("orm.owned-store");
const compiled = new WeakMap<object, CompiledOwnedStoreGraph>();

/** Names here come from the application's own declarations, never from the database. */
function fail(code: "ORM_OWNED_STORE_IDENTITY_MISMATCH" | "ORM_OWNED_STORE_OWNERSHIP_CONFLICT", reason?: string): never {
  throw new OrmOwnedStoreAdmissionError(code, reason === undefined ? code : `${code}: ${reason}.`);
}
const storeName = (definition: Readonly<OrmOwnedStoreDefinitionV1>) => `Owned store "${definition.storeKey}" (schema "${definition.ownedScope.schema}", prefix "${definition.ownedScope.tablePrefix}")`;
const scopeName = (scope: { readonly schema: string; readonly tablePrefix: string }) => `schema "${scope.schema}", prefix "${scope.tablePrefix}"`;
const OVERLAP_HINT = "two prefixes overlap when one starts with the other, so \"notes_\" and \"notes_v2_\" overlap while \"notes_\" and \"notesv2_\" do not";

function overlaps(a: { readonly schema: string; readonly tablePrefix: string }, b: { readonly schema: string; readonly tablePrefix: string }): boolean {
  return a.schema === b.schema && (a.tablePrefix.startsWith(b.tablePrefix) || b.tablePrefix.startsWith(a.tablePrefix));
}

function snapshot<TContext extends DbContext>(context: ContextClass<TContext>, entities: readonly EntityClass[], source: unknown): OwnedStoreRegistration<TContext> {
  const definition = isDefinedOrmOwnedStoreV1(source) ? source : defineOrmOwnedStoreV1(source as OrmOwnedStoreDefinitionV1);
  const expected = compileExpectedSchema(new OrmModel(entities));
  if (expected.tables.length === 0 || expected.tables.length > 512) fail("ORM_OWNED_STORE_IDENTITY_MISMATCH", `${storeName(definition)} needs 1 to 512 entities, got ${expected.tables.length}`);
  for (const table of expected.tables) {
    const partial = table.indexes.find((index) => index.predicate !== undefined);
    if (partial) fail("ORM_OWNED_STORE_IDENTITY_MISMATCH", `${storeName(definition)}: index "${partial.name}" on "${table.table}" has a where condition; owned stores do not support partial indexes`);
  }
  return Object.freeze({ identity: Object.freeze({}), context, entities: Object.freeze([...entities]), definition, expected, source });
}

/** @internal Attaches an opaque, non-enumerable payload to the exact ORM module ref. */
export function attachOwnedStoreRegistration<TContext extends DbContext>(
  module: BazisModuleMetadata,
  context: ContextClass<TContext>,
  entities: readonly EntityClass[],
  source: unknown,
): OwnedStoreRegistration<TContext> {
  const registration = snapshot(context, entities, source);
  Object.defineProperty(module, PAYLOAD, { value: Object.freeze({ identity: registration.identity, context, entities: Object.freeze([...entities]), owned: registration } satisfies OrmGraphContribution), enumerable: false, configurable: false, writable: false });
  return registration;
}

/** @internal Ordinary ORM contexts join the opaque graph only when an owned store exists. */
export function attachOrmGraphContribution<TContext extends DbContext>(module: BazisModuleMetadata, context: ContextClass<TContext>, entities: readonly EntityClass[], config?: object, identity = Object.freeze({})): object {
  Object.defineProperty(module, PAYLOAD, { value: Object.freeze({ identity, context, entities: Object.freeze([...entities]), config } satisfies OrmGraphContribution), enumerable: false, configurable: false, writable: false });
  return identity;
}

export function readOwnedStoreRegistration(module: BazisModuleMetadata): OwnedStoreRegistration | undefined {
  return (module as { readonly [PAYLOAD]?: OrmGraphContribution })[PAYLOAD]?.owned;
}

export function revalidateOwnedStoreRegistration(registration: OwnedStoreRegistration): void {
  if (!isDefinedOrmOwnedStoreV1(registration.definition) || !Array.isArray(registration.entities) || registration.entities.length === 0) fail("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  const current = snapshot(registration.context, registration.entities, registration.source);
  // A raw descriptor is intentionally canonicalized once per registration;
  // re-reading it creates an equal fresh nominal clone. Helper-branded input
  // retains identity, while raw input is compared through the frozen canonical
  // fields rather than accidentally rejected on every container build.
  const sameDefinition = current.definition.contract === registration.definition.contract
    && current.definition.storeKey === registration.definition.storeKey
    && current.definition.formatVersion === registration.definition.formatVersion
    && current.definition.ownedScope.schema === registration.definition.ownedScope.schema
    && current.definition.ownedScope.tablePrefix === registration.definition.ownedScope.tablePrefix
    && JSON.stringify(current.definition.rejectIfPresent ?? []) === JSON.stringify(registration.definition.rejectIfPresent ?? []);
  if (!sameDefinition || current.expected.tables.length !== registration.expected.tables.length) fail("ORM_OWNED_STORE_IDENTITY_MISMATCH", `${storeName(registration.definition)}: its definition or entities changed after the module was declared; declare them once`);
  for (let index = 0; index < current.expected.tables.length; index += 1) {
    const before = registration.expected.tables[index];
    const after = current.expected.tables[index];
    if (before?.schema !== after?.schema || before?.table !== after?.table) fail("ORM_OWNED_STORE_IDENTITY_MISMATCH", `${storeName(registration.definition)}: its entities changed after the module was declared; declare them once`);
  }
}

export function ownedStoreRegistrations(snapshot: ModuleOwnedContributionSnapshot): readonly OwnedStoreRegistration[] {
  const contributions = snapshot.getMetadataContributions(CHANNEL);
  const cached = compiled.get(contributions as object);
  if (cached) return cached.records;
  const graph = contributions.map((entry) => entry.payload);
  const records = graph.flatMap((entry) => entry.owned === undefined ? [] : [entry.owned]);
  if (records.length === 0) return Object.freeze([]);
  if (records.length > 128) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `An application may declare at most 128 owned stores, got ${records.length}`);
  const keys = new Set<string>();
  const tables = new Set<string>();
  for (const record of records) {
    revalidateOwnedStoreRegistration(record);
    if (record.definition.ownedScope.schema === "public"
      && ["__bazis_orm_owned_stores_v1", "__bazis_orm_owned_stores_v1_pkey"].some((name) => name.startsWith(record.definition.ownedScope.tablePrefix))) {
      fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)} would own the bazis registry table __bazis_orm_owned_stores_v1; choose another tablePrefix`);
    }
    if ((record.definition.rejectIfPresent ?? []).some((scope) => scope.schema === "public"
      && ["__bazis_orm_owned_stores_v1", "__bazis_orm_owned_stores_v1_pkey"].some((name) => name.startsWith(scope.tablePrefix)))) {
      fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)}: rejectIfPresent would cover the bazis registry table __bazis_orm_owned_stores_v1`);
    }
    const rejectedOwn = (record.definition.rejectIfPresent ?? []).find((scope) => overlaps(record.definition.ownedScope, scope));
    if (rejectedOwn) {
      fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)}: rejectIfPresent (${scopeName(rejectedOwn)}) overlaps its own scope; ${OVERLAP_HINT}`);
    }
    if (keys.has(record.definition.storeKey)) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `Owned store key "${record.definition.storeKey}" is declared by more than one ormBazis entry`);
    keys.add(record.definition.storeKey);
    for (const other of records) {
      if (other === record) continue;
      if (overlaps(record.definition.ownedScope, other.definition.ownedScope)) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)} overlaps the scope of owned store "${other.definition.storeKey}" (${scopeName(other.definition.ownedScope)}); ${OVERLAP_HINT}`);
      const rejected = (other.definition.rejectIfPresent ?? []).find((scope) => overlaps(record.definition.ownedScope, scope));
      if (rejected) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)} lies in a scope that owned store "${other.definition.storeKey}" rejects (${scopeName(rejected)})`);
    }
    for (const table of record.expected.tables) {
      const key = `${table.schema}.${table.table}`;
      if (tables.has(key)) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `Table "${table.schema}"."${table.table}" is mapped by more than one owned store entity`);
      if (table.schema !== record.definition.ownedScope.schema || !table.table.startsWith(record.definition.ownedScope.tablePrefix)) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)}: entity table "${table.schema}"."${table.table}" lies outside the store scope; name its tables with the prefix, for example "${record.definition.ownedScope.tablePrefix}${table.table}"`);
      tables.add(key);
      for (const foreignKey of table.foreignKeys) if (foreignKey.target.schema !== record.definition.ownedScope.schema || !foreignKey.target.table.startsWith(record.definition.ownedScope.tablePrefix)) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${storeName(record.definition)}: table "${table.table}" has a foreign key to "${foreignKey.target.schema}"."${foreignKey.target.table}" outside the store; an owned store references only its own tables`);
    }
  }
  // The complete ORM graph is compiled only when an owned store is present. This
  // catches an ordinary context that maps an owned or rejected table before any
  // provider or DI activation; containers without owned stores keep the
  // ordinary behaviour.
  const effectiveConfigs = new Map<object, object>();
  for (const entry of graph) {
    // In owned mode every registration receives exactly one container-local
    // view. Direct ordinary modules intentionally read their caller config at
    // build time, then both graph preflight and runtime factories use this copy.
    const source = entry.config as { readonly entities?: readonly EntityClass[]; readonly migrations?: readonly unknown[] } | undefined;
    const entities = source === undefined ? entry.entities : Object.freeze([...(source.entities ?? [])]);
    // Migration instances remain caller-owned; only the sequence membership and
    // order are part of this container's effective config snapshot.
    const migrations = source?.migrations;
    effectiveConfigs.set(entry.identity, Object.freeze({
      ...(source ?? {}),
      context: entry.context,
      entities,
      ...(migrations === undefined ? {} : { migrations: Object.freeze([...migrations]) }),
    }));
    const expected = compileExpectedSchema(new OrmModel(entities));
    for (const table of expected.tables) {
      const owner = records.find((record) => table.schema === record.definition.ownedScope.schema && table.table.startsWith(record.definition.ownedScope.tablePrefix));
      const rejected = records.some((record) => (record.definition.rejectIfPresent ?? []).some((scope) => table.schema === scope.schema && table.table.startsWith(scope.tablePrefix)));
      if (owner && owner !== entry.owned) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${entry.context.name} maps table "${table.schema}"."${table.table}", which belongs to owned store "${owner.definition.storeKey}"; only the store's own context may map it`);
      if (rejected) fail("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", `${entry.context.name} maps table "${table.schema}"."${table.table}" in a scope an owned store rejects (rejectIfPresent)`);
    }
  }
  const result = Object.freeze(records);
  compiled.set(contributions as object, Object.freeze({ records: result, effectiveConfigs }));
  return result;
}

/** @internal Returns the graph's immutable runtime view only in owned mode. */
export function effectiveOrmModuleConfig<T>(snapshot: ModuleOwnedContributionSnapshot, identity: object | undefined, fallback: T): T {
  if (identity === undefined) return fallback;
  const contributions = snapshot.getMetadataContributions(CHANNEL);
  const graph = compiled.get(contributions as object);
  if (graph === undefined || graph.records.length === 0) return fallback;
  return (graph.effectiveConfigs.get(identity) as T | undefined) ?? fallback;
}

registerModuleOwnedProviderContributor((metadata, context) => {
  const payload = (metadata as { readonly [PAYLOAD]?: OrmGraphContribution })[PAYLOAD];
  if (payload) context.addMetadata(CHANNEL, payload);
});

registerModuleOwnedContributionValidator((snapshot) => {
  const records = snapshot.getMetadataContributions(CHANNEL);
  if (records.length !== 0) ownedStoreRegistrations(snapshot);
});

export function preparedOwnedStoreRegistration(registration: OwnedStoreRegistration): {
  readonly definition: Readonly<OrmOwnedStoreDefinitionV1>;
  readonly expected: OrmExpectedSchema;
  readonly ownedScopeHash: `sha256:${string}`;
  readonly modelHash: `sha256:${string}`;
} {
  return Object.freeze({ definition: registration.definition, expected: registration.expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(registration.definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(registration.definition, registration.expected) as `sha256:${string}` });
}

export { CHANNEL as ORM_OWNED_STORE_CHANNEL };
