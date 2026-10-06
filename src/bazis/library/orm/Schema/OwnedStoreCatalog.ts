import { isDefinedOrmOwnedStoreV1, type OrmCatalogScopeV1, type OrmOwnedStoreDefinitionV1 } from "./OrmOwnedStore";
import { canonicalOwnedStoreScopeHashV1 } from "./OwnedStoreCanonical";
import { failure } from "../Providers/ormOwnedStoreRuntime";
import { types } from "node:util";
import type { CanonicalDefault } from "./introspection";
import type { CheckAst } from "./CheckExpression";
import { projectCheckAstIdentifiers } from "./CheckExpression";
import type { OrmExpectedSchema } from "./ExpectedSchema";
import { ExactSchemaVerifier } from "./ExactSchemaVerifier";
import type { IntrospectedTable } from "./introspection";
export type PgOidV1 = string;
export type PgIntV1 = string;
export type PgSignedIntV1 = string;
export type PgHashV1 = `sha256:${string}`;
export interface OwnedStoreCatalogContextV1 {
  readonly maxIdentifierLength: bigint;
}
export interface OwnedCatalogClassV1 {
  readonly oid: PgOidV1;
  readonly schema: "pg_catalog" | "other";
  readonly name: string;
  readonly kind: "pg_class" | "pg_type" | "pg_constraint" | "pg_proc" | "pg_rewrite" | "pg_namespace" | "pg_attrdef" | "pg_trigger" | "other";
}
export interface OwnedCatalogRelationV1 {
  readonly oid: PgOidV1;
  readonly namespaceOid: PgOidV1;
  readonly schema: string;
  readonly name: string;
  readonly kind: "ordinaryTable" | "partitionedTable" | "foreignTable" | "view" | "materializedView" | "sequence" | "index" | "partitionedIndex" | "toastTable" | "other";
  readonly rawKind: string;
  readonly persistence: "permanent" | "unlogged" | "temporary" | "other";
  readonly isPartition: boolean;
  readonly rowSecurity: boolean;
  readonly forceRowSecurity: boolean;
  readonly replicaIdentity: "default" | "nothing" | "full" | "index" | "other";
  readonly tablespaceOid: PgOidV1 | "0";
  readonly accessMethod: string | null;
  readonly options: readonly string[];
  readonly rowTypeOid: PgOidV1 | null;
  readonly toastRelationOid: PgOidV1 | null;
}
export interface OwnedCatalogRowTypeV1 {
  readonly oid: PgOidV1;
  readonly relationOid: PgOidV1;
  readonly schema: string;
  readonly name: string;
  readonly kind: "composite" | "other";
  readonly arrayTypeOid: PgOidV1;
}
export interface OwnedCatalogArrayTypeV1 {
  readonly oid: PgOidV1;
  readonly elementTypeOid: PgOidV1;
  readonly relationOid: "0";
  readonly arrayTypeOid: "0";
  readonly schema: string;
  readonly name: string;
  readonly kind: "base" | "other";
  readonly category: "array" | "other";
}
export interface OwnedCatalogColumnV1 {
  readonly relationOid: PgOidV1;
  readonly attnum: PgIntV1;
  readonly name: string;
  readonly dropped: boolean;
  readonly local: boolean;
  readonly inheritanceCount: PgIntV1;
  readonly physicalType: string;
  readonly typeOid: PgOidV1 | "0";
  readonly notNull: boolean;
  readonly default: CanonicalDefault;
  readonly defaultObjectOid: PgOidV1 | null;
  readonly generation: "none" | "identityByDefault" | "uuidDefault" | "other";
  readonly identityCode: "" | "a" | "d" | "other";
  readonly generatedCode: "" | "s" | "v" | "other";
  readonly collationOid: PgOidV1 | "0";
  readonly typeDefaultCollationOid: PgOidV1 | "0";
  readonly storageCode: string;
  readonly typeDefaultStorageCode: string;
  readonly compressionCode: "" | "p" | "l" | "other";
}
export interface OwnedCatalogIndexV1 {
  readonly indexRelationOid: PgOidV1;
  readonly tableRelationOid: PgOidV1;
  readonly name: string;
  readonly method: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly exclusion: boolean;
  readonly immediate: boolean;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly live: boolean;
  readonly replicaIdentity: boolean;
  readonly nullsNotDistinct: boolean;
  readonly keyAttributeCount: PgIntV1;
  readonly totalAttributeCount: PgIntV1;
  readonly attributeNumbers: readonly PgSignedIntV1[];
  readonly columnNames: readonly (string | null)[];
  readonly collationOids: readonly (PgOidV1 | "0")[];
  readonly opclassOids: readonly PgOidV1[];
  readonly defaultOpclassOids: readonly PgOidV1[];
  readonly options: readonly PgSignedIntV1[];
  readonly expression: string | null;
  readonly predicate: string | null;
  readonly backingConstraintOid: PgOidV1 | null;
}
export interface OwnedCatalogConstraintV1 {
  readonly oid: PgOidV1;
  readonly relationOid: PgOidV1;
  readonly referencedRelationOid: PgOidV1 | null;
  readonly name: string;
  readonly kind: "primaryKey" | "unique" | "foreignKey" | "check" | "exclusion" | "other";
  readonly columns: readonly string[];
  readonly referencedColumns: readonly string[];
  readonly backingIndexOid: PgOidV1 | null;
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly match: string | null;
  readonly deferrable: boolean;
  readonly initiallyDeferred: boolean;
  readonly validated: boolean;
  readonly parentConstraintOid: PgOidV1 | null;
  readonly inheritanceCount: PgIntV1;
  readonly noInherit: boolean;
  readonly deleteSetColumns: readonly string[];
  readonly primaryForeignEqualityOperatorOids: readonly PgOidV1[];
  readonly primaryPrimaryEqualityOperatorOids: readonly PgOidV1[];
  readonly foreignForeignEqualityOperatorOids: readonly PgOidV1[];
  readonly defaultEqualityOperatorOids: readonly PgOidV1[];
  readonly checkExpression: CheckAst | null;
}
export interface OwnedCatalogTriggerV1 {
  readonly oid: PgOidV1;
  readonly relationOid: PgOidV1;
  readonly name: string;
  readonly internal: boolean;
  readonly constraintOid: PgOidV1 | null;
  readonly parentTriggerOid: PgOidV1 | null;
  readonly enabled: "origin" | "always" | "replica" | "disabled" | "other";
  readonly functionOid: PgOidV1;
  readonly functionSchema: string;
  readonly functionName: string;
  readonly typeBits: PgIntV1;
}
export interface OwnedCatalogRuleV1 {
  readonly oid: PgOidV1;
  readonly relationOid: PgOidV1;
  readonly name: string;
  readonly event: string;
  readonly enabled: string;
  readonly instead: boolean;
}
export interface OwnedCatalogPolicyV1 {
  readonly oid: PgOidV1;
  readonly relationOid: PgOidV1;
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly (PgOidV1 | "0")[];
  readonly usingExpression: string | null;
  readonly checkExpression: string | null;
}
export interface OwnedCatalogInheritanceV1 {
  readonly childRelationOid: PgOidV1;
  readonly parentRelationOid: PgOidV1;
  readonly sequence: PgIntV1;
}
export interface OwnedCatalogDependencyV1 {
  readonly dependentClassOid: PgOidV1;
  readonly dependentOid: PgOidV1;
  readonly dependentSubId: PgIntV1;
  readonly referencedClassOid: PgOidV1;
  readonly referencedOid: PgOidV1;
  readonly referencedSubId: PgIntV1;
  readonly kind: "normal" | "automatic" | "internal" | "partitionPrimary" | "partitionSecondary" | "extension" | "other";
}
export interface OwnedCatalogSequenceV1 {
  readonly relationOid: PgOidV1;
  readonly type: "bigint" | "integer" | "smallint" | "other";
  readonly start: PgSignedIntV1;
  readonly increment: PgSignedIntV1;
  readonly minimum: PgSignedIntV1;
  readonly maximum: PgSignedIntV1;
  readonly cache: PgIntV1;
  readonly cycle: boolean;
}
export interface OwnedCatalogToastClosureV1 {
  readonly ownerTableOid: PgOidV1;
  readonly relation: OwnedCatalogRelationV1;
  readonly columns: readonly OwnedCatalogColumnV1[];
  readonly indexes: readonly OwnedCatalogIndexV1[];
  readonly indexRelations: readonly OwnedCatalogRelationV1[];
  readonly dependencies: readonly OwnedCatalogDependencyV1[];
}
export interface OwnedStoreRegistryShapeV1 {
  readonly catalogClasses: readonly OwnedCatalogClassV1[];
  readonly relation: OwnedCatalogRelationV1;
  readonly rowType: OwnedCatalogRowTypeV1;
  readonly arrayType: OwnedCatalogArrayTypeV1;
  readonly columns: readonly OwnedCatalogColumnV1[];
  readonly indexes: readonly OwnedCatalogIndexV1[];
  readonly indexRelations: readonly OwnedCatalogRelationV1[];
  readonly constraints: readonly OwnedCatalogConstraintV1[];
  readonly triggers: readonly OwnedCatalogTriggerV1[];
  readonly rules: readonly OwnedCatalogRuleV1[];
  readonly policies: readonly OwnedCatalogPolicyV1[];
  readonly inheritance: readonly OwnedCatalogInheritanceV1[];
  readonly dependencies: readonly OwnedCatalogDependencyV1[];
  readonly sequences: readonly OwnedCatalogSequenceV1[];
  readonly toast: OwnedCatalogToastClosureV1 | null;
}
export interface OwnedStoreRegistryRowV1 {
  readonly storeKey: string;
  readonly contract: "bazis.orm-owned-store/v1";
  readonly formatVersion: string;
  readonly ownedSchema: string;
  readonly tablePrefix: string;
  readonly ownedScopeHash: PgHashV1;
  readonly modelHash: PgHashV1;
  readonly createdAtEpochMicroseconds: string;
}
export interface OwnedStoreRegistrySnapshotV1 {
  readonly contract: "bazis.orm-owned-store-registry-snapshot/v1";
  readonly publicSchemaExists: boolean;
  readonly state: {
    readonly kind: "absent";
  } | {
    readonly kind: "present";
    readonly shape: OwnedStoreRegistryShapeV1;
    readonly rows: readonly OwnedStoreRegistryRowV1[];
  };
}
export interface OwnedStoreCatalogSnapshotV1 {
  readonly contract: "bazis.orm-owned-store-catalog-snapshot/v1";
  readonly requestedScopes: readonly OrmCatalogScopeV1[];
  readonly existingSchemas: readonly string[];
  readonly catalogClasses: readonly OwnedCatalogClassV1[];
  readonly relations: readonly OwnedCatalogRelationV1[];
  readonly rowTypes: readonly OwnedCatalogRowTypeV1[];
  readonly arrayTypes: readonly OwnedCatalogArrayTypeV1[];
  readonly columns: readonly OwnedCatalogColumnV1[];
  readonly indexes: readonly OwnedCatalogIndexV1[];
  readonly constraints: readonly OwnedCatalogConstraintV1[];
  readonly triggers: readonly OwnedCatalogTriggerV1[];
  readonly rules: readonly OwnedCatalogRuleV1[];
  readonly policies: readonly OwnedCatalogPolicyV1[];
  readonly inheritance: readonly OwnedCatalogInheritanceV1[];
  readonly dependencies: readonly OwnedCatalogDependencyV1[];
  readonly sequences: readonly OwnedCatalogSequenceV1[];
}
const hash = /^sha256:[0-9a-f]{64}$/u, integer = /^(0|[1-9][0-9]*)$/u, signed = /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/u;
function bad(): never {
  throw failure("ORM_OWNED_STORE_DRIFT");
}
function record(v: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (v === null || typeof v !== "object" || types.isProxy(v) || Array.isArray(v))
    bad();
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null || Object.getOwnPropertySymbols(v).length)
    bad();
  const d = Object.getOwnPropertyDescriptors(v);
  if (Object.keys(d).some(k => !keys.includes(k) || !("value" in d[k]!)) || required.some(k => !Object.hasOwn(d, k)))
    bad();
  return Object.fromEntries(Object.entries(d).map(([k, x]) => [k, (x as PropertyDescriptor & {
      value: unknown;
    }).value]));
}
function dense<T>(v: unknown, parse: (x: unknown) => T, max: number): readonly T[] {
  if (v === null || typeof v !== "object" || types.isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Object.getOwnPropertySymbols(v).length)
    bad();
  const length = Object.getOwnPropertyDescriptor(v, "length");
  if (!length || !("value" in length) || typeof length.value !== "number" || length.value > max)
    bad();
  const d = Object.getOwnPropertyDescriptors(v);
  for (const key of Object.keys(d)) {
    if (key === "length")
      continue;
    if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length.value || !("value" in d[key]!))
      bad();
  }
  const out: T[] = [];
  for (let i = 0; i < length.value; i++) {
    const x = d[String(i)];
    if (!x || !("value" in x))
      bad();
    out.push(parse(x.value));
  }
  return Object.freeze(out);
}
function text(v: unknown, min: number, max: number): string {
  if (typeof v !== "string" || Buffer.byteLength(v, "utf8") < min || Buffer.byteLength(v, "utf8") > max)
    bad();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f))
      bad();
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= v.length)
        bad();
      const next = v.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff)
        bad();
      i++;
    }
    else if (c >= 0xdc00 && c <= 0xdfff)
      bad();
  }
  return v;
}
function natural(v: unknown, positive: boolean, max: bigint): string {
  const s = text(v, 1, max.toString().length);
  if (!integer.test(s) || (positive && s === "0") || BigInt(s) > max)
    bad();
  return s;
}
function oid(v: unknown): PgOidV1 {
  return natural(v, true, 4294967295n);
}
function rawText(v: unknown): string {
  if (typeof v !== "string")
    bad();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f))
      bad();
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= v.length)
        bad();
      const next = v.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff)
        bad();
      i++;
    }
    else if (c >= 0xdc00 && c <= 0xdfff)
      bad();
  }
  return v;
}
function dataText(v: unknown): string {
  if (typeof v !== "string" || Buffer.byteLength(v, "utf8") > 4 * 1024 * 1024)
    bad();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= v.length)
        bad();
      const next = v.charCodeAt(i + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        bad();
      i++;
    }
    else if (c >= 0xdc00 && c <= 0xdfff)
      bad();
  }
  return v;
}
function literal<T extends string>(v: unknown, values: readonly T[]): T {
  return typeof v === "string" && values.includes(v as T) ? v as T : bad();
}
function nullableOid(v: unknown): PgOidV1 | null {
  return v === null ? null : oid(v);
}
function oidOrZero(v: unknown): PgOidV1 | "0" {
  return v === "0" ? "0" : oid(v);
}
function parseOwnedStoreCatalogContextV1(v: unknown): OwnedStoreCatalogContextV1 {
  const r = record(v, ["maxIdentifierLength"]);
  if (typeof r.maxIdentifierLength !== "bigint")
    bad();
  if (r.maxIdentifierLength < 63n)
    throw failure("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  return Object.freeze({ maxIdentifierLength: r.maxIdentifierLength });
}
function serverIdentifier(v: unknown, max: bigint): string {
  if (typeof v !== "string")
    bad();
  const bytes = Buffer.byteLength(v, "utf8");
  if (bytes < 1 || BigInt(bytes) > max)
    bad();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f))
      bad();
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= v.length)
        bad();
      const next = v.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff)
        bad();
      i++;
    }
    else if (c >= 0xdc00 && c <= 0xdfff)
      bad();
  }
  return v;
}
export function parseOwnedCatalogClassV1(v: unknown): OwnedCatalogClassV1 {
  const r = record(v, ["oid", "schema", "name", "kind"]);
  return Object.freeze({
    oid: oid(r.oid), schema: literal(r.schema, ["pg_catalog", "other"]), name: text(r.name, 1, 63), kind: literal(r.kind, [
      "pg_class", "pg_type", "pg_constraint", "pg_proc", "pg_rewrite", "pg_namespace", "pg_attrdef", "pg_trigger", "other"
    ])
  });
}
export function parseOwnedCatalogRelationV1(v: unknown, context: OwnedStoreCatalogContextV1): OwnedCatalogRelationV1 {
  const c = parseOwnedStoreCatalogContextV1(context), r = record(v, [
    "oid", "namespaceOid", "schema", "name", "kind", "rawKind", "persistence", "isPartition", "rowSecurity", "forceRowSecurity", "replicaIdentity", "tablespaceOid", "accessMethod", "options", "rowTypeOid", "toastRelationOid"
  ]), kind = literal(r.kind, [
    "ordinaryTable", "partitionedTable", "foreignTable", "view", "materializedView", "sequence", "index", "partitionedIndex", "toastTable", "other"
  ]);
  return Object.freeze({
    oid: oid(r.oid), namespaceOid: oid(r.namespaceOid), schema: text(r.schema, 1, 63), name: kind === "sequence" ? serverIdentifier(r.name, c.maxIdentifierLength) : text(r.name, 1, 63), kind, rawKind: rawText(r.rawKind), persistence: literal(r.persistence, ["permanent", "unlogged", "temporary", "other"]), isPartition: typeof r.isPartition === "boolean" ? r.isPartition : bad(), rowSecurity: typeof r.rowSecurity === "boolean" ? r.rowSecurity : bad(), forceRowSecurity: typeof r.forceRowSecurity === "boolean" ? r.forceRowSecurity : bad(), replicaIdentity: literal(r.replicaIdentity, ["default", "nothing", "full", "index", "other"]), tablespaceOid: oidOrZero(r.tablespaceOid), accessMethod: r.accessMethod === null ? null : rawText(r.accessMethod), options: dense(r.options, rawText, 65536), rowTypeOid: nullableOid(r.rowTypeOid), toastRelationOid: nullableOid(r.toastRelationOid)
  });
}
export function parseOwnedCatalogRowTypeV1(v: unknown): OwnedCatalogRowTypeV1 {
  const r = record(v, ["oid", "relationOid", "schema", "name", "kind", "arrayTypeOid"]);
  return Object.freeze({
    oid: oid(r.oid), relationOid: oid(r.relationOid), schema: text(r.schema, 1, 63), name: text(r.name, 1, 63), kind: literal(r.kind, ["composite", "other"]), arrayTypeOid: oid(r.arrayTypeOid)
  });
}
export function parseOwnedCatalogArrayTypeV1(v: unknown, context: OwnedStoreCatalogContextV1): OwnedCatalogArrayTypeV1 {
  const c = parseOwnedStoreCatalogContextV1(context), r = record(v, ["oid", "elementTypeOid", "relationOid", "arrayTypeOid", "schema", "name", "kind", "category"]);
  if (r.relationOid !== "0" || r.arrayTypeOid !== "0")
    bad();
  return Object.freeze({
    oid: oid(r.oid), elementTypeOid: oid(r.elementTypeOid), relationOid: "0", arrayTypeOid: "0", schema: text(r.schema, 1, 63), name: serverIdentifier(r.name, c.maxIdentifierLength), kind: literal(r.kind, ["base", "other"]), category: literal(r.category, ["array", "other"])
  });
}
export function parseCanonicalDefaultV1(v: unknown): CanonicalDefault {
  const r = record(v, ["kind", "value"], ["kind"]);
  const kind = literal(r.kind, ["none", "null", "currentTimestamp", "uuidV4", "boolean", "number", "string"]);
  switch (kind) {
    case "none":
    case "null":
    case "currentTimestamp":
    case "uuidV4":
      if (Object.hasOwn(r, "value"))
        bad();
      return Object.freeze({ kind });
    case "boolean":
      if (typeof r.value !== "boolean")
        bad();
      return Object.freeze({ kind, value: r.value });
    case "number":
      if (typeof r.value !== "number" || !Number.isFinite(r.value))
        bad();
      return Object.freeze({ kind, value: Object.is(r.value, -0) ? 0 : r.value });
    case "string": return Object.freeze({ kind, value: dataText(r.value) });
  }
}
function small(v: unknown, positive = false): string {
  return natural(v, positive, 32767n);
}
function signedSmall(v: unknown): string {
  const x = text(v, 1, 6);
  if (!signed.test(x) || BigInt(x) < -32768n || BigInt(x) > 32767n)
    bad();
  return x;
}
function signedInt64(v: unknown): PgSignedIntV1 {
  if (typeof v !== "string" || v.length > 20 || !signed.test(v))
    bad();
  const x = BigInt(v);
  if (x < -9223372036854775808n || x > 9223372036854775807n)
    bad();
  return v;
}
export function parseOwnedCatalogColumnV1(v: unknown): OwnedCatalogColumnV1 {
  const r = record(v, [
    "relationOid", "attnum", "name", "dropped", "local", "inheritanceCount", "physicalType", "typeOid", "notNull", "default", "defaultObjectOid", "generation", "identityCode", "generatedCode", "collationOid", "typeDefaultCollationOid", "storageCode", "typeDefaultStorageCode", "compressionCode"
  ]);
  return Object.freeze({
    relationOid: oid(r.relationOid), attnum: small(r.attnum, true), name: text(r.name, 1, 63), dropped: typeof r.dropped === "boolean" ? r.dropped : bad(), local: typeof r.local === "boolean" ? r.local : bad(), inheritanceCount: small(r.inheritanceCount), physicalType: rawText(r.physicalType), typeOid: oidOrZero(r.typeOid), notNull: typeof r.notNull === "boolean" ? r.notNull : bad(), default: parseCanonicalDefaultV1(r.default), defaultObjectOid: nullableOid(r.defaultObjectOid), generation: literal(r.generation, ["none", "identityByDefault", "uuidDefault", "other"]), identityCode: literal(r.identityCode, ["", "a", "d", "other"]), generatedCode: literal(r.generatedCode, ["", "s", "v", "other"]), collationOid: oidOrZero(r.collationOid), typeDefaultCollationOid: oidOrZero(r.typeDefaultCollationOid), storageCode: rawText(r.storageCode), typeDefaultStorageCode: rawText(r.typeDefaultStorageCode), compressionCode: literal(r.compressionCode, ["", "p", "l", "other"])
  });
}
export function parseOwnedCatalogIndexV1(v: unknown): OwnedCatalogIndexV1 {
  const r = record(v, [
    "indexRelationOid", "tableRelationOid", "name", "method", "unique", "primary", "exclusion", "immediate", "valid", "ready", "live", "replicaIdentity", "nullsNotDistinct", "keyAttributeCount", "totalAttributeCount", "attributeNumbers", "columnNames", "collationOids", "opclassOids", "defaultOpclassOids", "options", "expression", "predicate", "backingConstraintOid"
  ]);
  const key = small(r.keyAttributeCount, true), total = small(r.totalAttributeCount, true);
  if (BigInt(key) > BigInt(total))
    bad();
  const keyMax = Number(key), totalMax = Number(total);
  const attrs = dense(r.attributeNumbers, signedSmall, totalMax), names = dense(r.columnNames, x => x === null ? null : text(x, 1, 63), totalMax), coll = dense(r.collationOids, oidOrZero, keyMax), op = dense(r.opclassOids, oid, keyMax), def = dense(r.defaultOpclassOids, oid, keyMax), opts = dense(r.options, signedSmall, keyMax);
  if (attrs.length !== totalMax || names.length !== totalMax || coll.length !== keyMax || op.length !== keyMax || def.length !== keyMax || opts.length !== keyMax)
    bad();
  const bool = (x: unknown) => typeof x === "boolean" ? x : bad();
  return Object.freeze({
    indexRelationOid: oid(r.indexRelationOid), tableRelationOid: oid(r.tableRelationOid), name: text(r.name, 1, 63), method: rawText(r.method), unique: bool(r.unique), primary: bool(r.primary), exclusion: bool(r.exclusion), immediate: bool(r.immediate), valid: bool(r.valid), ready: bool(r.ready), live: bool(r.live), replicaIdentity: bool(r.replicaIdentity), nullsNotDistinct: bool(r.nullsNotDistinct), keyAttributeCount: key, totalAttributeCount: total, attributeNumbers: attrs, columnNames: names, collationOids: coll, opclassOids: op, defaultOpclassOids: def, options: opts, expression: r.expression === null ? null : dataText(r.expression), predicate: r.predicate === null ? null : dataText(r.predicate), backingConstraintOid: nullableOid(r.backingConstraintOid)
  });
}
export function parseOwnedCatalogTriggerV1(v: unknown): OwnedCatalogTriggerV1 {
  const r = record(v, [
    "oid", "relationOid", "name", "internal", "constraintOid", "parentTriggerOid", "enabled", "functionOid", "functionSchema", "functionName", "typeBits"
  ]);
  return Object.freeze({
    oid: oid(r.oid), relationOid: oid(r.relationOid), name: text(r.name, 1, 63), internal: typeof r.internal === "boolean" ? r.internal : bad(), constraintOid: nullableOid(r.constraintOid), parentTriggerOid: nullableOid(r.parentTriggerOid), enabled: literal(r.enabled, ["origin", "always", "replica", "disabled", "other"]), functionOid: oid(r.functionOid), functionSchema: text(r.functionSchema, 1, 63), functionName: text(r.functionName, 1, 63), typeBits: small(r.typeBits, true)
  });
}
export function parseOwnedCatalogRuleV1(v: unknown): OwnedCatalogRuleV1 {
  const r = record(v, ["oid", "relationOid", "name", "event", "enabled", "instead"]);
  return Object.freeze({
    oid: oid(r.oid), relationOid: oid(r.relationOid), name: text(r.name, 1, 63), event: rawText(r.event), enabled: rawText(r.enabled), instead: typeof r.instead === "boolean" ? r.instead : bad()
  });
}
export function parseOwnedCatalogPolicyV1(v: unknown): OwnedCatalogPolicyV1 {
  const r = record(v, ["oid", "relationOid", "name", "permissive", "command", "roles", "usingExpression", "checkExpression"]);
  return Object.freeze({
    oid: oid(r.oid), relationOid: oid(r.relationOid), name: text(r.name, 1, 63), permissive: typeof r.permissive === "boolean" ? r.permissive : bad(), command: rawText(r.command), roles: dense(r.roles, oidOrZero, 65536), usingExpression: r.usingExpression === null ? null : dataText(r.usingExpression), checkExpression: r.checkExpression === null ? null : dataText(r.checkExpression)
  });
}
function checkScalar(v: unknown): null | boolean | number | string {
  if (v === null || typeof v === "boolean")
    return v;
  if (typeof v === "number" && Number.isFinite(v))
    return Object.is(v, -0) ? 0 : v;
  if (typeof v === "string")
    return dataText(v);
  bad();
}
function checkKeys(r: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key)))
    bad();
}
export function parseCheckAstV1(v: unknown): CheckAst {
  let count = 0;
  const active = new WeakSet<object>();
  const visit = (value: unknown, depth: number): CheckAst => {
    if (depth > 64 || value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
      bad();
    if (active.has(value))
      bad();
    active.add(value);
    try {
      const r = record(value, ["kind", "op", "left", "right", "values", "not", "inner"], ["kind"]), kind = literal(r.kind, ["compare", "in", "null", "and", "or", "not"]);
      count++;
      if (count > 4096)
        bad();
      switch (kind) {
        case "compare": {
          checkKeys(r, ["kind", "op", "left", "right"]);
          const right = typeof r.right === "string" && r.right.startsWith("\0") ? `\0${text(r.right.slice(1), 1, 63)}` : checkScalar(r.right);
          return Object.freeze({ kind, op: literal(r.op, ["=", "<>", ">", ">=", "<", "<="]), left: text(r.left, 1, 63), right });
        }
        case "in": {
          checkKeys(r, ["kind", "left", "values"]);
          const values = dense(r.values, checkScalar, 100);
          if (!values.length)
            bad();
          return Object.freeze({ kind, left: text(r.left, 1, 63), values });
        }
        case "null":
          checkKeys(r, ["kind", "left", "not"]);
          return Object.freeze({ kind, left: text(r.left, 1, 63), not: typeof r.not === "boolean" ? r.not : bad() });
        case "and":
        case "or":
          checkKeys(r, ["kind", "left", "right"]);
          return Object.freeze({ kind, left: visit(r.left, depth + 1), right: visit(r.right, depth + 1) });
        case "not":
          checkKeys(r, ["kind", "inner"]);
          return Object.freeze({ kind, inner: visit(r.inner, depth + 1) });
      }
    }
    finally {
      active.delete(value);
    }
  };
  return visit(v, 1);
}
export function parseOwnedCatalogConstraintV1(v: unknown, context: OwnedStoreCatalogContextV1): OwnedCatalogConstraintV1 {
  const c = parseOwnedStoreCatalogContextV1(context), r = record(v, [
    "oid", "relationOid", "referencedRelationOid", "name", "kind", "columns", "referencedColumns", "backingIndexOid", "onDelete", "onUpdate", "match", "deferrable", "initiallyDeferred", "validated", "parentConstraintOid", "inheritanceCount", "noInherit", "deleteSetColumns", "primaryForeignEqualityOperatorOids", "primaryPrimaryEqualityOperatorOids", "foreignForeignEqualityOperatorOids", "defaultEqualityOperatorOids", "checkExpression"
  ]);
  const names = (x: unknown) => dense(x, y => serverIdentifier(y, c.maxIdentifierLength), 65536);
  return Object.freeze({
    oid: oid(r.oid), relationOid: oid(r.relationOid), referencedRelationOid: nullableOid(r.referencedRelationOid), name: serverIdentifier(r.name, c.maxIdentifierLength), kind: literal(r.kind, ["primaryKey", "unique", "foreignKey", "check", "exclusion", "other"]), columns: names(r.columns), referencedColumns: names(r.referencedColumns), backingIndexOid: nullableOid(r.backingIndexOid), onDelete: r.onDelete === null ? null : rawText(r.onDelete), onUpdate: r.onUpdate === null ? null : rawText(r.onUpdate), match: r.match === null ? null : rawText(r.match), deferrable: typeof r.deferrable === "boolean" ? r.deferrable : bad(), initiallyDeferred: typeof r.initiallyDeferred === "boolean" ? r.initiallyDeferred : bad(), validated: typeof r.validated === "boolean" ? r.validated : bad(), parentConstraintOid: nullableOid(r.parentConstraintOid), inheritanceCount: small(r.inheritanceCount), noInherit: typeof r.noInherit === "boolean" ? r.noInherit : bad(), deleteSetColumns: names(r.deleteSetColumns), primaryForeignEqualityOperatorOids: dense(r.primaryForeignEqualityOperatorOids, oid, 65536), primaryPrimaryEqualityOperatorOids: dense(r.primaryPrimaryEqualityOperatorOids, oid, 65536), foreignForeignEqualityOperatorOids: dense(r.foreignForeignEqualityOperatorOids, oid, 65536), defaultEqualityOperatorOids: dense(r.defaultEqualityOperatorOids, oid, 65536), checkExpression: r.checkExpression === null ? null : parseCheckAstV1(r.checkExpression)
  });
}
export function parseOwnedCatalogInheritanceV1(v: unknown): OwnedCatalogInheritanceV1 {
  const r = record(v, ["childRelationOid", "parentRelationOid", "sequence"]);
  return Object.freeze({
    childRelationOid: oid(r.childRelationOid), parentRelationOid: oid(r.parentRelationOid), sequence: natural(r.sequence, true, 2147483647n)
  });
}
export function parseOwnedCatalogDependencyV1(v: unknown): OwnedCatalogDependencyV1 {
  const r = record(v, [
    "dependentClassOid", "dependentOid", "dependentSubId", "referencedClassOid", "referencedOid", "referencedSubId", "kind"
  ]);
  return Object.freeze({
    dependentClassOid: oid(r.dependentClassOid), dependentOid: oid(r.dependentOid), dependentSubId: natural(r.dependentSubId, false, 2147483647n), referencedClassOid: oid(r.referencedClassOid), referencedOid: oid(r.referencedOid), referencedSubId: natural(r.referencedSubId, false, 2147483647n), kind: literal(r.kind, ["normal", "automatic", "internal", "partitionPrimary", "partitionSecondary", "extension", "other"])
  });
}
export function parseOwnedCatalogSequenceV1(v: unknown): OwnedCatalogSequenceV1 {
  const r = record(v, ["relationOid", "type", "start", "increment", "minimum", "maximum", "cache", "cycle"]);
  return Object.freeze({
    relationOid: oid(r.relationOid), type: literal(r.type, ["bigint", "integer", "smallint", "other"]), start: signedInt64(r.start), increment: signedInt64(r.increment), minimum: signedInt64(r.minimum), maximum: signedInt64(r.maximum), cache: natural(r.cache, true, 9223372036854775807n), cycle: typeof r.cycle === "boolean" ? r.cycle : bad()
  });
}
function row(v: unknown): OwnedStoreRegistryRowV1 {
  const r = record(v, [
    "storeKey", "contract", "formatVersion", "ownedSchema", "tablePrefix", "ownedScopeHash", "modelHash", "createdAtEpochMicroseconds"
  ]);
  const out = {
    storeKey: text(r.storeKey, 1, 128), contract: r.contract, formatVersion: natural(r.formatVersion, true, BigInt(Number.MAX_SAFE_INTEGER)), ownedSchema: text(r.ownedSchema, 1, 63), tablePrefix: text(r.tablePrefix, 1, 63), ownedScopeHash: text(r.ownedScopeHash, 1, 71), modelHash: text(r.modelHash, 1, 71), createdAtEpochMicroseconds: natural(r.createdAtEpochMicroseconds, false, 8640000000000000000n)
  };
  if (out.contract !== "bazis.orm-owned-store/v1" || !hash.test(out.ownedScopeHash) || !hash.test(out.modelHash))
    bad();
  return Object.freeze(out as OwnedStoreRegistryRowV1);
}
export function validateOwnedStoreRegistryV1(rows: unknown, defs: readonly OrmOwnedStoreDefinitionV1[]): readonly OwnedStoreRegistryRowV1[] {
  const out = dense(rows, row, 4096);
  const keys = new Set<string>();
  for (const x of out) {
    const descriptor = {
      contract: x.contract, storeKey: x.storeKey, formatVersion: Number(x.formatVersion), ownedScope: { schema: x.ownedSchema, tablePrefix: x.tablePrefix }
    } as OrmOwnedStoreDefinitionV1;
    if (canonicalOwnedStoreScopeHashV1(descriptor) !== x.ownedScopeHash)
      bad();
    if (keys.has(x.storeKey))
      throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    keys.add(x.storeKey);
    const d = defs.find(y => y.storeKey === x.storeKey);
    if (d && (x.formatVersion !== String(d.formatVersion) || x.ownedSchema !== d.ownedScope.schema || x.tablePrefix !== d.ownedScope.tablePrefix))
      throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  }
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]!, b = out[j]!;
      if (a.ownedSchema === b.ownedSchema && (a.tablePrefix.startsWith(b.tablePrefix) || b.tablePrefix.startsWith(a.tablePrefix)))
        throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    }
  return out;
}
type CatalogBudget = {
  used: number;
};
function take(b: CatalogBudget, n = 1): void {
  if (n > 65536 - b.used)
    bad();
  b.used += n;
}
function catalogDense<T>(v: unknown, parse: (x: unknown) => T, b: CatalogBudget): readonly T[] {
  if (v === null || typeof v !== "object" || types.isProxy(v) || !Array.isArray(v))
    bad();
  const length = Object.getOwnPropertyDescriptor(v, "length");
  if (!length || !("value" in length) || typeof length.value !== "number" || length.value > 65536)
    bad();
  take(b, length.value);
  return dense(v, parse, 65536);
}
function unique<T>(items: readonly T[], key: (x: T) => string): void {
  const keys = new Set<string>();
  for (const x of items) {
    const k = key(x);
    if (keys.has(k))
      bad();
    keys.add(k);
  }
}
function nestedIndexes(indexes: readonly OwnedCatalogIndexV1[], relations: readonly OwnedCatalogRelationV1[]): void {
  unique(relations, x => x.oid);
  if (indexes.length !== relations.length)
    bad();
  const expected = [...indexes.map(x => x.indexRelationOid)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  for (let i = 0; i < relations.length; i++)
    if (relations[i]!.oid !== expected[i])
      bad();
}
function registryShape(v: unknown, c: OwnedStoreCatalogContextV1, b: CatalogBudget): OwnedStoreRegistryShapeV1 {
  const r = record(v, [
    "catalogClasses", "relation", "rowType", "arrayType", "columns", "indexes", "indexRelations", "constraints", "triggers", "rules", "policies", "inheritance", "dependencies", "sequences", "toast"
  ]);
  take(b, 3);
  const out = {
    catalogClasses: catalogDense(r.catalogClasses, parseOwnedCatalogClassV1, b), relation: parseOwnedCatalogRelationV1(r.relation, c), rowType: parseOwnedCatalogRowTypeV1(r.rowType), arrayType: parseOwnedCatalogArrayTypeV1(r.arrayType, c), columns: catalogDense(r.columns, parseOwnedCatalogColumnV1, b), indexes: catalogDense(r.indexes, parseOwnedCatalogIndexV1, b), indexRelations: catalogDense(r.indexRelations, x => parseOwnedCatalogRelationV1(x, c), b), constraints: catalogDense(r.constraints, x => parseOwnedCatalogConstraintV1(x, c), b), triggers: catalogDense(r.triggers, parseOwnedCatalogTriggerV1, b), rules: catalogDense(r.rules, parseOwnedCatalogRuleV1, b), policies: catalogDense(r.policies, parseOwnedCatalogPolicyV1, b), inheritance: catalogDense(r.inheritance, parseOwnedCatalogInheritanceV1, b), dependencies: catalogDense(r.dependencies, parseOwnedCatalogDependencyV1, b), sequences: catalogDense(r.sequences, parseOwnedCatalogSequenceV1, b), toast: r.toast === null ? null : toast(r.toast, c, b)
  };
  const t = out.toast;
  unique([
    ...out.catalogClasses, out.relation, ...out.indexRelations, ...(t ? [t.relation, ...t.indexRelations] : [])
  ], x => x.oid);
  unique([out.rowType, out.arrayType], x => x.oid);
  unique([...out.columns, ...(t ? t.columns : [])], x => `${x.relationOid}:${x.attnum}`);
  unique([...out.indexes, ...(t ? t.indexes : [])], x => x.indexRelationOid);
  unique(out.constraints, x => x.oid);
  unique(out.constraints, x => `${x.relationOid}:${x.kind}:${x.name}`);
  unique(out.triggers, x => x.oid);
  unique(out.rules, x => x.oid);
  unique(out.policies, x => x.oid);
  unique(out.inheritance, x => `${x.childRelationOid}:${x.parentRelationOid}:${x.sequence}`);
  unique([...out.dependencies, ...(t ? t.dependencies : [])], x => `${x.dependentClassOid}:${x.dependentOid}:${x.dependentSubId}:${x.referencedClassOid}:${x.referencedOid}:${x.referencedSubId}:${x.kind}`);
  unique(out.sequences, x => x.relationOid);
  nestedIndexes(out.indexes, out.indexRelations);
  return Object.freeze(out);
}
function toast(v: unknown, c: OwnedStoreCatalogContextV1, b: CatalogBudget): OwnedCatalogToastClosureV1 {
  const r = record(v, ["ownerTableOid", "relation", "columns", "indexes", "indexRelations", "dependencies"]);
  take(b);
  const out = {
    ownerTableOid: oid(r.ownerTableOid), relation: parseOwnedCatalogRelationV1(r.relation, c), columns: catalogDense(r.columns, parseOwnedCatalogColumnV1, b), indexes: catalogDense(r.indexes, parseOwnedCatalogIndexV1, b), indexRelations: catalogDense(r.indexRelations, x => parseOwnedCatalogRelationV1(x, c), b), dependencies: catalogDense(r.dependencies, parseOwnedCatalogDependencyV1, b)
  };
  unique(out.columns, x => `${x.relationOid}:${x.attnum}`);
  unique(out.indexes, x => x.indexRelationOid);
  unique(out.dependencies, x => `${x.dependentClassOid}:${x.dependentOid}:${x.dependentSubId}:${x.referencedClassOid}:${x.referencedOid}:${x.referencedSubId}:${x.kind}`);
  nestedIndexes(out.indexes, out.indexRelations);
  return Object.freeze(out);
}
export function parseOwnedStoreRegistrySnapshotV1(v: unknown, defs: readonly OrmOwnedStoreDefinitionV1[], context: OwnedStoreCatalogContextV1): OwnedStoreRegistrySnapshotV1 {
  const c = parseOwnedStoreCatalogContextV1(context);
  const r = record(v, ["contract", "publicSchemaExists", "state"]);
  if (r.contract !== "bazis.orm-owned-store-registry-snapshot/v1" || typeof r.publicSchemaExists !== "boolean")
    bad();
  const s = record(r.state, ["kind", "shape", "rows"], ["kind"]);
  if (s.kind === "absent") {
    if (Object.keys(s).length !== 1)
      bad();
    if (!r.publicSchemaExists)
      throw failure("ORM_OWNED_STORE_CREATE_FAILED");
    return Object.freeze({ contract: r.contract, publicSchemaExists: r.publicSchemaExists, state: Object.freeze({ kind: "absent" }) });
  }
  if (s.kind !== "present")
    bad();
  const b: CatalogBudget = { used: 0 };
  const shape = registryShape(s.shape, c, b), rows = validateOwnedStoreRegistryV1(s.rows, defs);
  return Object.freeze({
    contract: r.contract, publicSchemaExists: r.publicSchemaExists, state: Object.freeze({ kind: "present", shape, rows })
  });
}
export function parseOwnedStoreCatalogSnapshotV1(v: unknown, context: OwnedStoreCatalogContextV1): OwnedStoreCatalogSnapshotV1 {
  const c = parseOwnedStoreCatalogContextV1(context), names = [
    "contract", "requestedScopes", "existingSchemas", "catalogClasses", "relations", "rowTypes", "arrayTypes", "columns", "indexes", "constraints", "triggers", "rules", "policies", "inheritance", "dependencies", "sequences"
  ], r = record(v, names);
  if (r.contract !== "bazis.orm-owned-store-catalog-snapshot/v1")
    bad();
  const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")), scopes = dense(r.requestedScopes, x => {
    const s = record(x, ["schema", "tablePrefix"]);
    return Object.freeze({ schema: text(s.schema, 1, 63), tablePrefix: text(s.tablePrefix, 1, 63) });
  }, 8320);
  for (let i = 1; i < scopes.length; i++) {
    const prev = scopes[i - 1]!, next = scopes[i]!, schema = compare(prev.schema, next.schema);
    if (schema > 0 || schema === 0 && compare(prev.tablePrefix, next.tablePrefix) >= 0)
      bad();
  }
  const schemas = dense(r.existingSchemas, x => text(x, 1, 63), 8320), scopeSchemas = new Set(scopes.map(x => x.schema));
  for (let i = 0; i < schemas.length; i++) {
    if (!scopeSchemas.has(schemas[i]!))
      bad();
    if (i && compare(schemas[i - 1]!, schemas[i]!) >= 0)
      bad();
  }
  const b: CatalogBudget = { used: 0 }, out = {
    contract: "bazis.orm-owned-store-catalog-snapshot/v1" as const, requestedScopes: scopes, existingSchemas: schemas, catalogClasses: catalogDense(r.catalogClasses, parseOwnedCatalogClassV1, b), relations: catalogDense(r.relations, x => parseOwnedCatalogRelationV1(x, c), b), rowTypes: catalogDense(r.rowTypes, parseOwnedCatalogRowTypeV1, b), arrayTypes: catalogDense(r.arrayTypes, x => parseOwnedCatalogArrayTypeV1(x, c), b), columns: catalogDense(r.columns, parseOwnedCatalogColumnV1, b), indexes: catalogDense(r.indexes, parseOwnedCatalogIndexV1, b), constraints: catalogDense(r.constraints, x => parseOwnedCatalogConstraintV1(x, c), b), triggers: catalogDense(r.triggers, parseOwnedCatalogTriggerV1, b), rules: catalogDense(r.rules, parseOwnedCatalogRuleV1, b), policies: catalogDense(r.policies, parseOwnedCatalogPolicyV1, b), inheritance: catalogDense(r.inheritance, parseOwnedCatalogInheritanceV1, b), dependencies: catalogDense(r.dependencies, parseOwnedCatalogDependencyV1, b), sequences: catalogDense(r.sequences, parseOwnedCatalogSequenceV1, b)
  };
  unique([...out.catalogClasses, ...out.relations], x => x.oid);
  unique([...out.rowTypes, ...out.arrayTypes], x => x.oid);
  unique(out.columns, x => `${x.relationOid}:${x.attnum}`);
  unique(out.indexes, x => x.indexRelationOid);
  unique(out.constraints, x => x.oid);
  unique(out.constraints, x => `${x.relationOid}:${x.kind}:${x.name}`);
  unique(out.triggers, x => x.oid);
  unique(out.rules, x => x.oid);
  unique(out.policies, x => x.oid);
  unique(out.inheritance, x => `${x.childRelationOid}:${x.parentRelationOid}:${x.sequence}`);
  unique(out.dependencies, x => `${x.dependentClassOid}:${x.dependentOid}:${x.dependentSubId}:${x.referencedClassOid}:${x.referencedOid}:${x.referencedSubId}:${x.kind}`);
  unique(out.sequences, x => x.relationOid);
  return Object.freeze(out);
}
export interface OwnedStoreCatalogStoreExpectationV1 {
  readonly definition: Readonly<OrmOwnedStoreDefinitionV1>;
  readonly expectedSchema: OrmExpectedSchema;
}
export interface OwnedStoreCatalogSemanticContextV1 {
  readonly stores: readonly OwnedStoreCatalogStoreExpectationV1[];
  readonly requestedScopes: readonly OrmCatalogScopeV1[];
}
interface OwnedStoreCatalogOwnershipAnalysisV1 {
  readonly stores: readonly OwnedStoreCatalogStoreExpectationV1[];
  readonly rootsByStoreKey: ReadonlyMap<string, readonly OwnedCatalogRelationV1[]>;
}
function analyzeOwnedStoreCatalogContextV1(snapshot: OwnedStoreCatalogSnapshotV1, context: OwnedStoreCatalogSemanticContextV1): OwnedStoreCatalogOwnershipAnalysisV1 {
  if (!Array.isArray(context.stores) || context.stores.length < 1 || context.stores.length > 128)
    bad();
  const stores = context.stores.map((store) => {
    if (!store || !isDefinedOrmOwnedStoreV1(store.definition))
      throw failure("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    if (!store.expectedSchema)
      bad();
    return store;
  });
  const keys = new Set<string>();
  const compare = (left: OrmCatalogScopeV1, right: OrmCatalogScopeV1): number => Buffer.compare(Buffer.from(left.schema, "utf8"), Buffer.from(right.schema, "utf8")) || Buffer.compare(Buffer.from(left.tablePrefix, "utf8"), Buffer.from(right.tablePrefix, "utf8"));
  const overlap = (left: OrmCatalogScopeV1, right: OrmCatalogScopeV1): boolean => left.schema === right.schema && (left.tablePrefix.startsWith(right.tablePrefix) || right.tablePrefix.startsWith(left.tablePrefix));
  const owned = stores.map((store) => store.definition.ownedScope);
  for (let index = 0; index < stores.length; index++) {
    if (keys.has(stores[index]!.definition.storeKey))
      throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    keys.add(stores[index]!.definition.storeKey);
    for (let other = index + 1; other < stores.length; other++)
      if (overlap(owned[index]!, owned[other]!))
        throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  }
  const all = stores.flatMap((store) => [store.definition.ownedScope, ...(store.definition.rejectIfPresent ?? [])]).sort(compare);
  const union = all.filter((scope, index) => index === 0 || scope.schema !== all[index - 1]!.schema || scope.tablePrefix !== all[index - 1]!.tablePrefix);
  for (const store of stores)
    for (const reject of store.definition.rejectIfPresent ?? [])
      for (const scope of owned)
        if (overlap(scope, reject))
          throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  if (union.some((scope) => scope.schema === "public" && "__bazis_orm_owned_stores_v1".startsWith(scope.tablePrefix)))
    throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  if (!Array.isArray(context.requestedScopes) || union.length !== context.requestedScopes.length || union.length !== snapshot.requestedScopes.length)
    bad();
  for (let index = 0; index < union.length; index++) {
    const expected = union[index]!, requested = context.requestedScopes[index]!, captured = snapshot.requestedScopes[index]!;
    if (expected.schema !== requested.schema || expected.tablePrefix !== requested.tablePrefix || expected.schema !== captured.schema || expected.tablePrefix !== captured.tablePrefix)
      bad();
  }
  const rootsByStoreKey = new Map<string, readonly OwnedCatalogRelationV1[]>();
  for (const store of stores)
    rootsByStoreKey.set(store.definition.storeKey, Object.freeze(snapshot.relations.filter((relation) => relation.kind === "ordinaryTable" && relation.schema === store.definition.ownedScope.schema && relation.name.startsWith(store.definition.ownedScope.tablePrefix))));
  for (const store of stores)
    for (const reject of store.definition.rejectIfPresent ?? [])
      if (snapshot.relations.some((relation) => relation.schema === reject.schema && relation.name.startsWith(reject.tablePrefix)))
        throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  const ownerOf = (oid: string): string | undefined => stores.find((store) => rootsByStoreKey.get(store.definition.storeKey)!.some((relation) => relation.oid === oid))?.definition.storeKey;
  for (const constraint of snapshot.constraints)
    if (constraint.kind === "foreignKey" && constraint.referencedRelationOid !== null) {
      const target = ownerOf(constraint.referencedRelationOid);
      if (target && ownerOf(constraint.relationOid) !== target)
        throw failure("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    }
  return Object.freeze({ stores: Object.freeze([...stores]), rootsByStoreKey });
}
/**
 * Checks that an owned table's TOAST table, if any, has exactly the shape
 * PostgreSQL creates: `pg_toast` schema, `chunk_id`/`chunk_seq`/`chunk_data`
 * columns, one index and only the expected internal dependencies. Works on one
 * immutable, already parsed catalog snapshot.
 */
function validateToastClosureV1(owner: OwnedCatalogRelationV1, relations: ReadonlyMap<string, OwnedCatalogRelationV1>, columns: ReadonlyMap<string, OwnedCatalogColumnV1[]>, indexes: ReadonlyMap<string, OwnedCatalogIndexV1[]>, consumedToastRelationOids: Set<string>, pgClass: string, pgNamespace: string, consume: (dependentClassOid: string, dependentOid: string, dependentSubId: string, referencedClassOid: string, referencedOid: string, referencedSubId: string, kind: OwnedCatalogDependencyV1["kind"], count?: number) => void, rejectDirect: (dependentClassOid: string, dependentOid: string, referencedClassOid: string, referencedOid: string) => void): void {
  if (owner.toastRelationOid === null)
    return;
  const toast = relations.get(owner.toastRelationOid);
  if (!toast || toast.kind !== "toastTable" || toast.rawKind !== "t" || toast.schema !== "pg_toast" || toast.persistence !== "permanent" || toast.accessMethod !== owner.accessMethod || toast.tablespaceOid !== owner.tablespaceOid || toast.isPartition || toast.rowSecurity || toast.forceRowSecurity || toast.replicaIdentity !== "nothing" || toast.options.length || toast.rowTypeOid !== null || toast.toastRelationOid !== null || consumedToastRelationOids.has(toast.oid))
    bad();
  consumedToastRelationOids.add(toast.oid);
  consume(pgClass, toast.oid, "0", pgClass, owner.oid, "0", "internal");
  rejectDirect(pgClass, toast.oid, pgNamespace, toast.namespaceOid);
  const toastColumns = [...(columns.get(toast.oid) ?? [])].sort((left, right) => Number(left.attnum) - Number(right.attnum));
  const expectedColumns = [["chunk_id", "oid"], ["chunk_seq", "integer"], ["chunk_data", "bytea"]] as const;
  if (toastColumns.length !== expectedColumns.length)
    bad();
  for (let index = 0; index < toastColumns.length; index++) {
    const column = toastColumns[index]!, expected = expectedColumns[index]!;
    if (column.attnum !== String(index + 1) || column.name !== expected[0] || column.physicalType !== expected[1] || column.typeOid === "0" || BigInt(column.typeOid) >= 12000n || column.dropped || !column.local || column.inheritanceCount !== "0" || column.notNull || column.default.kind !== "none" || column.defaultObjectOid !== null || column.generation !== "none" || column.identityCode !== "" || column.generatedCode !== "" || column.collationOid !== column.typeDefaultCollationOid || column.storageCode !== "p" || column.compressionCode !== "")
      bad();
  }
  const toastIndexes = indexes.get(toast.oid) ?? [];
  if (toastIndexes.length !== 1)
    bad();
  const index = toastIndexes[0]!, indexRelation = relations.get(index.indexRelationOid);
  if (!indexRelation || indexRelation.kind !== "index" || indexRelation.rawKind !== "i" || indexRelation.schema !== "pg_toast" || indexRelation.namespaceOid !== toast.namespaceOid || indexRelation.name !== index.name || indexRelation.persistence !== "permanent" || indexRelation.isPartition || indexRelation.rowSecurity || indexRelation.forceRowSecurity || indexRelation.replicaIdentity !== "nothing" || indexRelation.tablespaceOid !== "0" || indexRelation.accessMethod !== "btree" || indexRelation.options.length || indexRelation.rowTypeOid !== null || indexRelation.toastRelationOid !== null || index.tableRelationOid !== toast.oid || index.method !== "btree" || !index.primary || !index.unique || index.exclusion || !index.immediate || !index.valid || !index.ready || !index.live || index.replicaIdentity || index.nullsNotDistinct || index.keyAttributeCount !== "2" || index.totalAttributeCount !== "2" || index.attributeNumbers.length !== 2 || index.attributeNumbers[0] !== "1" || index.attributeNumbers[1] !== "2" || index.columnNames.length !== 2 || index.columnNames[0] !== "chunk_id" || index.columnNames[1] !== "chunk_seq" || index.collationOids.length !== 2 || index.collationOids.some((oid, position) => oid !== toastColumns[position]?.typeDefaultCollationOid) || index.opclassOids.length !== 2 || index.defaultOpclassOids.length !== 2 || index.opclassOids.some((oid, position) => oid !== index.defaultOpclassOids[position] || BigInt(oid) >= 12000n) || index.options.length !== 2 || index.options.some((option) => option !== "0") || index.expression !== null || index.predicate !== null || index.backingConstraintOid !== null)
    bad();
  consume(pgClass, index.indexRelationOid, "0", pgClass, toast.oid, "1", "automatic");
  consume(pgClass, index.indexRelationOid, "0", pgClass, toast.oid, "2", "automatic");
  rejectDirect(pgClass, index.indexRelationOid, pgNamespace, indexRelation.namespaceOid);
}
export function validateFixedRegistryShapeV1(shape: OwnedStoreRegistryShapeV1): void {
  if (shape.relation.schema !== "public" || shape.relation.name !== "__bazis_orm_owned_stores_v1" || shape.relation.kind !== "ordinaryTable" || shape.relation.rawKind !== "r" || shape.relation.persistence !== "permanent" || shape.relation.isPartition || shape.relation.rowSecurity || shape.relation.forceRowSecurity || shape.relation.replicaIdentity !== "default" || shape.relation.tablespaceOid !== "0" || shape.relation.accessMethod !== "heap" || shape.relation.options.length || shape.relation.rowTypeOid !== shape.rowType.oid || shape.relation.toastRelationOid !== (shape.toast?.relation.oid ?? null))
    bad();
  if (shape.toast !== null && shape.toast.ownerTableOid !== shape.relation.oid)
    bad();
  unique([
    ...shape.catalogClasses, shape.relation, ...shape.indexRelations, ...(shape.toast === null ? [] : [shape.toast.relation, ...shape.toast.indexRelations])
  ], (entry) => JSON.stringify([entry.schema, entry.name]));
  unique([shape.rowType, shape.arrayType], (entry) => JSON.stringify([entry.schema, entry.name]));
  if (shape.columns.length !== 8 || shape.indexes.length !== 1 || shape.indexRelations.length !== 1 || shape.constraints.length !== 1 || shape.triggers.length || shape.rules.length || shape.policies.length || shape.inheritance.length || shape.sequences.length)
    bad();
  const columns = [
    ["store_key", "text"], ["contract", "text"], ["format_version", "integer"], ["owned_schema", "text"], ["table_prefix", "text"], ["owned_scope_hash", "text"], ["model_hash", "text"], ["created_at", "datetime"]
  ] as const;
  const orderedColumns = [...shape.columns].sort((left, right) => Number(left.attnum) - Number(right.attnum));
  for (let index = 0; index < columns.length; index++) {
    const column = orderedColumns[index]!, [name, physicalType] = columns[index]!;
    if (column.relationOid !== shape.relation.oid || column.attnum !== String(index + 1) || column.name !== name || column.physicalType !== physicalType || column.typeOid === "0" || BigInt(column.typeOid) >= 12000n || !column.notNull || column.dropped || !column.local || column.inheritanceCount !== "0" || column.default.kind !== "none" || column.defaultObjectOid !== null || column.generation !== "none" || column.identityCode !== "" || column.generatedCode !== "" || column.collationOid !== column.typeDefaultCollationOid || column.storageCode !== column.typeDefaultStorageCode || column.compressionCode !== "")
      bad();
  }
  if (shape.rowType.relationOid !== shape.relation.oid || shape.rowType.schema !== "public" || shape.rowType.name !== shape.relation.name || shape.rowType.kind !== "composite" || shape.rowType.arrayTypeOid !== shape.arrayType.oid || shape.arrayType.elementTypeOid !== shape.rowType.oid || shape.arrayType.relationOid !== "0" || shape.arrayType.arrayTypeOid !== "0" || shape.arrayType.schema !== "public" || shape.arrayType.kind !== "base" || shape.arrayType.category !== "array")
    bad();
  const index = shape.indexes[0]!, indexRelation = shape.indexRelations[0]!, primary = shape.constraints[0]!;
  if (primary.relationOid !== shape.relation.oid || primary.name !== "__bazis_orm_owned_stores_v1_pkey" || primary.kind !== "primaryKey" || primary.columns.length !== 1 || primary.columns[0] !== "store_key" || primary.referencedRelationOid !== null || primary.referencedColumns.length || primary.backingIndexOid !== index.indexRelationOid || !primary.noInherit || primary.parentConstraintOid !== null || primary.inheritanceCount !== "0" || !primary.validated || primary.deferrable || primary.initiallyDeferred || primary.onDelete !== null || primary.onUpdate !== null || primary.match !== null || primary.deleteSetColumns.length || primary.primaryForeignEqualityOperatorOids.length || primary.primaryPrimaryEqualityOperatorOids.length || primary.foreignForeignEqualityOperatorOids.length || primary.defaultEqualityOperatorOids.length || primary.checkExpression !== null || index.indexRelationOid !== indexRelation.oid || index.tableRelationOid !== shape.relation.oid || index.name !== "__bazis_orm_owned_stores_v1_pkey" || !index.unique || !index.primary || index.exclusion || !index.immediate || !index.valid || !index.ready || !index.live || index.replicaIdentity || index.nullsNotDistinct || index.method !== "btree" || index.keyAttributeCount !== "1" || index.totalAttributeCount !== "1" || index.attributeNumbers.length !== 1 || index.attributeNumbers[0] !== "1" || index.columnNames.length !== 1 || index.columnNames[0] !== "store_key" || index.collationOids.length !== 1 || index.collationOids[0] !== orderedColumns[0]!.typeDefaultCollationOid || index.opclassOids.length !== 1 || index.defaultOpclassOids.length !== 1 || index.opclassOids[0] !== index.defaultOpclassOids[0] || BigInt(index.opclassOids[0]!) >= 12000n || index.options.length !== 1 || index.options[0] !== "0" || index.expression !== null || index.predicate !== null || index.backingConstraintOid !== primary.oid || indexRelation.namespaceOid !== shape.relation.namespaceOid || indexRelation.schema !== "public" || indexRelation.name !== index.name || indexRelation.kind !== "index" || indexRelation.rawKind !== "i" || indexRelation.persistence !== "permanent" || indexRelation.isPartition || indexRelation.rowSecurity || indexRelation.forceRowSecurity || indexRelation.replicaIdentity !== "nothing" || indexRelation.tablespaceOid !== "0" || indexRelation.accessMethod !== "btree" || indexRelation.options.length || indexRelation.rowTypeOid !== null || indexRelation.toastRelationOid !== null)
    bad();
  unique(shape.catalogClasses, (entry) => entry.name);
  for (const entry of shape.catalogClasses)
    if (entry.schema !== "pg_catalog" || entry.kind === "other" || entry.name !== entry.kind)
      bad();
  const classes = new Map(shape.catalogClasses.map((entry) => [entry.name, entry]));
  const classOid = (name: string, kind: OwnedCatalogClassV1["kind"]): string => {
    const entry = classes.get(name);
    if (!entry || entry.schema !== "pg_catalog" || entry.kind !== kind || entry.name !== kind)
      bad();
    return entry.oid;
  };
  const pgClass = classOid("pg_class", "pg_class"), pgType = classOid("pg_type", "pg_type"), pgConstraint = classOid("pg_constraint", "pg_constraint"), pgNamespace = classOid("pg_namespace", "pg_namespace");
  const namespaceBySchema = new Map<string, string>(), schemaByNamespace = new Map<string, string>();
  for (const relation of [
    shape.relation, ...shape.indexRelations, ...(shape.toast === null ? [] : [shape.toast.relation, ...shape.toast.indexRelations])
  ]) {
    const knownNamespace = namespaceBySchema.get(relation.schema), knownSchema = schemaByNamespace.get(relation.namespaceOid);
    if (knownNamespace !== undefined && knownNamespace !== relation.namespaceOid || knownSchema !== undefined && knownSchema !== relation.schema)
      bad();
    namespaceBySchema.set(relation.schema, relation.namespaceOid);
    schemaByNamespace.set(relation.namespaceOid, relation.schema);
  }
  const dependencies = [...shape.dependencies, ...(shape.toast?.dependencies ?? [])];
  const remaining = new Set(dependencies.map((_edge, position) => position));
  const consume = (dependentClassOid: string, dependentOid: string, dependentSubId: string, referencedClassOid: string, referencedOid: string, referencedSubId: string, kind: OwnedCatalogDependencyV1["kind"]): void => {
    const matches = [...remaining].filter((position) => {
      const edge = dependencies[position]!;
      return edge.dependentClassOid === dependentClassOid && edge.dependentOid === dependentOid && edge.dependentSubId === dependentSubId && edge.referencedClassOid === referencedClassOid && edge.referencedOid === referencedOid && edge.referencedSubId === referencedSubId && edge.kind === kind;
    });
    if (matches.length !== 1)
      bad();
    remaining.delete(matches[0]!);
  };
  const rejectDirect = (dependentClassOid: string, dependentOid: string, referencedClassOid: string, referencedOid: string): void => {
    if (dependencies.some((edge) => edge.dependentClassOid === dependentClassOid && edge.dependentOid === dependentOid && edge.referencedClassOid === referencedClassOid && edge.referencedOid === referencedOid))
      bad();
  };
  if (shape.relation.namespaceOid === "2200" || BigInt(shape.relation.namespaceOid) >= 12000n)
    consume(pgClass, shape.relation.oid, "0", pgNamespace, shape.relation.namespaceOid, "0", "normal");
  else
    rejectDirect(pgClass, shape.relation.oid, pgNamespace, shape.relation.namespaceOid);
  consume(pgType, shape.rowType.oid, "0", pgClass, shape.relation.oid, "0", "internal");
  consume(pgType, shape.arrayType.oid, "0", pgType, shape.rowType.oid, "0", "internal");
  consume(pgConstraint, primary.oid, "0", pgClass, shape.relation.oid, "1", "automatic");
  consume(pgClass, indexRelation.oid, "0", pgConstraint, primary.oid, "0", "internal");
  rejectDirect(pgClass, indexRelation.oid, pgNamespace, indexRelation.namespaceOid);
  if (shape.toast !== null) {
    if (shape.toast.columns.length !== 3 || shape.toast.indexes.length !== 1 || shape.toast.indexRelations.length !== 1 || shape.toast.columns.some((column) => column.relationOid !== shape.toast!.relation.oid))
      bad();
    const toastRelations = new Map<string, OwnedCatalogRelationV1>([
      [shape.relation.oid, shape.relation],
      [shape.toast.relation.oid, shape.toast.relation],
      ...shape.toast.indexRelations.map((relation) => [relation.oid, relation] as const),
    ]);
    const toastColumns = new Map<string, OwnedCatalogColumnV1[]>([[shape.toast.relation.oid, [...shape.toast.columns]]]);
    const toastIndexes = new Map<string, OwnedCatalogIndexV1[]>([[shape.toast.relation.oid, [...shape.toast.indexes]]]);
    validateToastClosureV1(shape.relation, toastRelations, toastColumns, toastIndexes, new Set<string>(), pgClass, pgNamespace, consume, rejectDirect);
  }
  if (remaining.size)
    bad();
}
export function verifyOwnedStoreCatalogAllV1(snapshot: OwnedStoreCatalogSnapshotV1, context: OwnedStoreCatalogSemanticContextV1): void {
  const analysis = analyzeOwnedStoreCatalogContextV1(snapshot, context);
  verifyOwnedStoreCatalogModelsV1(snapshot, analysis, analysis.stores);
}
export function inspectOwnedStoreCatalogPreCreateV1(snapshot: OwnedStoreCatalogSnapshotV1, registry: OwnedStoreRegistrySnapshotV1, context: OwnedStoreCatalogSemanticContextV1): {
  readonly kind: "ready";
  readonly emptyMissingIdentityStoreKeys: readonly string[];
} | {
  readonly kind: "occupiedMissingIdentity";
  readonly storeKeys: readonly string[];
} {
  const analysis = analyzeOwnedStoreCatalogContextV1(snapshot, context);
  if (registry.state.kind === "present" && !registry.publicSchemaExists)
    bad();
  if (registry.state.kind === "present")
    validateFixedRegistryShapeV1(registry.state.shape);
  const identities = new Set(registry.state.kind === "present" ? registry.state.rows.map((row) => row.storeKey) : []);
  const occupied = analysis.stores.filter((store) => snapshot.relations.some((relation) => relation.schema === store.definition.ownedScope.schema && relation.name.startsWith(store.definition.ownedScope.tablePrefix)));
  const missingOccupied = occupied.filter((store) => !identities.has(store.definition.storeKey));
  if (missingOccupied.length)
    return Object.freeze({
      kind: "occupiedMissingIdentity" as const, storeKeys: Object.freeze(missingOccupied.map((store) => store.definition.storeKey))
    });
  const missing = analysis.stores.filter((store) => !identities.has(store.definition.storeKey));
  for (const store of analysis.stores)
    if (identities.has(store.definition.storeKey) && (analysis.rootsByStoreKey.get(store.definition.storeKey)?.length ?? 0) === 0)
      bad();
  verifyOwnedStoreCatalogModelsV1(snapshot, analysis, analysis.stores.filter((store) => identities.has(store.definition.storeKey)));
  return Object.freeze({
    kind: "ready" as const, emptyMissingIdentityStoreKeys: Object.freeze(missing.map((store) => store.definition.storeKey))
  });
}
function verifyOwnedStoreCatalogModelsV1(snapshot: OwnedStoreCatalogSnapshotV1, analysis: OwnedStoreCatalogOwnershipAnalysisV1, modelStores: readonly OwnedStoreCatalogStoreExpectationV1[]): void {
  unique([...snapshot.catalogClasses, ...snapshot.relations], (entry) => JSON.stringify([entry.schema, entry.name]));
  unique([...snapshot.rowTypes, ...snapshot.arrayTypes], (entry) => JSON.stringify([entry.schema, entry.name]));
  const tableKey = (schema: string, table: string): string => JSON.stringify([schema, table]);
  const expectedTables = new Map(modelStores.flatMap((store) => store.expectedSchema.tables).map((table) => [tableKey(table.schema, table.table), table]));
  const relations = new Map(snapshot.relations.map((relation) => [relation.oid, relation]));
  const owned = new Set([...analysis.rootsByStoreKey.values()].flatMap((roots) => roots.map((relation) => relation.oid)));
  const namespaceBySchema = new Map<string, string>(), schemaByNamespace = new Map<string, string>();
  for (const relation of snapshot.relations) {
    const knownNamespace = namespaceBySchema.get(relation.schema), knownSchema = schemaByNamespace.get(relation.namespaceOid);
    if (knownNamespace !== undefined && knownNamespace !== relation.namespaceOid || knownSchema !== undefined && knownSchema !== relation.schema)
      bad();
    namespaceBySchema.set(relation.schema, relation.namespaceOid);
    schemaByNamespace.set(relation.namespaceOid, relation.schema);
  }
  const attrdefOwners = new Set<string>();
  for (const column of snapshot.columns)
    if (column.defaultObjectOid !== null) {
      if (attrdefOwners.has(column.defaultObjectOid))
        bad();
      attrdefOwners.add(column.defaultObjectOid);
    }
  unique(snapshot.rowTypes, (rowType) => rowType.relationOid);
  unique(snapshot.arrayTypes, (arrayType) => arrayType.elementTypeOid);
  unique(snapshot.catalogClasses, (entry) => entry.name);
  for (const entry of snapshot.catalogClasses)
    if (entry.schema !== "pg_catalog" || entry.kind === "other" || entry.name !== entry.kind)
      bad();
  const classes = new Map(snapshot.catalogClasses.map((entry) => [entry.name, entry]));
  const classOid = (name: string, kind: OwnedCatalogClassV1["kind"]): string => {
    const entry = classes.get(name);
    if (!entry || entry.schema !== "pg_catalog" || entry.kind !== kind)
      bad();
    return entry.oid;
  };
  const pgClass = classOid("pg_class", "pg_class"), pgType = classOid("pg_type", "pg_type"), pgConstraint = classOid("pg_constraint", "pg_constraint"), pgAttrdef = classOid("pg_attrdef", "pg_attrdef"), pgNamespace = classOid("pg_namespace", "pg_namespace");
  const remaining = new Set(snapshot.dependencies.map((_edge, index) => index));
  const dependencyKey = (dependentClassOid: string, dependentOid: string, dependentSubId: string, referencedClassOid: string, referencedOid: string, referencedSubId: string, kind: OwnedCatalogDependencyV1["kind"]): string => JSON.stringify([
    dependentClassOid, dependentOid, dependentSubId, referencedClassOid, referencedOid, referencedSubId, kind
  ]);
  const directKey = (dependentClassOid: string, dependentOid: string, referencedClassOid: string, referencedOid: string): string => JSON.stringify([dependentClassOid, dependentOid, referencedClassOid, referencedOid]);
  const dependencyIndexes = new Map<string, number[]>(), directDependencyIndexes = new Map<string, number[]>();
  for (let index = 0; index < snapshot.dependencies.length; index++) {
    const edge = snapshot.dependencies[index]!, exact = dependencyKey(edge.dependentClassOid, edge.dependentOid, edge.dependentSubId, edge.referencedClassOid, edge.referencedOid, edge.referencedSubId, edge.kind), direct = directKey(edge.dependentClassOid, edge.dependentOid, edge.referencedClassOid, edge.referencedOid);
    const exactIndexes = dependencyIndexes.get(exact), directIndexes = directDependencyIndexes.get(direct);
    if (exactIndexes)
      exactIndexes.push(index);
    else
      dependencyIndexes.set(exact, [index]);
    if (directIndexes)
      directIndexes.push(index);
    else
      directDependencyIndexes.set(direct, [index]);
  }
  const consume = (dependentClassOid: string, dependentOid: string, dependentSubId: string, referencedClassOid: string, referencedOid: string, referencedSubId: string, kind: OwnedCatalogDependencyV1["kind"], count = 1): void => {
    const matches = dependencyIndexes.get(dependencyKey(dependentClassOid, dependentOid, dependentSubId, referencedClassOid, referencedOid, referencedSubId, kind)) ?? [];
    for (const index of matches)
      if (!remaining.delete(index))
        bad();
    if (matches.length !== count)
      bad();
  };
  const rejectDirect = (dependentClassOid: string, dependentOid: string, referencedClassOid: string, referencedOid: string): void => {
    if ((directDependencyIndexes.get(directKey(dependentClassOid, dependentOid, referencedClassOid, referencedOid)) ?? []).length)
      bad();
  };
  const columns = new Map<string, OwnedCatalogColumnV1[]>();
  for (const column of snapshot.columns) {
    const entries = columns.get(column.relationOid) ?? [];
    entries.push(column);
    columns.set(column.relationOid, entries);
  }
  const constraints = new Map<string, OwnedCatalogConstraintV1[]>();
  for (const constraint of snapshot.constraints) {
    const entries = constraints.get(constraint.relationOid) ?? [];
    entries.push(constraint);
    constraints.set(constraint.relationOid, entries);
  }
  const indexes = new Map<string, OwnedCatalogIndexV1[]>();
  for (const index of snapshot.indexes) {
    const entries = indexes.get(index.tableRelationOid) ?? [];
    entries.push(index);
    indexes.set(index.tableRelationOid, entries);
  }
  const consumedTriggerOids = new Set<string>();
  const sequences = new Map(snapshot.sequences.map((sequence) => [sequence.relationOid, sequence]));
  const consumedSequenceRelationOids = new Set<string>();
  const consumedToastRelationOids = new Set<string>();
  const declaredToastRelationOids = new Set(snapshot.relations.flatMap((relation) => relation.kind === "ordinaryTable" && relation.toastRelationOid !== null ? [relation.toastRelationOid] : []));
  const identityCandidates = new Map<string, OwnedCatalogSequenceV1[]>();
  for (const edge of snapshot.dependencies) {
    const sequence = sequences.get(edge.dependentOid);
    if (!sequence || edge.dependentClassOid !== pgClass || edge.dependentSubId !== "0" || edge.referencedClassOid !== pgClass || edge.kind !== "internal")
      continue;
    const key = JSON.stringify([edge.referencedOid, edge.referencedSubId]), candidates = identityCandidates.get(key);
    if (candidates)
      candidates.push(sequence);
    else
      identityCandidates.set(key, [sequence]);
  }
  const validateToast = (owner: OwnedCatalogRelationV1): void => validateToastClosureV1(owner, relations, columns, indexes, consumedToastRelationOids, pgClass, pgNamespace, consume, rejectDirect);
  for (const constraint of snapshot.constraints) {
    if (constraint.kind === "primaryKey") {
      const index = snapshot.indexes.find((entry) => entry.indexRelationOid === constraint.backingIndexOid);
      if (!index || index.name !== constraint.name || index.columnNames.length !== constraint.columns.length || index.columnNames.some((name, indexValue) => name !== constraint.columns[indexValue]))
        bad();
    }
    if (constraint.kind === "check") {
      const names = new Set<string>();
      if (constraint.checkExpression === null)
        bad();
      projectCheckAstIdentifiers(constraint.checkExpression, (name) => {
        names.add(name);
        return name;
      });
      if (constraint.columns.length !== names.size || constraint.columns.some((name) => !names.has(name)) || constraint.referencedColumns.length)
        bad();
    }
  }
  const rowTypes = new Map(snapshot.rowTypes.map((rowType) => [rowType.relationOid, rowType]));
  const arrays = new Map(snapshot.arrayTypes.map((arrayType) => [arrayType.elementTypeOid, arrayType]));
  const tables = new Map<string, IntrospectedTable>();
  for (const relation of snapshot.relations) {
    if (relation.kind === "index" || relation.kind === "sequence" || relation.kind === "toastTable")
      continue;
    const key = tableKey(relation.schema, relation.name), expectedTable = expectedTables.get(key), scope = snapshot.requestedScopes.find((entry) => entry.schema === relation.schema && relation.name.startsWith(entry.tablePrefix));
    if (!expectedTable || !scope || !snapshot.existingSchemas.includes(relation.schema) || relation.kind !== "ordinaryTable" || relation.rawKind !== "r" || relation.persistence !== "permanent" || relation.isPartition || relation.rowSecurity || relation.forceRowSecurity || relation.replicaIdentity !== "default" || relation.tablespaceOid !== "0" || relation.accessMethod !== "heap" || relation.options.length || relation.rowTypeOid === null)
      bad();
    const rowType = rowTypes.get(relation.oid), arrayType = rowType ? arrays.get(rowType.oid) : undefined;
    if (!rowType || !arrayType || rowType.oid !== relation.rowTypeOid || rowType.schema !== relation.schema || rowType.name !== relation.name || rowType.kind !== "composite" || rowType.arrayTypeOid !== arrayType.oid || arrayType.schema !== relation.schema || arrayType.relationOid !== "0" || arrayType.arrayTypeOid !== "0" || arrayType.kind !== "base" || arrayType.category !== "array")
      bad();
    consume(pgType, rowType.oid, "0", pgClass, relation.oid, "0", "internal");
    consume(pgType, arrayType.oid, "0", pgType, rowType.oid, "0", "internal");
    if (relation.namespaceOid === "2200" || BigInt(relation.namespaceOid) >= 12000n)
      consume(pgClass, relation.oid, "0", pgNamespace, relation.namespaceOid, "0", "normal");
    else
      rejectDirect(pgClass, relation.oid, pgNamespace, relation.namespaceOid);
    validateToast(relation);
    const actualColumns = new Map<string, {
      readonly name: string;
      readonly notNull: boolean;
      readonly isPrimaryKey: boolean;
      readonly physicalType: string;
      readonly default: CanonicalDefault;
      readonly generation: "none" | "identityByDefault" | "uuidDefault";
    }>();
    const tableColumns = columns.get(relation.oid) ?? [];
    if (snapshot.columns.some((column) => !owned.has(column.relationOid) && !declaredToastRelationOids.has(column.relationOid)) || tableColumns.length !== expectedTable.columns.length)
      bad();
    const orderedColumns = [...tableColumns].sort((a, b) => Number(a.attnum) - Number(b.attnum));
    for (let index = 0; index < orderedColumns.length; index++) {
      const column = orderedColumns[index]!, modelColumn = expectedTable.columns[index]!;
      if (column.name !== modelColumn.column || column.attnum !== String(index + 1) || column.dropped || !column.local || column.inheritanceCount !== "0" || column.typeOid === "0" || BigInt(column.typeOid) >= 12000n || !["integer", "real", "text", "boolean", "datetime", "json", "uuid"].includes(column.physicalType) || column.collationOid !== column.typeDefaultCollationOid || column.storageCode !== column.typeDefaultStorageCode || column.compressionCode !== "" || column.generation === "other")
        bad();
      const expectedGeneration = modelColumn.generation;
      if (column.generation !== expectedGeneration || (column.generation === "none" && (column.identityCode !== "" || column.generatedCode !== "")) || (column.generation === "identityByDefault" && (column.identityCode !== "d" || column.generatedCode !== "")) || (column.generation === "uuidDefault" && (column.identityCode !== "" || column.generatedCode !== "")))
        bad();
      if (column.default.kind === "none") {
        if (column.defaultObjectOid !== null)
          bad();
      }
      else {
        if (column.defaultObjectOid === null)
          bad();
        consume(pgAttrdef, column.defaultObjectOid, "0", pgClass, relation.oid, column.attnum, "automatic");
      }
      if (expectedGeneration === "identityByDefault") {
        if (column.physicalType !== "integer" || column.default.kind !== "none" || column.defaultObjectOid !== null)
          bad();
        const candidates = identityCandidates.get(JSON.stringify([relation.oid, column.attnum])) ?? [];
        if (candidates.length !== 1)
          bad();
        const sequence = candidates[0]!, sequenceRelation = relations.get(sequence.relationOid);
        if (!sequenceRelation || sequenceRelation.kind !== "sequence" || sequenceRelation.rawKind !== "S" || sequenceRelation.persistence !== "permanent" || sequenceRelation.schema !== relation.schema || sequenceRelation.namespaceOid !== relation.namespaceOid || sequenceRelation.isPartition || sequenceRelation.rowSecurity || sequenceRelation.forceRowSecurity || sequenceRelation.replicaIdentity !== "nothing" || sequenceRelation.tablespaceOid !== "0" || sequenceRelation.accessMethod !== null || sequenceRelation.options.length || sequenceRelation.rowTypeOid !== null || sequenceRelation.toastRelationOid !== null || sequence.type !== "bigint" || sequence.start !== "1" || sequence.increment !== "1" || sequence.minimum !== "1" || sequence.maximum !== "9223372036854775807" || sequence.cache !== "1" || sequence.cycle || consumedSequenceRelationOids.has(sequence.relationOid))
          bad();
        consumedSequenceRelationOids.add(sequence.relationOid);
        consume(pgClass, sequence.relationOid, "0", pgClass, relation.oid, column.attnum, "internal");
        if (sequenceRelation.namespaceOid === "2200" || BigInt(sequenceRelation.namespaceOid) >= 12000n)
          consume(pgClass, sequenceRelation.oid, "0", pgNamespace, sequenceRelation.namespaceOid, "0", "normal");
        else
          rejectDirect(pgClass, sequenceRelation.oid, pgNamespace, sequenceRelation.namespaceOid);
      }
      actualColumns.set(column.name, {
        name: column.name, notNull: column.notNull, isPrimaryKey: false, physicalType: column.physicalType, default: column.default, generation: column.generation
      });
    }
    const own = constraints.get(relation.oid) ?? [], primary = own.filter((constraint) => constraint.kind === "primaryKey");
    if (primary.length !== 1)
      bad();
    const pk = primary[0]!;
    if (pk.name !== expectedTable.primaryKey.name || pk.backingIndexOid === null || pk.referencedRelationOid !== null || !pk.noInherit || pk.parentConstraintOid !== null || pk.inheritanceCount !== "0" || !pk.validated || pk.deferrable || pk.initiallyDeferred || pk.checkExpression !== null || pk.referencedColumns.length || pk.onDelete !== null || pk.onUpdate !== null || pk.match !== null || pk.deleteSetColumns.length || pk.primaryForeignEqualityOperatorOids.length || pk.primaryPrimaryEqualityOperatorOids.length || pk.foreignForeignEqualityOperatorOids.length || pk.defaultEqualityOperatorOids.length || pk.columns.length !== expectedTable.primaryKey.columns.length || pk.columns.some((name, index) => name !== expectedTable.primaryKey.columns[index]))
      bad();
    for (const name of pk.columns) {
      const column = tableColumns.find((entry) => entry.name === name), actual = actualColumns.get(name);
      if (!column || !actual)
        bad();
      consume(pgConstraint, pk.oid, "0", pgClass, relation.oid, column.attnum, "automatic");
      actualColumns.set(name, { ...actual, isPrimaryKey: true });
    }
    const tableIndexes = indexes.get(relation.oid) ?? [], backing = tableIndexes.find((index) => index.indexRelationOid === pk.backingIndexOid);
    if (!backing || !backing.primary || !backing.unique || backing.backingConstraintOid !== pk.oid)
      bad();
    const validateIndex = (index: OwnedCatalogIndexV1, primary: boolean): readonly string[] => {
      const indexRelation = relations.get(index.indexRelationOid);
      if (!indexRelation || indexRelation.kind !== "index" || indexRelation.schema !== relation.schema || indexRelation.namespaceOid !== relation.namespaceOid || indexRelation.name !== index.name || index.method !== "btree" || index.primary !== primary || index.unique !== (primary || index.unique) || index.exclusion || !index.immediate || !index.valid || !index.ready || !index.live || index.replicaIdentity || index.nullsNotDistinct || index.expression !== null || index.predicate !== null || index.keyAttributeCount !== index.totalAttributeCount || index.attributeNumbers.length !== Number(index.keyAttributeCount) || index.columnNames.length !== Number(index.totalAttributeCount) || index.collationOids.length !== Number(index.keyAttributeCount) || index.opclassOids.length !== Number(index.keyAttributeCount) || index.defaultOpclassOids.length !== Number(index.keyAttributeCount) || index.options.length !== Number(index.keyAttributeCount) || index.attributeNumbers.some((value, position) => value !== String(tableColumns.find((column) => column.name === index.columnNames[position])?.attnum ?? "")) || index.columnNames.some((name) => name === null) || index.options.some((value) => value !== "0") || index.opclassOids.some((value, position) => value !== index.defaultOpclassOids[position] || BigInt(value) >= 12000n) || index.collationOids.some((value, position) => value !== tableColumns.find((column) => column.name === index.columnNames[position])?.typeDefaultCollationOid))
        bad();
      return index.columnNames as readonly string[];
    };
    validateIndex(backing, true);
    consume(pgClass, backing.indexRelationOid, "0", pgConstraint, pk.oid, "0", "internal");
    const ordinary = tableIndexes.filter((index) => index.indexRelationOid !== backing.indexRelationOid).map((index) => {
      if (index.backingConstraintOid !== null)
        bad();
      const names = validateIndex(index, false);
      for (const name of names) {
        const column = tableColumns.find((entry) => entry.name === name);
        if (!column)
          bad();
        consume(pgClass, index.indexRelationOid, "0", pgClass, relation.oid, column.attnum, "automatic");
      }
      return { name: index.name, columns: names, unique: index.unique, method: "btree" as const };
    });
    const foreignKeys = own.filter((constraint) => constraint.kind === "foreignKey"), checks = own.filter((constraint) => constraint.kind === "check");
    if (own.length !== 1 + foreignKeys.length + checks.length || snapshot.rules.some((rule) => rule.relationOid === relation.oid) || snapshot.policies.some((policy) => policy.relationOid === relation.oid) || snapshot.inheritance.some((entry) => entry.childRelationOid === relation.oid || entry.parentRelationOid === relation.oid))
      bad();
    for (const constraint of foreignKeys) {
      if (constraint.referencedRelationOid === null || !constraint.noInherit || constraint.parentConstraintOid !== null || constraint.inheritanceCount !== "0" || !constraint.validated || constraint.deferrable || constraint.initiallyDeferred || constraint.match !== "simple" || constraint.deleteSetColumns.length || constraint.backingIndexOid === null || constraint.checkExpression !== null)
        bad();
      const target = relations.get(constraint.referencedRelationOid);
      if (!target || !owned.has(target.oid) || target.kind !== "ordinaryTable")
        bad();
      const targetPrimary = (constraints.get(target.oid) ?? []).filter((entry) => entry.kind === "primaryKey");
      if (targetPrimary.length !== 1)
        bad();
      const targetPk = targetPrimary[0]!, targetColumns = columns.get(target.oid) ?? [];
      const targetIndex = (indexes.get(target.oid) ?? []).find((entry) => entry.indexRelationOid === targetPk.backingIndexOid);
      if (targetPk.backingIndexOid === null || constraint.backingIndexOid !== targetPk.backingIndexOid || !targetIndex || targetIndex.tableRelationOid !== target.oid || targetIndex.columnNames.length !== targetPk.columns.length || targetIndex.columnNames.some((name, position) => name !== targetPk.columns[position]) || targetIndex.attributeNumbers.some((attnum, position) => attnum !== targetColumns.find((column) => column.name === targetPk.columns[position])?.attnum))
        bad();
      const vectors = [
        constraint.primaryForeignEqualityOperatorOids, constraint.primaryPrimaryEqualityOperatorOids, constraint.foreignForeignEqualityOperatorOids, constraint.defaultEqualityOperatorOids
      ];
      if (!constraint.columns.length || constraint.referencedColumns.length !== constraint.columns.length || vectors.some((vector) => vector.length !== constraint.columns.length) || constraint.referencedColumns.some((name, position) => name !== targetPk.columns[position]))
        bad();
      for (let position = 0; position < constraint.columns.length; position++) {
        const defaultOperator = constraint.defaultEqualityOperatorOids[position]!;
        if (BigInt(defaultOperator) >= 12000n || constraint.primaryForeignEqualityOperatorOids[position] !== defaultOperator || constraint.primaryPrimaryEqualityOperatorOids[position] !== defaultOperator || constraint.foreignForeignEqualityOperatorOids[position] !== defaultOperator)
          bad();
      }
      const sourceKeys = new Set<string>(), targetKeys = new Set<string>();
      for (const name of constraint.columns) {
        const column = tableColumns.find((entry) => entry.name === name);
        if (!column)
          bad();
        sourceKeys.add(column.attnum);
      }
      for (const name of constraint.referencedColumns) {
        const column = targetColumns.find((entry) => entry.name === name);
        if (!column)
          bad();
        targetKeys.add(column.attnum);
      }
      for (const attnum of sourceKeys)
        consume(pgConstraint, constraint.oid, "0", pgClass, relation.oid, attnum, "automatic");
      for (const attnum of targetKeys)
        consume(pgConstraint, constraint.oid, "0", pgClass, target.oid, attnum, "normal");
      consume(pgConstraint, constraint.oid, "0", pgClass, targetIndex.indexRelationOid, "0", "normal");
      const pgTrigger = classOid("pg_trigger", "pg_trigger"), pgProc = classOid("pg_proc", "pg_proc");
      const actionNames = new Map<string, string>([["noAction", "noaction"], ["restrict", "restrict"], ["cascade", "cascade"], ["setNull", "setnull"]]);
      const deleteAction = constraint.onDelete === null ? undefined : actionNames.get(constraint.onDelete), updateAction = constraint.onUpdate === null ? undefined : actionNames.get(constraint.onUpdate);
      if (!deleteAction || !updateAction)
        bad();
      const roles = [
        { relationOid: relation.oid, functionName: "RI_FKey_check_ins", typeBits: "5" },
        { relationOid: relation.oid, functionName: "RI_FKey_check_upd", typeBits: "17" },
        { relationOid: target.oid, functionName: `RI_FKey_${deleteAction}_del`, typeBits: "9" },
        { relationOid: target.oid, functionName: `RI_FKey_${updateAction}_upd`, typeBits: "17" },
      ];
      const foreignKeyTriggers = snapshot.triggers.filter((trigger) => trigger.constraintOid === constraint.oid);
      if (foreignKeyTriggers.length !== roles.length)
        bad();
      for (const role of roles) {
        const matches = foreignKeyTriggers.filter((trigger) => trigger.relationOid === role.relationOid && trigger.internal && trigger.parentTriggerOid === null && trigger.enabled === "origin" && trigger.functionSchema === "pg_catalog" && trigger.functionName === role.functionName && trigger.typeBits === role.typeBits && BigInt(trigger.functionOid) < 12000n);
        if (matches.length !== 1)
          bad();
        const trigger = matches[0]!;
        if (consumedTriggerOids.has(trigger.oid))
          bad();
        consumedTriggerOids.add(trigger.oid);
        consume(pgTrigger, trigger.oid, "0", pgConstraint, constraint.oid, "0", "internal");
        rejectDirect(pgTrigger, trigger.oid, pgProc, trigger.functionOid);
      }
    }
    for (const constraint of checks) {
      if (constraint.referencedRelationOid !== null || constraint.backingIndexOid !== null || constraint.noInherit || constraint.parentConstraintOid !== null || constraint.inheritanceCount !== "0" || !constraint.validated || constraint.deferrable || constraint.initiallyDeferred || constraint.onDelete !== null || constraint.onUpdate !== null || constraint.match !== null || constraint.deleteSetColumns.length || constraint.primaryForeignEqualityOperatorOids.length || constraint.primaryPrimaryEqualityOperatorOids.length || constraint.foreignForeignEqualityOperatorOids.length || constraint.defaultEqualityOperatorOids.length || constraint.checkExpression === null)
        bad();
      const names = new Set<string>();
      projectCheckAstIdentifiers(constraint.checkExpression, (name) => {
        names.add(name);
        return name;
      });
      if (constraint.columns.length !== names.size || constraint.columns.some((name) => !names.has(name)))
        bad();
      for (const name of names) {
        const column = tableColumns.find((entry) => entry.name === name);
        if (!column)
          bad();
        consume(pgConstraint, constraint.oid, "0", pgClass, relation.oid, column.attnum, "automatic");
        consume(pgConstraint, constraint.oid, "0", pgClass, relation.oid, column.attnum, "normal");
      }
    }
    tables.set(key, {
      name: relation.name, columns: actualColumns, primaryKey: { name: pk.name, columns: pk.columns }, indexes: ordinary, foreignKeys: foreignKeys.map((constraint) => {
        const target = relations.get(constraint.referencedRelationOid!);
        if (!target)
          bad();
        return {
          name: constraint.name, columns: constraint.columns, targetSchema: target.schema, targetTable: target.name, targetColumns: constraint.referencedColumns, onDelete: constraint.onDelete ?? "", onUpdate: constraint.onUpdate ?? ""
        };
      }), checks: checks.map((constraint) => ({ name: constraint.name, expression: constraint.checkExpression! }))
    });
  }
  for (const relation of snapshot.relations.filter((entry) => entry.kind === "index")) {
    const index = snapshot.indexes.find((entry) => entry.indexRelationOid === relation.oid);
    if (!index || relation.rawKind !== "i" || relation.persistence !== "permanent" || relation.isPartition || relation.rowSecurity || relation.forceRowSecurity || relation.replicaIdentity !== "nothing" || relation.tablespaceOid !== "0" || relation.accessMethod !== "btree" || relation.options.length || relation.rowTypeOid !== null || relation.toastRelationOid !== null)
      bad();
    rejectDirect(pgClass, relation.oid, pgNamespace, relation.namespaceOid);
  }
  if (rowTypes.size !== owned.size || arrays.size !== owned.size || snapshot.rowTypes.some((rowType) => !owned.has(rowType.relationOid)) || snapshot.arrayTypes.some((arrayType) => !snapshot.rowTypes.some((rowType) => rowType.oid === arrayType.elementTypeOid)) || snapshot.columns.some((column) => !owned.has(column.relationOid) && !consumedToastRelationOids.has(column.relationOid)) || snapshot.indexes.some((index) => !owned.has(index.tableRelationOid) && !consumedToastRelationOids.has(index.tableRelationOid)) || snapshot.constraints.some((constraint) => !owned.has(constraint.relationOid)) || snapshot.rules.some((rule) => !owned.has(rule.relationOid)) || snapshot.policies.some((policy) => !owned.has(policy.relationOid)) || snapshot.inheritance.length || snapshot.relations.some((relation) => relation.kind !== "ordinaryTable" && relation.kind !== "index" && (relation.kind !== "sequence" || !consumedSequenceRelationOids.has(relation.oid)) && (relation.kind !== "toastTable" || !consumedToastRelationOids.has(relation.oid))) || tables.size !== expectedTables.size || consumedTriggerOids.size !== snapshot.triggers.length || consumedSequenceRelationOids.size !== snapshot.sequences.length || consumedToastRelationOids.size !== declaredToastRelationOids.size || remaining.size)
    bad();
  for (const store of modelStores) {
    const projection = new Map<string, IntrospectedTable>();
    for (const relation of analysis.rootsByStoreKey.get(store.definition.storeKey) ?? []) {
      const key = `${relation.schema}.${relation.name}`, table = tables.get(tableKey(relation.schema, relation.name));
      if (!table)
        bad();
      projection.set(key, table);
    }
    if (!new ExactSchemaVerifier().verify(store.expectedSchema, { tables: projection }, false).compatible)
      bad();
  }
}
