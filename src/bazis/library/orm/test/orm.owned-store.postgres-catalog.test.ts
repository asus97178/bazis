import { expect, test } from "bun:test";
import { Column, Entity, Key, OrmModel, defineOrmOwnedStoreV1 } from "bazis/library/orm";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreScopeHashV1 } from "../Schema/OwnedStoreCanonical";
import { inspectOwnedStoreCatalogPreCreateV1, parseCanonicalDefaultV1, parseCheckAstV1, parseOwnedCatalogArrayTypeV1, parseOwnedCatalogClassV1, parseOwnedCatalogColumnV1, parseOwnedCatalogConstraintV1, parseOwnedCatalogDependencyV1, parseOwnedCatalogIndexV1, parseOwnedCatalogInheritanceV1, parseOwnedCatalogPolicyV1, parseOwnedCatalogRelationV1, parseOwnedCatalogRowTypeV1, parseOwnedCatalogRuleV1, parseOwnedCatalogSequenceV1, parseOwnedCatalogTriggerV1, parseOwnedStoreCatalogSnapshotV1, parseOwnedStoreRegistrySnapshotV1, validateOwnedStoreRegistryV1, verifyOwnedStoreCatalogAllV1, type OwnedStoreCatalogSnapshotV1 } from "../Schema/OwnedStoreCatalog";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";
import type { CanonicalDefault } from "../Schema/introspection";
import type { CheckAst } from "../Schema/CheckExpression";
import { OrmOwnedStoreAdmissionError } from "../errors";

const definition = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "bazis_td_" } });
const catalogContext = Object.freeze({ maxIdentifierLength: 63n });
const row = () => ({ storeKey: "fixtures", contract: definition.contract, formatVersion: "1", ownedSchema: "public", tablePrefix: "bazis_td_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition), modelHash: "sha256:6c0255eeb7a9e5cb0cba9c6ba37cd41a87fabbc6fbc15dd1625a4d157f8e4237", createdAtEpochMicroseconds: "0" });
const rowFor = (storeKey: string, tablePrefix: string) => ({ ...row(), storeKey, tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1({ contract: "bazis.orm-owned-store/v1", storeKey, formatVersion: 1, ownedScope: { schema: "public", tablePrefix } }) });

test("owned registry accepts the exact tagged row and rejects malformed catalog data", () => {
  expect(validateOwnedStoreRegistryV1([row()], [definition])).toHaveLength(1);
  for (const value of [[{ ...row(), modelHash: "e111" }], [{ ...row(), createdAtEpochMicroseconds: "01" }], Array.from({ length: 4097 }, row), [{ ...row(), ownedScopeHash: "sha256:0".repeat(64) }]]) {
    expect(() => validateOwnedStoreRegistryV1(value, [definition])).toThrow("ORM_OWNED_STORE_DRIFT");
  }
});

test("registry row copies frozen null-prototype data without invoking getters", () => {
  const value = Object.freeze(Object.assign(Object.create(null), row()));
  const parsed = validateOwnedStoreRegistryV1(Object.freeze([value]), [definition]);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed[0]!)).toBe(true);
  let called = false;
  const accessor = { ...row() };
  Object.defineProperty(accessor, "storeKey", { get() { called = true; return "fixtures"; } });
  expect(() => validateOwnedStoreRegistryV1([accessor], [definition])).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(called).toBe(false);
});

test("registry rejects proxies, sparse/extended arrays, scalar bounds and conflicts", () => {
  const sparse = [] as unknown[]; sparse[1] = row();
  const extended = [row()] as unknown[]; Object.defineProperty(extended, "4294967295", { value: row() });
  for (const value of [new Proxy([row()], {}), sparse, extended, [{ ...row(), formatVersion: "0" }], [{ ...row(), ownedScopeHash: "sha256:BAD" }]]) {
    expect(() => validateOwnedStoreRegistryV1(value, [definition])).toThrow();
  }
  expect(() => validateOwnedStoreRegistryV1([row(), row()], [definition])).toThrow("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  expect(() => validateOwnedStoreRegistryV1([rowFor("other", "bazis_"), row()], [])).toThrow("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  expect(() => validateOwnedStoreRegistryV1([{ ...row(), ownedScopeHash: "sha256:".concat("0".repeat(64)) }], [definition])).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => validateOwnedStoreRegistryV1([rowFor("fixtures", "different_")], [definition])).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("registry validates every row scope hash and Unicode pairs before identity", () => {
  const astral = rowFor("other😀", "other_😀");
  expect(validateOwnedStoreRegistryV1([astral], [])).toHaveLength(1);
  expect(() => validateOwnedStoreRegistryV1([{ ...astral, ownedScopeHash: row().ownedScopeHash }], [])).toThrow("ORM_OWNED_STORE_DRIFT");
  const revoked = Proxy.revocable([row()], {}); revoked.revoke();
  expect(() => validateOwnedStoreRegistryV1(revoked.proxy, [definition])).toThrow("ORM_OWNED_STORE_DRIFT");
});

@Entity({ table: "bazis_td_version_fixture" })
class RegistryVersionFixture { @Key({ name: "pk_bazis_td_version_fixture" }) @Column({ type: "integer" }) id = 0; }

test("registry distinguishes a coherent version tuple from scope-hash drift before requested identity", () => {
  const expected = compileExpectedSchema(new OrmModel([RegistryVersionFixture]));
  const version2 = defineOrmOwnedStoreV1({ contract: definition.contract, storeKey: definition.storeKey, formatVersion: 2, ownedScope: definition.ownedScope });
  const v1 = { ...row(), ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition), modelHash: canonicalOwnedStoreModelHashV1(definition, expected) };
  const v2 = { ...v1, formatVersion: "2", ownedScopeHash: canonicalOwnedStoreScopeHashV1(version2), modelHash: canonicalOwnedStoreModelHashV1(version2, expected) };
  expect(validateOwnedStoreRegistryV1([v1], [definition])).toHaveLength(1);
  expect(() => validateOwnedStoreRegistryV1([{ ...v1, formatVersion: "2" }], [definition])).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => validateOwnedStoreRegistryV1([v2], [definition])).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("four catalog root DTO parsers copy complete closed records", () => {
  expect(parseOwnedCatalogClassV1({ oid: "1", schema: "pg_catalog", name: "pg_class", kind: "pg_class" }).oid).toBe("1");
  expect(parseOwnedCatalogRelationV1({ oid: "2", namespaceOid: "1", schema: "public", name: "t", kind: "ordinaryTable", rawKind: "r", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options: [], rowTypeOid: "3", toastRelationOid: null }, catalogContext).rowTypeOid).toBe("3");
  expect(parseOwnedCatalogRowTypeV1({ oid: "3", relationOid: "2", schema: "public", name: "t", kind: "composite", arrayTypeOid: "4" }).arrayTypeOid).toBe("4");
  expect(parseOwnedCatalogArrayTypeV1({ oid: "4", elementTypeOid: "3", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }, catalogContext).category).toBe("array");
});

test("catalog class preserves all nine raw class kinds without verifier name semantics", () => {
  for (const kind of ["pg_class", "pg_type", "pg_constraint", "pg_proc", "pg_rewrite", "pg_namespace", "pg_attrdef", "pg_trigger", "other"] as const) { const parsed = parseOwnedCatalogClassV1({ oid: "1", schema: "other", name: "raw_name", kind }); expect(parsed.kind).toBe(kind); expect(parsed.schema).toBe("other"); expect(parsed.name).toBe("raw_name"); }
  expect(() => parseOwnedCatalogClassV1({ oid: "1", schema: "other", name: "raw_name", kind: "pg_operator" })).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("four catalog root DTO parsers reject hostile or incomplete records", () => {
  const base = { oid: "1", schema: "pg_catalog", name: "pg_class", kind: "pg_class" };
  const getter = { ...base }; Object.defineProperty(getter, "oid", { get() { throw new Error("hook"); } });
  for (const value of [{ ...base, extra: true }, { schema: "pg_catalog", name: "pg_class", kind: "pg_class" }, getter, new Proxy(base, {}), Object.assign({ ...base }, { [Symbol("x")]: true })]) {
    expect(() => parseOwnedCatalogClassV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
  }
  expect(() => parseOwnedCatalogArrayTypeV1({ oid: "4", elementTypeOid: "3", relationOid: "1", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogClassV1({ ...base, name: "trailing\uD800" })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogRelationV1({ oid: "2", namespaceOid: "1", schema: "public", name: "t", kind: "ordinaryTable", rawKind: "r\uD800", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options: [], rowTypeOid: null, toastRelationOid: null }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

const column = () => ({ relationOid: "1", attnum: "1", name: "name", dropped: false, local: true, inheritanceCount: "0", physicalType: "text", typeOid: "25", notNull: false, default: { kind: "none" }, defaultObjectOid: null, generation: "none", identityCode: "", generatedCode: "", collationOid: "0", typeDefaultCollationOid: "0", storageCode: "x", typeDefaultStorageCode: "x", compressionCode: "" });
const index = () => ({ indexRelationOid: "2", tableRelationOid: "1", name: "idx", method: "btree", unique: true, primary: false, exclusion: false, immediate: true, valid: true, ready: true, live: true, replicaIdentity: false, nullsNotDistinct: false, keyAttributeCount: "1", totalAttributeCount: "1", attributeNumbers: ["1"], columnNames: ["name"], collationOids: ["0"], opclassOids: ["1"], defaultOpclassOids: ["1"], options: ["0"], expression: null, predicate: null, backingConstraintOid: null });

test("column and every CanonicalDefault branch are closed frozen copies", () => {
  expect(parseOwnedCatalogColumnV1(Object.freeze(Object.assign(Object.create(null), column()))).attnum).toBe("1");
  for (const value of [{ kind: "none" }, { kind: "null" }, { kind: "currentTimestamp" }, { kind: "uuidV4" }, { kind: "boolean", value: true }, { kind: "number", value: -0 }, { kind: "string", value: "\0\t\n\u0085😀" }]) expect(parseCanonicalDefaultV1(value)).toBeDefined();
  const normalized = parseCanonicalDefaultV1({ kind: "number", value: -0 }); expect(normalized.kind).toBe("number"); if (normalized.kind === "number") expect(Object.is(normalized.value, 0)).toBe(true);
  for (const value of [{ ...column(), attnum: "0" }, { ...column(), attnum: "32768" }, { ...column(), name: "x".repeat(64) }, { ...column(), default: { kind: "string", value: "\ud800" } }, { ...column(), default: { kind: "string", value: "\udc00" } }, { ...column(), default: { kind: "number", value: Number.NaN } }]) expect(() => parseOwnedCatalogColumnV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("index accepts INCLUDE and expression facts but enforces exact parallel vector widths", () => {
  expect(parseOwnedCatalogIndexV1(index()).totalAttributeCount).toBe("1");
  const include = { ...index(), totalAttributeCount: "2", attributeNumbers: ["1", "2"], columnNames: ["name", "included"] };
  expect(parseOwnedCatalogIndexV1(include).attributeNumbers).toHaveLength(2);
  const expression = { ...index(), attributeNumbers: ["0"], columnNames: [null], expression: "(x + 1)" };
  expect(parseOwnedCatalogIndexV1(expression).expression).toBe("(x + 1)");
  for (const value of [{ ...include, collationOids: ["0", "0"] }, { ...include, attributeNumbers: ["1"] }, { ...index(), options: ["+1"] }, { ...index(), opclassOids: ["0"] }]) expect(() => parseOwnedCatalogIndexV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("CanonicalDefault exhaustively copies seven branches and rejects hostile shapes", () => {
  const cases = [{ kind: "none" }, { kind: "null" }, { kind: "currentTimestamp" }, { kind: "uuidV4" }, { kind: "boolean", value: false }, { kind: "number", value: -0 }, { kind: "string", value: "\0\t\n\u0085😀" }] as const;
  for (const value of cases) { const parsed = parseCanonicalDefaultV1(Object.freeze({ ...value })); expect(Object.isFrozen(parsed)).toBe(true); }
  for (const value of [{}, { kind: "none", value: 1 }, { kind: "boolean" }, { kind: "boolean", value: "true" }, { kind: "number", value: Infinity }, { kind: "string", value: new String("x") }, { kind: "other" }, { kind: "string", value: "x", extra: true }]) expect(() => parseCanonicalDefaultV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
  const accessor: Record<string, unknown> = { kind: "string" }; let calls = 0; Object.defineProperty(accessor, "value", { enumerable: true, get() { calls++; return "x"; } }); expect(() => parseCanonicalDefaultV1(accessor)).toThrow(); expect(calls).toBe(0);
  expect(() => parseCanonicalDefaultV1({ kind: "string", value: "x".repeat(4 * 1024 * 1024 + 1) })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(parseCanonicalDefaultV1({ kind: "string", value: "x".repeat(4 * 1024 * 1024) }).kind).toBe("string");
});

test("column accepts declared raw variants and enforces exact scalar bounds", () => {
  for (const generation of ["none", "identityByDefault", "uuidDefault", "other"] as const) for (const identityCode of ["", "a", "d", "other"] as const) for (const generatedCode of ["", "s", "v", "other"] as const) for (const compressionCode of ["", "p", "l", "other"] as const) expect(parseOwnedCatalogColumnV1({ ...column(), generation, identityCode, generatedCode, compressionCode }).generation).toBe(generation);
  for (const value of [{ ...column(), relationOid: "4294967295", attnum: "32767", inheritanceCount: "32767", typeOid: "0", collationOid: "0", typeDefaultCollationOid: "0" }]) expect(parseOwnedCatalogColumnV1(value).attnum).toBe("32767");
  for (const value of [{ ...column(), relationOid: "0" }, { ...column(), attnum: "+1" }, { ...column(), attnum: "01" }, { ...column(), inheritanceCount: "-0" }, { ...column(), relationOid: "9".repeat(20) }, { ...column(), name: "x\u0085" }, { ...column(), name: "x\udc00" }]) expect(() => parseOwnedCatalogColumnV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("column is a closed hostile-safe frozen copy", () => {
  const input = Object.freeze(Object.assign(Object.create(null), column())); const parsed = parseOwnedCatalogColumnV1(input); expect(Object.isFrozen(parsed)).toBe(true); expect(parsed).not.toBe(input);
  for (const key of Object.keys(column())) { const value = column() as Record<string, unknown>; delete value[key]; expect(() => parseOwnedCatalogColumnV1(value)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  const getter = column(); let calls = 0; Object.defineProperty(getter, "name", { enumerable: true, get() { calls++; return "name"; } }); expect(() => parseOwnedCatalogColumnV1(getter)).toThrow(); expect(calls).toBe(0);
  for (const value of [{ ...column(), extra: true }, new Proxy(column(), {}), Object.assign(column(), { [Symbol("x")]: true })]) expect(() => parseOwnedCatalogColumnV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("column default object OID is nullable, canonical, and raw parser data", () => {
  expect(parseOwnedCatalogColumnV1(column()).defaultObjectOid).toBeNull();
  expect(parseOwnedCatalogColumnV1({ ...column(), defaultObjectOid: "1", default: { kind: "none" }, generation: "other" }).defaultObjectOid).toBe("1");
  expect(parseOwnedCatalogColumnV1({ ...column(), defaultObjectOid: "4294967295" }).defaultObjectOid).toBe("4294967295");
  const missing = column() as Record<string, unknown>; delete missing.defaultObjectOid; expect(() => parseOwnedCatalogColumnV1(missing)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const defaultObjectOid of ["0", "01", "+1", "-1", "4294967296", 1, 1n, new String("1")]) expect(() => parseOwnedCatalogColumnV1({ ...column(), defaultObjectOid })).toThrow("ORM_OWNED_STORE_DRIFT");
  let hooks = 0; const getter = column(); Object.defineProperty(getter, "defaultObjectOid", { enumerable: true, get() { hooks++; return "1"; } }); expect(() => parseOwnedCatalogColumnV1(getter)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  const proxy = new Proxy(column(), { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const revoked = Proxy.revocable(column(), {}); revoked.revoke(); for (const value of [proxy, revoked.proxy]) expect(() => parseOwnedCatalogColumnV1(value)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
});

test("index is a complete closed frozen own-data copy", () => {
  const clean = Object.freeze(Object.assign(Object.create(null), index())); const parsed = parseOwnedCatalogIndexV1(clean); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.attributeNumbers)).toBe(true);
  for (const key of Object.keys(index())) { const value = index() as Record<string, unknown>; delete value[key]; expect(() => parseOwnedCatalogIndexV1(value)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  for (const flag of ["unique", "primary", "exclusion", "immediate", "valid", "ready", "live", "replicaIdentity", "nullsNotDistinct"]) expect(() => parseOwnedCatalogIndexV1({ ...index(), [flag]: "false" })).toThrow("ORM_OWNED_STORE_DRIFT");
  const getter = index(); let calls = 0; Object.defineProperty(getter, "name", { enumerable: true, get() { calls++; return "idx"; } }); expect(() => parseOwnedCatalogIndexV1(getter)).toThrow(); expect(calls).toBe(0);
  for (const value of [{ ...index(), extra: true }, new Proxy(index(), {}), Object.assign(index(), { [Symbol("x")]: true })]) expect(() => parseOwnedCatalogIndexV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("index exact key and total vectors preserve honest INCLUDE/expression facts", () => {
  const max = { ...index(), keyAttributeCount: "32767", totalAttributeCount: "32767", attributeNumbers: Array(32767).fill("1"), columnNames: Array(32767).fill("name"), collationOids: Array(32767).fill("0"), opclassOids: Array(32767).fill("1"), defaultOpclassOids: Array(32767).fill("1"), options: Array(32767).fill("-32768") };
  expect(parseOwnedCatalogIndexV1(max).keyAttributeCount).toBe("32767");
  for (const value of [{ ...index(), keyAttributeCount: "0" }, { ...index(), keyAttributeCount: "2", totalAttributeCount: "1" }, { ...index(), attributeNumbers: ["+1"] }, { ...index(), options: ["32768"] }, { ...index(), opclassOids: ["0"] }, { ...index(), indexRelationOid: "4294967296" }]) expect(() => parseOwnedCatalogIndexV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("dense limits are explicit for relation options, registry and index vectors", () => {
  const relation = (options: string[]) => ({ oid: "2", namespaceOid: "1", schema: "public", name: "t", kind: "ordinaryTable", rawKind: "r", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options, rowTypeOid: null, toastRelationOid: null });
  expect(parseOwnedCatalogRelationV1(relation(Array(4097).fill("x")), catalogContext).options).toHaveLength(4097);
  expect(parseOwnedCatalogRelationV1(relation(Array(65536).fill("x")), catalogContext).options).toHaveLength(65536);
  let calls = 0; const oversized = Array(65537).fill("x"); Object.defineProperty(oversized, "0", { get() { calls++; return "x"; } }); expect(() => parseOwnedCatalogRelationV1(relation(oversized), catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  const sparse = index(); sparse.attributeNumbers = [] as never; (sparse.attributeNumbers as unknown[])[1] = "1"; expect(() => parseOwnedCatalogIndexV1(sparse)).toThrow("ORM_OWNED_STORE_DRIFT");
});

const inheritance = () => ({ childRelationOid: "1", parentRelationOid: "2", sequence: "1" });
const dependency = () => ({ dependentClassOid: "1", dependentOid: "2", dependentSubId: "0", referencedClassOid: "3", referencedOid: "4", referencedSubId: "0", kind: "normal" });
const sequence = () => ({ relationOid: "1", type: "bigint", start: "0", increment: "1", minimum: "-9223372036854775808", maximum: "9223372036854775807", cache: "1", cycle: false });

test("inheritance and dependency preserve independent numeric facts and closed enums", () => {
  expect(parseOwnedCatalogInheritanceV1({ ...inheritance(), childRelationOid: "4294967295", parentRelationOid: "1", sequence: "2147483647" }).sequence).toBe("2147483647");
  for (const field of ["childRelationOid", "parentRelationOid"] as const) for (const value of ["0", "01", "+1", "4294967296", "9".repeat(20), null]) expect(() => parseOwnedCatalogInheritanceV1({ ...inheritance(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["0", "01", "+1", "2147483648", "9".repeat(20), null]) expect(() => parseOwnedCatalogInheritanceV1({ ...inheritance(), sequence: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const kind of ["normal", "automatic", "internal", "partitionPrimary", "partitionSecondary", "extension", "other"] as const) expect(parseOwnedCatalogDependencyV1({ ...dependency(), kind }).kind).toBe(kind);
  for (const field of ["dependentClassOid", "dependentOid", "referencedClassOid", "referencedOid"] as const) {
    expect(parseOwnedCatalogDependencyV1({ ...dependency(), [field]: "4294967295" })[field]).toBe("4294967295");
    for (const value of ["0", "01", "+1", "4294967296", "9".repeat(20), null]) expect(() => parseOwnedCatalogDependencyV1({ ...dependency(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  }
  for (const field of ["dependentSubId", "referencedSubId"] as const) {
    for (const value of ["0", "2147483647"]) expect(parseOwnedCatalogDependencyV1({ ...dependency(), [field]: value })[field]).toBe(value);
    for (const value of ["01", "+1", "-0", "2147483648", "9".repeat(20), null]) expect(() => parseOwnedCatalogDependencyV1({ ...dependency(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  }
  expect(parseOwnedCatalogDependencyV1({ ...dependency(), dependentOid: "4", referencedOid: "4" }).dependentOid).toBe("4");
  for (const value of ["unknown", null, 1]) expect(() => parseOwnedCatalogDependencyV1({ ...dependency(), kind: value })).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("sequence accepts raw type facts and exact signed integer boundaries", () => {
  for (const type of ["bigint", "integer", "smallint", "other"] as const) for (const cycle of [false, true]) expect(parseOwnedCatalogSequenceV1({ ...sequence(), type, cycle }).type).toBe(type);
  for (const field of ["start", "increment", "minimum", "maximum"] as const) {
    for (const value of ["-9223372036854775808", "0", "9223372036854775807"]) expect(parseOwnedCatalogSequenceV1({ ...sequence(), [field]: value })[field]).toBe(value);
    for (const value of ["-0", "+1", "01", "-9223372036854775809", "9223372036854775808", "9".repeat(21), null]) expect(() => parseOwnedCatalogSequenceV1({ ...sequence(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  }
  expect(parseOwnedCatalogSequenceV1({ ...sequence(), cache: "9223372036854775807" }).cache).toBe("9223372036854775807");
  for (const value of ["0", "01", "+1", "9223372036854775808", "9".repeat(20), null]) expect(() => parseOwnedCatalogSequenceV1({ ...sequence(), cache: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["0", "01", "+1", "4294967296", null]) expect(() => parseOwnedCatalogSequenceV1({ ...sequence(), relationOid: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["unknown", null, 1]) expect(() => parseOwnedCatalogSequenceV1({ ...sequence(), type: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["false", 0, null]) expect(() => parseOwnedCatalogSequenceV1({ ...sequence(), cycle: value })).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("numeric catalog DTOs reject hostile records and return frozen independent copies", () => {
  const cases: readonly [string, () => Record<string, unknown>, (value: unknown) => unknown][] = [
    ["inheritance", inheritance, parseOwnedCatalogInheritanceV1],
    ["dependency", dependency, parseOwnedCatalogDependencyV1],
    ["sequence", sequence, parseOwnedCatalogSequenceV1],
  ];
  for (const [name, make, parse] of cases) {
    const input = Object.freeze(Object.assign(Object.create(null), make())); const parsed = parse(input); expect(Object.isFrozen(parsed)).toBe(true); expect(parsed).not.toBe(input);
    for (const key of Object.keys(make())) { const value = make(); delete value[key]; expect(() => parse(value), `${name}:${key}`).toThrow("ORM_OWNED_STORE_DRIFT"); }
    const accessor = make(); let calls = 0; Object.defineProperty(accessor, Object.keys(accessor)[0]!, { enumerable: true, get() { calls++; return "1"; } }); expect(() => parse(accessor), `${name}:accessor`).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls, `${name}:accessor hooks`).toBe(0);
    const hidden = make(); Object.defineProperty(hidden, "extra", { value: true }); expect(() => parse(hidden), `${name}:nonenumerable`).toThrow("ORM_OWNED_STORE_DRIFT");
    const inherited = Object.assign(Object.create({ inherited: true }), make());
    const revoked = Proxy.revocable(make(), {}); revoked.revoke();
    for (const value of [{ ...make(), extra: true }, Object.assign(make(), { [Symbol("x")]: true }), inherited, new Proxy(make(), {}), revoked.proxy]) expect(() => parse(value), `${name}:hostile`).toThrow("ORM_OWNED_STORE_DRIFT");
    for (const key of Object.keys(make())) expect(() => parse({ ...make(), [key]: null }), `${name}:${key}:primitive`).toThrow("ORM_OWNED_STORE_DRIFT");
  }
});

const catalogRelation = () => ({ oid: "2", namespaceOid: "1", schema: "public", name: "t", kind: "ordinaryTable", rawKind: "r", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options: [], rowTypeOid: null, toastRelationOid: null });
const catalogArrayType = () => ({ oid: "4", elementTypeOid: "3", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" });
const registryAbsent = (publicSchemaExists = true) => ({ contract: "bazis.orm-owned-store-registry-snapshot/v1", publicSchemaExists, state: { kind: "absent" } });
const catalogSnapshot = () => ({ contract: "bazis.orm-owned-store-catalog-snapshot/v1", requestedScopes: [], existingSchemas: [], catalogClasses: [], relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], triggers: [], rules: [], policies: [], inheritance: [], dependencies: [], sequences: [] });

test("relation namespace OID is required, canonical, frozen, and remains raw parser data", () => {
  const min = parseOwnedCatalogRelationV1(catalogRelation(), catalogContext); expect(min.namespaceOid).toBe("1"); expect(Object.isFrozen(min)).toBe(true);
  expect(parseOwnedCatalogRelationV1({ ...catalogRelation(), namespaceOid: "4294967295" }, catalogContext).namespaceOid).toBe("4294967295");
  const raw = parseOwnedCatalogRelationV1({ ...catalogRelation(), namespaceOid: "1", schema: "unrelated_schema", name: "unrelated_name" }, catalogContext); expect(raw.namespaceOid).toBe("1"); expect(raw.name).toBe("unrelated_name");
  const missing = catalogRelation() as Record<string, unknown>; delete missing.namespaceOid; expect(() => parseOwnedCatalogRelationV1(missing, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const namespaceOid of [null, "0", "01", "+1", "-1", "4294967296", 1, 1n, new String("1")]) expect(() => parseOwnedCatalogRelationV1({ ...catalogRelation(), namespaceOid }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  let hooks = 0; const getter = catalogRelation(); Object.defineProperty(getter, "namespaceOid", { enumerable: true, get() { hooks++; return "1"; } }); expect(() => parseOwnedCatalogRelationV1(getter, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  const proxy = new Proxy(catalogRelation(), { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); expect(() => parseOwnedCatalogRelationV1(proxy, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
});

test("catalog context is closed, copied, and rejected before hostile parser inputs", () => {
  let hooks = 0;
  const hostile = new Proxy({}, { get() { hooks++; throw new Error("input hook"); }, ownKeys() { hooks++; throw new Error("input hook"); }, getPrototypeOf() { hooks++; throw new Error("input hook"); } });
  const defs = new Proxy([], { get() { hooks++; throw new Error("defs hook"); } });
  const calls = [
    (context: unknown) => parseOwnedCatalogRelationV1(hostile, context as never),
    (context: unknown) => parseOwnedCatalogArrayTypeV1(hostile, context as never),
    (context: unknown) => parseOwnedStoreRegistrySnapshotV1(hostile, defs, context as never),
    (context: unknown) => parseOwnedStoreCatalogSnapshotV1(hostile, context as never),
  ];
  const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, "maxIdentifierLength", { enumerable: true, get() { hooks++; return 63n; } });
  const revoked = Proxy.revocable({ maxIdentifierLength: 63n }, {}); revoked.revoke();
  const malformed = [undefined, {}, { maxIdentifierLength: 63 }, { maxIdentifierLength: "63" }, { maxIdentifierLength: 63n, extra: true }, Object.assign(Object.create({ inherited: true }), { maxIdentifierLength: 63n }), Object.assign({ maxIdentifierLength: 63n }, { [Symbol("x")]: true }), accessor, new Proxy({ maxIdentifierLength: 63n }, {}), revoked.proxy];
  for (const context of malformed) for (const call of calls) expect(() => call(context)).toThrow("ORM_OWNED_STORE_DRIFT");
  const omitted = [
    () => Reflect.apply(parseOwnedCatalogRelationV1 as never, undefined, [hostile]),
    () => Reflect.apply(parseOwnedCatalogArrayTypeV1 as never, undefined, [hostile]),
    () => Reflect.apply(parseOwnedStoreRegistrySnapshotV1 as never, undefined, [hostile, defs]),
    () => Reflect.apply(parseOwnedStoreCatalogSnapshotV1 as never, undefined, [hostile]),
  ];
  for (const call of omitted) expect(call).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const call of calls) expect(() => call({ maxIdentifierLength: 62n })).toThrow("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  expect(hooks).toBe(0);
  const frozenNull = Object.freeze(Object.assign(Object.create(null), { maxIdentifierLength: 63n }));
  expect(parseOwnedCatalogRelationV1(Object.freeze(Object.assign(Object.create(null), catalogRelation())), frozenNull)).not.toBe(frozenNull);
});

test("catalog context permits only unpredicted array and sequence names up to server M", () => {
  const m63 = Object.freeze({ maxIdentifierLength: 63n }); const m64 = Object.freeze({ maxIdentifierLength: 64n });
  const array64 = `_${"x".repeat(63)}`;
  expect(parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: array64 }, m64).name).toBe(array64);
  expect(() => parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: array64 }, m63)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: `_${"x".repeat(64)}` }, m64)).toThrow("ORM_OWNED_STORE_DRIFT");
  const sequence64 = { ...catalogRelation(), kind: "sequence", name: "x".repeat(64) };
  expect(parseOwnedCatalogRelationV1(sequence64, m64).name).toBe(sequence64.name);
  expect(() => parseOwnedCatalogRelationV1(sequence64, m63)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogRelationV1({ ...sequence64, name: "x".repeat(65) }, m64)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const relation of [{ ...catalogRelation(), name: "x".repeat(64) }, { ...catalogRelation(), kind: "index", name: "x".repeat(64) }]) expect(() => parseOwnedCatalogRelationV1(relation, m64)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogColumnV1({ ...column(), name: "x".repeat(64) })).toThrow("ORM_OWNED_STORE_DRIFT");
  const astral64 = "😀".repeat(16); expect(parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: astral64 }, m64).name).toBe(astral64);
  for (const name of ["😀".repeat(17), "x\0", "x\u0085", "x\ud800", "x\udc00"]) expect(() => parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name }, m64)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: array64 }, Object.freeze({ maxIdentifierLength: 9007199254740993n })).name).toBe(array64);
  expect(() => parseOwnedCatalogArrayTypeV1({ ...catalogArrayType(), name: array64 }, m63)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("registry absent branch and all four context entry points use exact valid inputs", () => {
  expect(() => parseOwnedStoreRegistrySnapshotV1(registryAbsent(false), [], catalogContext)).toThrow("ORM_OWNED_STORE_CREATE_FAILED");
  expect(parseOwnedStoreRegistrySnapshotV1(registryAbsent(true), [], catalogContext).state.kind).toBe("absent");
  for (const state of [{ kind: "absent", shape: {} }, { kind: "absent", rows: [] }, { kind: "absent", unknown: true }]) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryAbsent(true), state }, [], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(parseOwnedStoreCatalogSnapshotV1(catalogSnapshot(), catalogContext).contract).toBe("bazis.orm-owned-store-catalog-snapshot/v1");
  expect(parseOwnedCatalogRelationV1(catalogRelation(), catalogContext).name).toBe("t");
  expect(parseOwnedCatalogArrayTypeV1(catalogArrayType(), catalogContext).name).toBe("_t");
});

test("main catalog snapshot captures context first and copies a closed null-prototype root", () => {
  const scope = Object.freeze(Object.assign(Object.create(null), { schema: "public", tablePrefix: "bazis_" })); const input = Object.freeze(Object.assign(Object.create(null), { ...catalogSnapshot(), requestedScopes: Object.freeze([scope]), existingSchemas: Object.freeze(["public"]) })); const parsed = parseOwnedStoreCatalogSnapshotV1(input, Object.freeze(Object.assign(Object.create(null), { maxIdentifierLength: 63n }))); expect(parsed).not.toBe(input); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.requestedScopes)).toBe(true); expect(Object.isFrozen(parsed.requestedScopes[0]!)).toBe(true); expect(Object.isFrozen(parsed.existingSchemas)).toBe(true); expect(parsed.requestedScopes[0]).not.toBe(scope);
  for (const key of Object.keys(catalogSnapshot())) { const missing = catalogSnapshot() as Record<string, unknown>; delete missing[key]; expect(() => parseOwnedStoreCatalogSnapshotV1(missing, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  let hooks = 0; const getter = catalogSnapshot(); Object.defineProperty(getter, "relations", { enumerable: true, get() { hooks++; return []; } }); const hidden = catalogSnapshot(); Object.defineProperty(hidden, "hidden", { value: true }); const inherited = Object.assign(Object.create({ inherited: true }), catalogSnapshot()); const revoked = Proxy.revocable(catalogSnapshot(), {}); revoked.revoke();
  for (const value of [{ ...catalogSnapshot(), extra: true }, hidden, inherited, Object.assign(catalogSnapshot(), { [Symbol("x")]: true }), getter, new Proxy(catalogSnapshot(), {}), revoked.proxy]) expect(() => parseOwnedStoreCatalogSnapshotV1(value, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  const knownHidden = catalogSnapshot(); Object.defineProperty(knownHidden, "contract", { value: "bazis.orm-owned-store-catalog-snapshot/v1", enumerable: false }); expect(parseOwnedStoreCatalogSnapshotV1(knownHidden, catalogContext).contract).toBe("bazis.orm-owned-store-catalog-snapshot/v1");
  const hostile = new Proxy({}, { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const contextAccessor: Record<string, unknown> = {}; Object.defineProperty(contextAccessor, "maxIdentifierLength", { enumerable: true, get() { hooks++; return 63n; } }); const contextRevoked = Proxy.revocable({ maxIdentifierLength: 63n }, {}); contextRevoked.revoke();
  for (const context of [undefined, {}, { maxIdentifierLength: 63 }, { maxIdentifierLength: "63" }, { maxIdentifierLength: 63n, extra: true }, Object.assign({ maxIdentifierLength: 63n }, { [Symbol("x")]: true }), contextAccessor, new Proxy({ maxIdentifierLength: 63n }, {}), contextRevoked.proxy]) expect(() => parseOwnedStoreCatalogSnapshotV1(hostile, context as never)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(() => parseOwnedStoreCatalogSnapshotV1(hostile, { maxIdentifierLength: 62n })).toThrow("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); expect(hooks).toBe(0);
});

test("main catalog snapshot scopes and schemas are bytewise ordered closed data", () => {
  const scope = (schema: string, tablePrefix = "p") => ({ schema, tablePrefix }); const byteOrdered = [scope("\uE000"), scope("\u{10000}")]; const parsed = parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), requestedScopes: byteOrdered, existingSchemas: ["\uE000", "\u{10000}"] }, catalogContext); expect(parsed.requestedScopes.map(x => x.schema)).toEqual(["\uE000", "\u{10000}"]);
  for (const value of [{ requestedScopes: [...byteOrdered].reverse(), existingSchemas: ["\uE000", "\u{10000}"] }, { requestedScopes: byteOrdered, existingSchemas: ["\u{10000}", "\uE000"] }, { requestedScopes: [scope("a", "z"), scope("a", "a")], existingSchemas: [] }, { requestedScopes: [scope("a"), scope("a")], existingSchemas: [] }, { requestedScopes: [scope("a")], existingSchemas: ["a", "a"] }, { requestedScopes: [scope("a")], existingSchemas: ["b"] }]) expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), ...value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  const scopes8320 = Array.from({ length: 8320 }, (_, index) => scope(`s${String(index).padStart(4, "0")}`)); const schemas8320 = scopes8320.map(x => x.schema); expect(parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), requestedScopes: scopes8320, existingSchemas: schemas8320 }, catalogContext).requestedScopes).toHaveLength(8320);
  const scopes8321 = Array.from({ length: 8321 }, () => scope("a")); const schemas8321 = Array.from({ length: 8321 }, () => "a"); for (const value of [{ requestedScopes: scopes8321, existingSchemas: [] }, { requestedScopes: [scope("a")], existingSchemas: schemas8321 }]) expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), ...value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  let hooks = 0; const itemGetter: Record<string, unknown> = { tablePrefix: "p" }; Object.defineProperty(itemGetter, "schema", { enumerable: true, get() { hooks++; return "a"; } }); const itemRevoked = Proxy.revocable(scope("a"), {}); itemRevoked.revoke(); const sparse: unknown[] = []; sparse[1] = scope("a"); const extended = [scope("a")]; Object.defineProperty(extended, "4294967295", { value: scope("b") }); const arrayGetter = [scope("a")]; Object.defineProperty(arrayGetter, "0", { get() { hooks++; return scope("a"); } });
  for (const requestedScopes of [[{ schema: "a", tablePrefix: "p", extra: true }], [{ tablePrefix: "p" }], [itemGetter], [new Proxy(scope("a"), {})], [itemRevoked.proxy], sparse, extended, arrayGetter, new Proxy([scope("a")], {}), Object.assign([scope("a")], { [Symbol("x")]: true })]) expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), requestedScopes, existingSchemas: [] }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  const schemaSparse: unknown[] = []; schemaSparse[1] = "a"; const schemaExtended = ["a"]; Object.defineProperty(schemaExtended, "4294967295", { value: "a" }); const schemaGetter = ["a"]; Object.defineProperty(schemaGetter, "0", { get() { hooks++; return "a"; } }); const schemaRevoked = Proxy.revocable(["a"], {}); schemaRevoked.revoke(); for (const existingSchemas of [schemaSparse, schemaExtended, schemaGetter, new Proxy(["a"], {}), schemaRevoked.proxy, Object.assign(["a"], { [Symbol("x")]: true })]) expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), requestedScopes: [scope("a")], existingSchemas }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
});

const trigger = () => ({ oid: "1", relationOid: "2", name: "RI_ConstraintTrigger_a_4294967295", internal: false, constraintOid: null, parentTriggerOid: null, enabled: "origin", functionOid: "1", functionSchema: "pg_catalog", functionName: "RI_FKey_check_ins", typeBits: "1" });
const rule = () => ({ oid: "1", relationOid: "2", name: "rule", event: "SELECT", enabled: "", instead: false });
const policy = () => ({ oid: "1", relationOid: "2", name: "policy", permissive: true, command: "ALL", roles: ["0", "1"], usingExpression: null, checkExpression: null });

test("trigger, rule, and policy retain exact primitive raw DTO facts", () => {
  for (const enabled of ["origin", "always", "replica", "disabled", "other"] as const) expect(parseOwnedCatalogTriggerV1({ ...trigger(), enabled }).enabled).toBe(enabled);
  expect(parseOwnedCatalogTriggerV1({ ...trigger(), oid: "4294967295", relationOid: "4294967295", constraintOid: "1", parentTriggerOid: "2", typeBits: "32767" }).typeBits).toBe("32767");
  for (const value of ["0", "01", "+1", "4294967296", null]) expect(() => parseOwnedCatalogTriggerV1({ ...trigger(), oid: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["0", "32768", "01", "+1", null]) expect(() => parseOwnedCatalogTriggerV1({ ...trigger(), typeBits: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["unknown", null, true]) expect(() => parseOwnedCatalogTriggerV1({ ...trigger(), enabled: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const field of ["name", "functionSchema", "functionName"] as const) for (const value of ["x".repeat(64), "x\0", "x\u0085", "x\ud800", "x\udc00"]) expect(() => parseOwnedCatalogTriggerV1({ ...trigger(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(parseOwnedCatalogRuleV1({ ...rule(), event: "MiXeD", enabled: "" }).enabled).toBe("");
  for (const field of ["oid", "relationOid"] as const) for (const value of ["0", "01", "+1", "4294967296"]) expect(() => parseOwnedCatalogRuleV1({ ...rule(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["x".repeat(64), "x\0", "x\u0085", "x\ud800"]) expect(() => parseOwnedCatalogRuleV1({ ...rule(), name: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => parseOwnedCatalogRuleV1({ ...rule(), instead: "false" })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const field of ["event", "enabled"] as const) for (const value of ["x\0", "x\u0085", "x\ud800", "x\udc00"]) expect(() => parseOwnedCatalogRuleV1({ ...rule(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(parseOwnedCatalogPolicyV1({ ...policy(), roles: ["0", "4294967295"], usingExpression: "\0\t\n\u0085😀", checkExpression: "\0" }).roles[1]).toBe("4294967295");
  for (const field of ["oid", "relationOid"] as const) for (const value of ["0", "01", "+1", "4294967296"]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["x".repeat(64), "x\0", "x\u0085", "x\ud800"]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), name: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["false", null]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), permissive: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["x\0", "x\u0085", "x\ud800", "x\udc00"]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), command: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const field of ["usingExpression", "checkExpression"] as const) for (const value of ["\ud800", "\udc00", new String("x"), "x".repeat(4 * 1024 * 1024 + 1)]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("trigger function OID is required, canonical, and raw parser data", () => {
  expect(parseOwnedCatalogTriggerV1({ ...trigger(), functionOid: "1", functionSchema: "unrelated_schema", functionName: "unrelated_name" }).functionOid).toBe("1");
  expect(parseOwnedCatalogTriggerV1({ ...trigger(), functionOid: "4294967295" }).functionOid).toBe("4294967295");
  const missing = trigger() as Record<string, unknown>; delete missing.functionOid; expect(() => parseOwnedCatalogTriggerV1(missing)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const functionOid of [null, "0", "01", "+1", "-1", "4294967296", 1, 1n, new String("1")]) expect(() => parseOwnedCatalogTriggerV1({ ...trigger(), functionOid })).toThrow("ORM_OWNED_STORE_DRIFT");
  let hooks = 0; const getter = trigger(); Object.defineProperty(getter, "functionOid", { enumerable: true, get() { hooks++; return "1"; } }); expect(() => parseOwnedCatalogTriggerV1(getter)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  const proxy = new Proxy(trigger(), { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const revoked = Proxy.revocable(trigger(), {}); revoked.revoke(); for (const value of [proxy, revoked.proxy]) expect(() => parseOwnedCatalogTriggerV1(value)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
});

test("opaque index predicates and policy roles are bounded hostile-safe data", () => {
  for (const field of ["expression", "predicate"] as const) {
    expect(parseOwnedCatalogIndexV1({ ...index(), [field]: "\0\t\n\u0085😀" })[field]).toBe("\0\t\n\u0085😀");
    for (const value of ["\ud800", "\udc00", "x".repeat(4 * 1024 * 1024 + 1)]) expect(() => parseOwnedCatalogIndexV1({ ...index(), [field]: value })).toThrow("ORM_OWNED_STORE_DRIFT");
  }
  expect(parseOwnedCatalogPolicyV1({ ...policy(), roles: Array(65536).fill("0") }).roles).toHaveLength(65536);
  let calls = 0; const oversized = Array(65537).fill("0"); Object.defineProperty(oversized, "0", { get() { calls++; return "0"; } }); expect(() => parseOwnedCatalogPolicyV1({ ...policy(), roles: oversized })).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  const sparse: string[] = []; sparse[1] = "0"; const extended = ["0"]; Object.defineProperty(extended, "4294967295", { value: "0" }); let roleCalls = 0; const accessor = ["0"]; Object.defineProperty(accessor, "0", { get() { roleCalls++; return "0"; } });
  for (const roles of [sparse, extended, accessor, new Proxy(["0"], {}), Object.assign(["0"], { [Symbol("x")]: true }), ["01"], ["4294967296"]]) expect(() => parseOwnedCatalogPolicyV1({ ...policy(), roles })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(roleCalls).toBe(0);
});

test("attached raw DTO parsers are closed frozen copies with zero-hook hostile rejection", () => {
  const cases: readonly [() => Record<string, unknown>, (value: unknown) => unknown][] = [[trigger, parseOwnedCatalogTriggerV1], [rule, parseOwnedCatalogRuleV1], [policy, parseOwnedCatalogPolicyV1]];
  for (const [make, parse] of cases) {
    const input = Object.freeze(Object.assign(Object.create(null), make())); const parsed = parse(input); expect(Object.isFrozen(parsed)).toBe(true); expect(parsed).not.toBe(input);
    for (const key of Object.keys(make())) { const value = make(); delete value[key]; expect(() => parse(value)).toThrow("ORM_OWNED_STORE_DRIFT"); }
    const getter = make(); let calls = 0; Object.defineProperty(getter, Object.keys(getter)[0]!, { enumerable: true, get() { calls++; return "1"; } }); expect(() => parse(getter)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
    const hidden = make(); Object.defineProperty(hidden, "hidden", { value: true }); const inherited = Object.assign(Object.create({ inherited: true }), make()); const revoked = Proxy.revocable(make(), {}); revoked.revoke();
    for (const value of [{ ...make(), extra: true }, hidden, inherited, new Proxy(make(), {}), revoked.proxy, Object.assign(make(), { [Symbol("x")]: true })]) expect(() => parse(value)).toThrow("ORM_OWNED_STORE_DRIFT");
    for (const key of Object.keys(make())) { const original = make()[key]; const wrong = typeof original === "boolean" ? "not-boolean" : original === null ? true : null; expect(() => parse({ ...make(), [key]: wrong })).toThrow("ORM_OWNED_STORE_DRIFT"); }
  }
  const parsedPolicy = parseOwnedCatalogPolicyV1(Object.freeze(Object.assign(Object.create(null), policy()))); expect(Object.isFrozen(parsedPolicy.roles)).toBe(true); expect(parsedPolicy.roles).not.toBe(policy().roles);
});

const constraint = () => ({ oid: "1", relationOid: "2", referencedRelationOid: null, name: "fk_name", kind: "foreignKey", columns: ["source"], referencedColumns: ["target"], backingIndexOid: null, onDelete: "", onUpdate: null, match: "FULL", deferrable: false, initiallyDeferred: false, validated: true, parentConstraintOid: null, inheritanceCount: "0", noInherit: false, deleteSetColumns: [], primaryForeignEqualityOperatorOids: [], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: [], defaultEqualityOperatorOids: [], checkExpression: null });
const checkLeaf = () => ({ kind: "compare", op: "=", left: "left", right: 1 });

test("constraint context and complete raw DTO fields are closed frozen copies", () => {
  const m64 = Object.freeze({ maxIdentifierLength: 64n }); const m63 = Object.freeze({ maxIdentifierLength: 63n });
  const input = Object.freeze(Object.assign(Object.create(null), constraint())); const parsed = parseOwnedCatalogConstraintV1(input, catalogContext); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.columns)).toBe(true); expect(parsed).not.toBe(input);
  for (const kind of ["primaryKey", "unique", "foreignKey", "check", "exclusion", "other"] as const) expect(parseOwnedCatalogConstraintV1({ ...constraint(), kind }, catalogContext).kind).toBe(kind);
  expect(parseOwnedCatalogConstraintV1({ ...constraint(), name: "x".repeat(64), columns: ["x".repeat(64)], referencedColumns: ["x".repeat(64)], deleteSetColumns: ["x".repeat(64)], referencedRelationOid: "3", backingIndexOid: "4", parentConstraintOid: "5", inheritanceCount: "32767" }, m64).name).toHaveLength(64);
  for (const field of ["name", "columns", "referencedColumns", "deleteSetColumns"] as const) expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), [field]: field === "name" ? "x".repeat(64) : ["x".repeat(64)] }, m63)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["0", "01", "+1", "4294967296"]) expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), oid: value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const value of ["32768", "01", "-0"]) expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), inheritanceCount: value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const field of ["onDelete", "onUpdate", "match"] as const) for (const value of ["x\0", "x\u0085", "x\ud800"]) expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), [field]: value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  for (const key of Object.keys(constraint())) { const value: Record<string, unknown> = constraint(); delete value[key]; expect(() => parseOwnedCatalogConstraintV1(value, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  const getter = constraint(); let calls = 0; Object.defineProperty(getter, "name", { enumerable: true, get() { calls++; return "fk_name"; } }); expect(() => parseOwnedCatalogConstraintV1(getter, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  const hidden = constraint(); Object.defineProperty(hidden, "hidden", { value: true }); const inherited = Object.assign(Object.create({ inherited: true }), constraint()); const revoked = Proxy.revocable(constraint(), {}); revoked.revoke();
  for (const value of [{ ...constraint(), extra: true }, hidden, inherited, new Proxy(constraint(), {}), revoked.proxy, Object.assign(constraint(), { [Symbol("x")]: true })]) expect(() => parseOwnedCatalogConstraintV1(value, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("constraint operator OID vectors are independent bounded raw parser data", () => {
  const fields = ["primaryForeignEqualityOperatorOids", "primaryPrimaryEqualityOperatorOids", "foreignForeignEqualityOperatorOids", "defaultEqualityOperatorOids"] as const;
  for (const field of fields) { expect(parseOwnedCatalogConstraintV1(constraint(), catalogContext)[field]).toEqual([]); expect(parseOwnedCatalogConstraintV1({ ...constraint(), [field]: ["1"] }, catalogContext)[field]).toEqual(["1"]); expect(parseOwnedCatalogConstraintV1({ ...constraint(), [field]: Array(65536).fill("4294967295") }, catalogContext)[field]).toHaveLength(65536); }
  for (const field of fields) {
    const missing = constraint() as Record<string, unknown>; delete missing[field]; expect(() => parseOwnedCatalogConstraintV1(missing, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
    let hooks = 0; const oversized = Array(65537).fill("1"); Object.defineProperty(oversized, "0", { get() { hooks++; return "1"; } }); expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), [field]: oversized }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
    const sparse: string[] = []; sparse[1] = "1"; const extended = ["1"]; Object.defineProperty(extended, "4294967295", { value: "1" }); const accessor = ["1"]; Object.defineProperty(accessor, "0", { get() { hooks++; return "1"; } }); const trapped = new Proxy(["1"], { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const revoked = Proxy.revocable(["1"], {}); revoked.revoke(); const symbol = Object.assign(["1"], { [Symbol("x")]: true });
    for (const value of [null, sparse, extended, accessor, trapped, revoked.proxy, symbol, ["01"], ["+1"], ["-1"], ["0"], ["4294967296"], [null], [1], [1n], [new String("1")]]) expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), [field]: value }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  }
  const shared = ["1", "2"]; const parsed = parseOwnedCatalogConstraintV1({ ...constraint(), primaryForeignEqualityOperatorOids: shared, primaryPrimaryEqualityOperatorOids: shared, foreignForeignEqualityOperatorOids: shared, defaultEqualityOperatorOids: shared }, catalogContext); for (const field of fields) { expect(Object.isFrozen(parsed[field])).toBe(true); expect(parsed[field]).not.toBe(shared); } expect(parsed.primaryForeignEqualityOperatorOids).not.toBe(parsed.defaultEqualityOperatorOids); shared[0] = "3"; expect(parsed.primaryForeignEqualityOperatorOids[0]).toBe("1");
  const raw = parseOwnedCatalogConstraintV1({ ...constraint(), kind: "check", primaryForeignEqualityOperatorOids: ["1"], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: ["2", "3"], defaultEqualityOperatorOids: ["4"] }, catalogContext); expect(raw.defaultEqualityOperatorOids).toEqual(["4"]);
});

test("constraint validates context before hostile DTOs and bounds all identifier vectors", () => {
  let hooks = 0; const hostile = new Proxy({}, { get() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); } });
  const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, "maxIdentifierLength", { enumerable: true, get() { hooks++; return 63n; } }); const revoked = Proxy.revocable({ maxIdentifierLength: 63n }, {}); revoked.revoke();
  for (const context of [undefined, {}, { maxIdentifierLength: 63 }, accessor, { maxIdentifierLength: 63n, extra: true }, Object.assign({ maxIdentifierLength: 63n }, { [Symbol("x")]: true }), new Proxy({ maxIdentifierLength: 63n }, {}), revoked.proxy]) expect(() => parseOwnedCatalogConstraintV1(hostile, context as never)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(() => Reflect.apply(parseOwnedCatalogConstraintV1 as never, undefined, [hostile])).toThrow("ORM_OWNED_STORE_DRIFT"); expect(() => parseOwnedCatalogConstraintV1(hostile, { maxIdentifierLength: 62n })).toThrow("ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); expect(hooks).toBe(0);
  for (const field of ["columns", "referencedColumns", "deleteSetColumns"] as const) {
    expect(parseOwnedCatalogConstraintV1({ ...constraint(), [field]: Array(65536).fill("x") }, catalogContext)[field]).toHaveLength(65536);
    let calls = 0; const oversized = Array(65537).fill("x"); Object.defineProperty(oversized, "0", { get() { calls++; return "x"; } }); expect(() => parseOwnedCatalogConstraintV1({ ...constraint(), [field]: oversized }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  }
});

test("CHECK AST parses closed syntax only with independent occurrence and depth budgets", () => {
  for (const value of [{ kind: "compare", op: "=", left: "left", right: "\0right" }, { kind: "in", left: "left", values: [null, false, -0, "\0\u0085😀"] }, { kind: "null", left: "left", not: true }, { kind: "and", left: checkLeaf(), right: checkLeaf() }, { kind: "or", left: checkLeaf(), right: checkLeaf() }, { kind: "not", inner: checkLeaf() }]) { const parsed = parseCheckAstV1(value); expect(Object.isFrozen(parsed)).toBe(true); }
  const normalized = parseCheckAstV1({ kind: "compare", op: "=", left: "left", right: -0 }); if (normalized.kind === "compare") expect(Object.is(normalized.right, 0)).toBe(true);
  for (const value of [{ kind: "compare", op: "=", left: "left", right: "\0" }, { kind: "compare", op: "?", left: "left", right: 1 }, { kind: "in", left: "left", values: [] }, { kind: "in", left: "left", values: Array(101).fill(1) }, { kind: "null", left: "left", not: "false" }, { kind: "compare", op: "=", left: "left", right: Infinity }, { kind: "compare", op: "=", left: "left", right: 1n }, { kind: "compare", op: "=", left: "left", right: new Number(1) }]) expect(() => parseCheckAstV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
  let depth: unknown = checkLeaf(); for (let i = 0; i < 63; i++) depth = { kind: "not", inner: depth }; expect(parseCheckAstV1(depth)).toBeDefined(); expect(() => parseCheckAstV1({ kind: "not", inner: depth })).toThrow("ORM_OWNED_STORE_DRIFT");
  const shared = checkLeaf(); expect(parseCheckAstV1({ kind: "and", left: shared, right: shared })).toBeDefined(); const cycle: Record<string, unknown> = { kind: "not" }; cycle.inner = cycle; expect(() => parseCheckAstV1(cycle)).toThrow("ORM_OWNED_STORE_DRIFT");
  const sparse: unknown[] = []; sparse[1] = 1; let calls = 0; const accessor = [1]; Object.defineProperty(accessor, "0", { get() { calls++; return 1; } });
  for (const values of [sparse, accessor, new Proxy([1], {}), Object.assign([1], { [Symbol("x")]: true })]) expect(() => parseCheckAstV1({ kind: "in", left: "left", values })).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  const getter: Record<string, unknown> = { kind: "compare", op: "=", left: "left" }; let getterCalls = 0; Object.defineProperty(getter, "right", { enumerable: true, get() { getterCalls++; return 1; } }); expect(() => parseCheckAstV1(getter)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(getterCalls).toBe(0);
  for (const value of [{ kind: "compare", op: "=", left: "left" }, { ...checkLeaf(), extra: true }, new Proxy(checkLeaf(), {}), Object.assign(checkLeaf(), { [Symbol("x")]: true })]) expect(() => parseCheckAstV1(value)).toThrow("ORM_OWNED_STORE_DRIFT");
  const tree = (level: number): unknown => level === 0 ? checkLeaf() : { kind: "and", left: tree(level - 1), right: tree(level - 1) }; const at4096 = { kind: "not", inner: tree(11) }; expect(parseCheckAstV1(at4096)).toBeDefined(); expect(() => parseCheckAstV1({ kind: "not", inner: at4096 })).toThrow("ORM_OWNED_STORE_DRIFT");
});

const registryShape = () => ({ catalogClasses: [], relation: catalogRelation(), rowType: { oid: "3", relationOid: "2", schema: "public", name: "t", kind: "composite", arrayTypeOid: "4" }, arrayType: { oid: "4", elementTypeOid: "3", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }, columns: [], indexes: [], indexRelations: [], constraints: [], triggers: [], rules: [], policies: [], inheritance: [], dependencies: [], sequences: [], toast: null });
const registryPresent = () => ({ contract: "bazis.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "present", shape: registryShape(), rows: [row()] } });

test("registry present snapshot materializes a typed frozen structural shape", () => {
  const input = Object.freeze(Object.assign(Object.create(null), registryPresent())); const parsed = parseOwnedStoreRegistrySnapshotV1(input, [definition], catalogContext); expect(parsed.state.kind).toBe("present"); if (parsed.state.kind === "present") { expect(Object.isFrozen(parsed.state.shape)).toBe(true); expect(Object.isFrozen(parsed.state.shape.columns)).toBe(true); expect(parsed.state.shape).not.toBe(input.state.shape); }
  for (const key of Object.keys(registryShape())) { const shape: Record<string, unknown> = registryShape(); delete shape[key]; expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  for (const shape of [{ ...registryShape(), indexRelations: [catalogRelation()] }, { ...registryShape(), indexes: [index()], indexRelations: [] }]) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  const physicalFacts = { ...registryShape(), relation: { ...catalogRelation(), oid: "1" }, indexes: [index()], indexRelations: [{ ...catalogRelation(), kind: "other", rawKind: "r", isPartition: true, rowSecurity: true, forceRowSecurity: true, replicaIdentity: "full" }] }; expect(parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: physicalFacts, rows: [row()] } }, [definition], catalogContext).state.kind).toBe("present");
  const duplicateClass = { ...registryShape(), catalogClasses: [{ oid: "2", schema: "other", name: "x", kind: "other" }] }; expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: duplicateClass, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("registry preserves all required constraint operator vectors", () => {
  const fields = ["primaryForeignEqualityOperatorOids", "primaryPrimaryEqualityOperatorOids", "foreignForeignEqualityOperatorOids", "defaultEqualityOperatorOids"] as const;
  const input = { ...constraint(), kind: "check", primaryForeignEqualityOperatorOids: ["1"], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: ["2", "3"], defaultEqualityOperatorOids: ["4"] }; const parsed = parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...registryShape(), constraints: [input] }, rows: [row()] } }, [definition], catalogContext); expect(parsed.state.kind).toBe("present"); if (parsed.state.kind === "present") { for (const field of fields) expect(parsed.state.shape.constraints[0]![field]).toEqual(input[field]); }
  for (const field of fields) { const missing = { ...constraint() } as Record<string, unknown>; delete missing[field]; expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...registryShape(), constraints: [missing] }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
});

test("registry structural unions preserve raw facts and reject every cross-location identity collision", () => {
  const rootIndex = { ...index(), indexRelationOid: "10" }; const rootIndexRelation = { ...catalogRelation(), oid: "10", kind: "other", rawKind: "r" };
  const toastIndex = { ...index(), indexRelationOid: "20" }; const toastRelation = { ...catalogRelation(), oid: "20", kind: "other", rawKind: "r" };
  const base = { ...registryShape(), catalogClasses: [{ oid: "2", schema: "other", name: "class", kind: "other" }], relation: { ...catalogRelation(), oid: "1" }, indexes: [rootIndex], indexRelations: [rootIndexRelation], toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30", kind: "other", rawKind: "r" }, columns: [], indexes: [toastIndex], indexRelations: [toastRelation], dependencies: [] } };
  const accepted = parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: base, rows: [row()] } }, [definition], catalogContext); expect(accepted.state.kind).toBe("present"); if (accepted.state.kind === "present") { expect(Object.isFrozen(accepted.state.shape.indexRelations)).toBe(true); expect(Object.isFrozen(accepted.state.shape.toast!.indexRelations)).toBe(true); }
  const collisions = [
    { ...base, catalogClasses: [{ oid: "1", schema: "other", name: "x", kind: "other" }] },
    { ...base, indexRelations: [{ ...rootIndexRelation, oid: "30" }] },
    { ...base, rowType: { ...base.rowType, oid: "4" } },
    { ...base, constraints: [{ ...constraint(), oid: "40" }, { ...constraint(), oid: "41" }] },
    { ...base, constraints: [{ ...constraint(), oid: "42", name: "one" }, { ...constraint(), oid: "42", name: "two" }] },
    { ...base, columns: [{ ...column(), relationOid: "30" }], toast: { ...base.toast!, columns: [{ ...column(), relationOid: "30" }] } },
    { ...base, indexes: [{ ...rootIndex, indexRelationOid: "20" }] },
    { ...base, dependencies: [{ ...dependency(), dependentOid: "9" }], toast: { ...base.toast!, dependencies: [{ ...dependency(), dependentOid: "9" }] } },
  ];
  for (const shape of collisions) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("root and TOAST nested index relations require exact sorted OID bijections", () => {
  const idx2 = { ...index(), indexRelationOid: "2" }, idx10 = { ...index(), indexRelationOid: "10" }; const rel2 = { ...catalogRelation(), oid: "2", kind: "other", rawKind: "r" }, rel10 = { ...catalogRelation(), oid: "10", kind: "other", rawKind: "r" };
  const idx20 = { ...index(), indexRelationOid: "20" }, rel20 = { ...catalogRelation(), oid: "20", kind: "other", rawKind: "r" }; const valid = { ...registryShape(), relation: { ...catalogRelation(), oid: "1" }, indexes: [idx2, idx10], indexRelations: [rel2, rel10], toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [], indexes: [idx20], indexRelations: [rel20], dependencies: [] } };
  expect(parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: valid, rows: [row()] } }, [definition], catalogContext).state.kind).toBe("present");
  for (const shape of [{ ...valid, indexRelations: [rel2] }, { ...valid, indexRelations: [rel2, rel10, { ...rel10, oid: "11" }] }, { ...valid, indexRelations: [rel10, rel2] }, { ...valid, indexRelations: [{ ...rel2, oid: "3" }, rel10] }, { ...valid, toast: { ...valid.toast!, indexRelations: [] } }, { ...valid, toast: { ...valid.toast!, indexRelations: [{ ...rel2, oid: "3" }] } }]) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("registry aggregate rejects hostile wrappers and deep-freezes every typed container", () => {
  const shape = registryShape(); const input = registryPresent(); input.state.shape = shape;
  const parsed = parseOwnedStoreRegistrySnapshotV1(input, [definition], catalogContext); if (parsed.state.kind === "present") { for (const value of [parsed.state.shape.catalogClasses, parsed.state.shape.columns, parsed.state.shape.indexes, parsed.state.shape.indexRelations, parsed.state.shape.constraints, parsed.state.shape.triggers, parsed.state.shape.rules, parsed.state.shape.policies, parsed.state.shape.inheritance, parsed.state.shape.dependencies, parsed.state.shape.sequences]) expect(Object.isFrozen(value)).toBe(true); expect(parsed.state.shape).not.toBe(shape); }
  let hooks = 0; const getter: Record<string, unknown> = { kind: "present", rows: [row()] }; Object.defineProperty(getter, "shape", { enumerable: true, get() { hooks++; return shape; } });
  const revoked = Proxy.revocable(input, {}); revoked.revoke(); const hidden = registryPresent(); Object.defineProperty(hidden, "hidden", { value: true }); const inherited = Object.assign(Object.create({ inherited: true }), registryPresent());
  for (const value of [{ ...registryPresent(), extra: true }, hidden, inherited, new Proxy(registryPresent(), {}), revoked.proxy, Object.assign(registryPresent(), { [Symbol("x")]: true }), { ...registryPresent(), state: getter }]) expect(() => parseOwnedStoreRegistrySnapshotV1(value, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0);
  const toastShape = { ...registryShape(), toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [], indexes: [], indexRelations: [], dependencies: [] } };
  for (const toast of [{ ...toastShape.toast!, extra: true }, Object.assign(Object.create({ inherited: true }), toastShape.toast!), Object.assign(toastShape.toast!, { [Symbol("x")]: true })]) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...toastShape, toast }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
  const sparse: unknown[] = []; sparse[1] = column(); const extended = [column()]; Object.defineProperty(extended, "4294967295", { value: column() }); for (const columns of [sparse, extended, new Proxy([column()], {})]) expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...shape, columns }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT");
});

test("registry catalogue occurrence budget is global, pre-access, and resets per invocation", () => {
  const operatorOids = Array(65536).fill("1"); const fullConstraint = { ...constraint(), primaryForeignEqualityOperatorOids: operatorOids, primaryPrimaryEqualityOperatorOids: operatorOids, foreignForeignEqualityOperatorOids: operatorOids, defaultEqualityOperatorOids: operatorOids }; const rules = Array.from({ length: 65532 }, (_, index) => ({ ...rule(), oid: String(index + 10) }));
  const exact = { ...registryShape(), rules, constraints: [fullConstraint] }; expect(parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: exact, rows: [row(), rowFor("other", "other_")] } }, [], catalogContext).state.kind).toBe("present");
  let calls = 0; const oversized = Array.from({ length: 65533 }, (_, index) => ({ ...rule(), oid: String(index + 10) })); Object.defineProperty(oversized, "65532", { get() { calls++; return { ...rule(), oid: "70000" }; } });
  expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...registryShape(), rules: oversized, constraints: [fullConstraint] }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
  expect(parseOwnedStoreRegistrySnapshotV1(registryPresent(), [definition], catalogContext).state.kind).toBe("present");
});

test("registry root, state, shape, and TOAST reject every hostile closed-record mutation", () => {
  const fresh = (): Record<string, unknown> => ({ ...registryPresent(), state: { kind: "present", shape: { ...registryShape(), toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [], indexes: [], indexRelations: [], dependencies: [] } }, rows: [row()] } });
  const boundary = (root: Record<string, unknown>, level: "root" | "state" | "shape" | "toast"): Record<string, unknown> => level === "root" ? root : level === "state" ? root.state as Record<string, unknown> : level === "shape" ? (root.state as Record<string, unknown>).shape as Record<string, unknown> : ((root.state as Record<string, unknown>).shape as Record<string, unknown>).toast as Record<string, unknown>;
  const replace = (root: Record<string, unknown>, level: "root" | "state" | "shape" | "toast", value: unknown): Record<string, unknown> => {
    if (level === "root") return value as Record<string, unknown>;
    const state = root.state as Record<string, unknown>; if (level === "state") return { ...root, state: value };
    const shape = state.shape as Record<string, unknown>; if (level === "shape") return { ...root, state: { ...state, shape: value } };
    return { ...root, state: { ...state, shape: { ...shape, toast: value } } };
  };
  for (const level of ["root", "state", "shape", "toast"] as const) {
    for (const key of Object.keys(boundary(fresh(), level))) { const root = fresh(); const target = { ...boundary(root, level) }; delete target[key]; expect(() => parseOwnedStoreRegistrySnapshotV1(replace(root, level, target), [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
    for (const mutate of [
      (target: Record<string, unknown>) => ({ ...target, extra: true }),
      (target: Record<string, unknown>) => { const copy = { ...target }; Object.defineProperty(copy, "hidden", { value: true }); return copy; },
      (target: Record<string, unknown>) => Object.assign(Object.create({ inherited: true }), target),
      (target: Record<string, unknown>) => Object.assign({ ...target }, { [Symbol("x")]: true }),
      (target: Record<string, unknown>) => new Proxy(target, {}),
    ]) { const root = fresh(); expect(() => parseOwnedStoreRegistrySnapshotV1(replace(root, level, mutate(boundary(root, level))), [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
    for (const kind of ["accessor", "trapped", "revoked"] as const) { const root = fresh(); const target = boundary(root, level); let calls = 0; let value: unknown;
      if (kind === "accessor") { const copy = { ...target }; Object.defineProperty(copy, Object.keys(copy)[0]!, { enumerable: true, get() { calls++; return undefined; } }); value = copy; }
      else if (kind === "trapped") value = new Proxy(target, { get() { calls++; throw new Error("hook"); }, getPrototypeOf() { calls++; throw new Error("hook"); }, ownKeys() { calls++; throw new Error("hook"); }, getOwnPropertyDescriptor() { calls++; throw new Error("hook"); } });
      else { const revoked = Proxy.revocable(target, {}); revoked.revoke(); value = revoked.proxy; }
      expect(() => parseOwnedStoreRegistrySnapshotV1(replace(root, level, value), [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
    }
  }
});

test("registry recursively copies and freezes a nonempty root and TOAST aggregate", () => {
  const rootRelation = { ...catalogRelation(), oid: "1", options: ["fillfactor=90"] }; const rootIndex = { ...index(), indexRelationOid: "2", tableRelationOid: "1", expression: "\0", predicate: "\t" }; const rootIndexRelation = { ...catalogRelation(), oid: "2", kind: "other", rawKind: "r", options: ["x"] };
  const toastIndex = { ...index(), indexRelationOid: "20", tableRelationOid: "30" }; const toastIndexRelation = { ...catalogRelation(), oid: "20", kind: "other", rawKind: "r" };
  const rootColumn = { ...column(), relationOid: "1", default: { kind: "string", value: "\0value" } }; const toastColumn = { ...column(), relationOid: "30", name: "toast_value" };
  const rootConstraint = { ...constraint(), oid: "40", relationOid: "1", columns: ["source"], referencedColumns: ["target"], deleteSetColumns: ["source"], checkExpression: { kind: "in", left: "source", values: ["\0", 1] } };
  const shape = { catalogClasses: [{ oid: "90", schema: "other", name: "class", kind: "other" }], relation: rootRelation, rowType: { oid: "3", relationOid: "1", schema: "public", name: "t", kind: "composite", arrayTypeOid: "4" }, arrayType: { oid: "4", elementTypeOid: "3", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }, columns: [rootColumn], indexes: [rootIndex], indexRelations: [rootIndexRelation], constraints: [rootConstraint], triggers: [{ ...trigger(), oid: "50", relationOid: "1" }], rules: [{ ...rule(), oid: "60", relationOid: "1" }], policies: [{ ...policy(), oid: "70", relationOid: "1", roles: ["0", "1"] }], inheritance: [{ ...inheritance(), childRelationOid: "1", parentRelationOid: "5" }], dependencies: [{ ...dependency(), dependentOid: "1" }], sequences: [{ ...sequence(), relationOid: "1" }], toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [toastColumn], indexes: [toastIndex], indexRelations: [toastIndexRelation], dependencies: [{ ...dependency(), dependentOid: "30" }] } };
  const input = { ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }; const parsed = parseOwnedStoreRegistrySnapshotV1(input, [definition], catalogContext); const copied = (source: unknown, output: unknown): void => { if (source && typeof source === "object") { expect(output).not.toBe(source); expect(Object.isFrozen(output)).toBe(true); expect(Array.isArray(output)).toBe(Array.isArray(source)); const sourceRecord = source as Record<string, unknown>; const outputRecord = output as Record<string, unknown>; expect(Object.keys(outputRecord).sort()).toEqual(Object.keys(sourceRecord).sort()); for (const key of Object.keys(sourceRecord)) copied(sourceRecord[key], outputRecord[key]); } else expect(output).toBe(source); }; copied(input, parsed);
  const before = JSON.stringify(parsed); rootRelation.options[0] = "changed"; rootColumn.default.value = "changed"; rootConstraint.columns[0] = "changed"; (input.state.shape as typeof shape).policies[0]!.roles[0] = "1"; (input.state.shape as typeof shape).toast.indexes[0]!.options[0] = "-1"; input.state.rows[0]!.storeKey = "changed"; expect(JSON.stringify(parsed)).toBe(before);
});

test("registry mixed root and TOAST occurrence budget is exact and pre-access", () => {
  const rootRules = Array.from({ length: 32760 }, (_, i) => ({ ...rule(), oid: String(i + 100) })); const rootDependencies = Array.from({ length: 32760 }, (_, i) => ({ ...dependency(), dependentOid: String(i + 100) }));
  const toastDependencies = Array.from({ length: 6 }, (_, i) => ({ ...dependency(), dependentOid: String(i + 40000) })); const toastIndexes = ["2", "10"].map((oid) => ({ ...index(), indexRelationOid: oid, tableRelationOid: "30" })); const toastRelations = ["2", "10"].map((oid) => ({ ...catalogRelation(), oid, kind: "other", rawKind: "r" }));
  const exactShape = { ...registryShape(), relation: { ...catalogRelation(), oid: "1", options: Array(65536).fill("x") }, rules: rootRules, dependencies: rootDependencies, toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [{ ...column(), relationOid: "30", name: "a" }, { ...column(), relationOid: "30", attnum: "2", name: "b" }], indexes: toastIndexes, indexRelations: toastRelations, dependencies: toastDependencies } };
  const exactInput = { ...registryPresent(), state: { kind: "present", shape: exactShape, rows: [row(), rowFor("other", "other_")] } }; expect(parseOwnedStoreRegistrySnapshotV1(exactInput, [], catalogContext).state.kind).toBe("present");
  let calls = 0; const tooMany = [...toastDependencies, { ...dependency(), dependentOid: "999" }]; Object.defineProperty(tooMany, "6", { get() { calls++; return { ...dependency(), dependentOid: "999" }; } }); expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...exactShape, toast: { ...exactShape.toast, dependencies: tooMany } }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0); expect(parseOwnedStoreRegistrySnapshotV1(registryPresent(), [definition], catalogContext).state.kind).toBe("present");
});

test("TOAST two-index numeric relation bijection rejects independent malformed orders", () => {
  const make = () => { const indexes = ["2", "10"].map((oid) => ({ ...index(), indexRelationOid: oid, tableRelationOid: "30" })); const relations = ["2", "10"].map((oid) => ({ ...catalogRelation(), oid, kind: "other", rawKind: "r" })); return { ...registryShape(), relation: { ...catalogRelation(), oid: "1" }, toast: { ownerTableOid: "1", relation: { ...catalogRelation(), oid: "30" }, columns: [], indexes, indexRelations: relations, dependencies: [] } }; };
  expect(parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: make(), rows: [row()] } }, [definition], catalogContext).state.kind).toBe("present");
  const bad = [(shape: ReturnType<typeof make>) => { shape.toast.indexRelations.reverse(); }, (shape: ReturnType<typeof make>) => { shape.toast.indexRelations[1] = { ...shape.toast.indexRelations[0]! }; }, (shape: ReturnType<typeof make>) => { shape.toast.indexRelations.pop(); }, (shape: ReturnType<typeof make>) => { shape.toast.indexRelations.push({ ...catalogRelation(), oid: "11", kind: "other", rawKind: "r" }); }, (shape: ReturnType<typeof make>) => { shape.toast.indexRelations[0] = { ...shape.toast.indexRelations[0]!, oid: "3" }; }];
  for (const mutate of bad) { const shape = make(); mutate(shape); expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
});

test("registry counts duplicate constraint occurrences before duplicate validation", () => {
  const classes = Array.from({ length: 65532 }, (_, i) => ({ oid: String(i + 100), schema: "other", name: `c${i}`, kind: "other" })); const constraints = [{ ...constraint(), oid: "90", name: "one" }, { ...constraint(), oid: "90", name: "two" }]; let calls = 0; Object.defineProperty(constraints, "1", { get() { calls++; return { ...constraint(), oid: "90", name: "two" }; } });
  expect(() => parseOwnedStoreRegistrySnapshotV1({ ...registryPresent(), state: { kind: "present", shape: { ...registryShape(), catalogClasses: classes, constraints }, rows: [row()] } }, [definition], catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(calls).toBe(0);
});

test("main snapshot copies every nonempty category and rejects hostile category DTOs without hooks", () => {
  const full = () => ({ ...catalogSnapshot(), requestedScopes: [{ schema: "public", tablePrefix: "p" }], existingSchemas: ["public"], catalogClasses: [{ oid: "100", schema: "other", name: "class", kind: "other" }], relations: [{ ...catalogRelation(), oid: "101" }], rowTypes: [{ oid: "102", relationOid: "101", schema: "public", name: "t", kind: "composite", arrayTypeOid: "103" }], arrayTypes: [{ oid: "103", elementTypeOid: "102", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }], columns: [{ ...column(), relationOid: "101", default: { kind: "string", value: "nested" }, defaultObjectOid: "9" }], indexes: [{ ...index(), indexRelationOid: "104", tableRelationOid: "101" }], constraints: [{ ...constraint(), oid: "105", relationOid: "101", checkExpression: { kind: "in", left: "source", values: ["nested", 1] }, primaryForeignEqualityOperatorOids: ["1"], primaryPrimaryEqualityOperatorOids: ["2"], foreignForeignEqualityOperatorOids: ["3"], defaultEqualityOperatorOids: ["4"] }], triggers: [{ ...trigger(), oid: "106", relationOid: "101" }], rules: [{ ...rule(), oid: "107", relationOid: "101" }], policies: [{ ...policy(), oid: "108", relationOid: "101" }], inheritance: [{ ...inheritance(), childRelationOid: "101", parentRelationOid: "109" }], dependencies: [{ ...dependency(), dependentClassOid: "100", dependentOid: "101", referencedClassOid: "999", referencedOid: "101" }], sequences: [{ ...sequence(), relationOid: "101" }] });
  const input = full(); const parsed = parseOwnedStoreCatalogSnapshotV1(input, catalogContext); const paired = (source: unknown, output: unknown): void => { if (source && typeof source === "object") { expect(output).not.toBe(source); expect(Object.isFrozen(output)).toBe(true); expect(Array.isArray(output)).toBe(Array.isArray(source)); const left = source as Record<string, unknown>; const right = output as Record<string, unknown>; expect(Object.keys(right).sort()).toEqual(Object.keys(left).sort()); for (const key of Object.keys(left)) paired(left[key], right[key]); } else expect(output).toBe(source); }; paired(input, parsed); for (const field of ["catalogClasses", "relations", "rowTypes", "arrayTypes", "columns", "indexes", "constraints", "triggers", "rules", "policies", "inheritance", "dependencies", "sequences"] as const) { expect(Object.isFrozen(parsed[field])).toBe(true); expect(parsed[field]).not.toBe(input[field]); expect(parsed[field][0]).not.toBe(input[field][0]); expect(Object.isFrozen(parsed[field][0]!)).toBe(true); }
  const before = JSON.stringify(parsed); input.catalogClasses[0]!.name = "changed"; input.relations[0]!.name = "changed"; input.rowTypes[0]!.name = "changed"; input.arrayTypes[0]!.name = "changed"; input.columns[0]!.name = "changed"; input.columns[0]!.default.value = "changed"; input.indexes[0]!.name = "changed"; input.indexes[0]!.options[0] = "1"; input.constraints[0]!.name = "changed"; input.constraints[0]!.checkExpression.values[0] = "changed"; input.constraints[0]!.primaryForeignEqualityOperatorOids[0] = "9"; input.constraints[0]!.primaryPrimaryEqualityOperatorOids[0] = "9"; input.constraints[0]!.foreignForeignEqualityOperatorOids[0] = "9"; input.constraints[0]!.defaultEqualityOperatorOids[0] = "9"; input.triggers[0]!.name = "changed"; input.rules[0]!.name = "changed"; input.policies[0]!.name = "changed"; input.inheritance[0]!.sequence = "2"; input.dependencies[0]!.kind = "other"; input.sequences[0]!.cycle = true; expect(JSON.stringify(parsed)).toBe(before);
  const makes = { catalogClasses: () => ({ oid: "100", schema: "other", name: "class", kind: "other" }), relations: catalogRelation, rowTypes: () => ({ oid: "102", relationOid: "101", schema: "public", name: "t", kind: "composite", arrayTypeOid: "103" }), arrayTypes: catalogArrayType, columns: column, indexes: index, constraints: constraint, triggers: trigger, rules: rule, policies: policy, inheritance, dependencies: dependency, sequences: sequence };
  for (const [field, make] of Object.entries(makes) as readonly [keyof typeof makes, () => Record<string, unknown>][]) { let hooks = 0; for (const key of Object.keys(make())) { const missing = make(); delete missing[key]; expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), [field]: [missing] }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); } const sparse: unknown[] = []; sparse[1] = make(); const extended = [make()]; Object.defineProperty(extended, "4294967295", { value: make() }); const accessor = [make()]; Object.defineProperty(accessor, "0", { get() { hooks++; return make(); } }); const dtoGetter = make(); Object.defineProperty(dtoGetter, Object.keys(dtoGetter)[0]!, { enumerable: true, get() { hooks++; return undefined; } }); const trapped = new Proxy(make(), { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const revoked = Proxy.revocable(make(), {}); revoked.revoke(); const arrayTrapped = new Proxy([make()], { get() { hooks++; throw new Error("hook"); }, getPrototypeOf() { hooks++; throw new Error("hook"); }, ownKeys() { hooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks++; throw new Error("hook"); } }); const arrayRevoked = Proxy.revocable([make()], {}); arrayRevoked.revoke(); const hidden = make(); Object.defineProperty(hidden, "hidden", { value: true }); const inherited = Object.assign(Object.create({ inherited: true }), make()); for (const facts of [sparse, extended, accessor, [dtoGetter], [trapped], [revoked.proxy], arrayTrapped, arrayRevoked.proxy, Object.assign([make()], { [Symbol("x")]: true }), [{ ...make(), extra: true }], [hidden], [inherited], [Object.assign(make(), { [Symbol("x")]: true })]]) expect(() => parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), [field]: facts }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0); }
});

test("main snapshot enforces every structural identity and one cumulative fact budget", () => {
  const root = () => ({ ...catalogSnapshot(), catalogClasses: [{ oid: "100", schema: "other", name: "a", kind: "other" }], relations: [{ ...catalogRelation(), oid: "101" }], rowTypes: [{ oid: "102", relationOid: "101", schema: "public", name: "t", kind: "composite", arrayTypeOid: "103" }], arrayTypes: [{ oid: "103", elementTypeOid: "102", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_t", kind: "base", category: "array" }], columns: [{ ...column(), relationOid: "101" }], indexes: [{ ...index(), indexRelationOid: "104", tableRelationOid: "101" }], constraints: [{ ...constraint(), oid: "105", relationOid: "101" }], triggers: [{ ...trigger(), oid: "106", relationOid: "101" }], rules: [{ ...rule(), oid: "107", relationOid: "101" }], policies: [{ ...policy(), oid: "108", relationOid: "101" }], inheritance: [{ ...inheritance(), childRelationOid: "101", parentRelationOid: "109" }], dependencies: [{ ...dependency(), dependentClassOid: "999", dependentOid: "500", referencedClassOid: "998", referencedOid: "101" }], sequences: [{ ...sequence(), relationOid: "101" }] });
  expect(parseOwnedStoreCatalogSnapshotV1({ ...root(), constraints: [{ ...constraint(), oid: "105", relationOid: "101", name: "x" }, { ...constraint(), oid: "106", relationOid: "101", name: "y" }], dependencies: [{ ...dependency(), dependentClassOid: "999", dependentOid: "500", referencedClassOid: "998", referencedOid: "101" }, { ...dependency(), dependentClassOid: "999", dependentOid: "500", referencedClassOid: "998", referencedOid: "101", kind: "automatic" }], sequences: [{ ...sequence(), relationOid: "101", type: "other" }], relations: [{ ...catalogRelation(), oid: "101", kind: "other", rawKind: "x", isPartition: true, rowSecurity: true, forceRowSecurity: true, replicaIdentity: "full" }] }, catalogContext).dependencies).toHaveLength(2);
  const invalid = [(x: ReturnType<typeof root>) => { x.catalogClasses.push({ ...x.catalogClasses[0]! }); }, (x: ReturnType<typeof root>) => { x.relations.push({ ...x.relations[0]! }); }, (x: ReturnType<typeof root>) => { x.rowTypes.push({ ...x.rowTypes[0]! }); }, (x: ReturnType<typeof root>) => { x.arrayTypes.push({ ...x.arrayTypes[0]! }); }, (x: ReturnType<typeof root>) => { x.columns.push({ ...x.columns[0]! }); }, (x: ReturnType<typeof root>) => { x.indexes.push({ ...x.indexes[0]! }); }, (x: ReturnType<typeof root>) => { x.constraints.push({ ...x.constraints[0]!, name: "different" }); }, (x: ReturnType<typeof root>) => { x.constraints.push({ ...x.constraints[0]!, oid: "110" }); }, (x: ReturnType<typeof root>) => { x.triggers.push({ ...x.triggers[0]! }); }, (x: ReturnType<typeof root>) => { x.rules.push({ ...x.rules[0]! }); }, (x: ReturnType<typeof root>) => { x.policies.push({ ...x.policies[0]! }); }, (x: ReturnType<typeof root>) => { x.inheritance.push({ ...x.inheritance[0]! }); }, (x: ReturnType<typeof root>) => { x.dependencies.push({ ...x.dependencies[0]! }); }, (x: ReturnType<typeof root>) => { x.sequences.push({ ...x.sequences[0]! }); }, (x: ReturnType<typeof root>) => { x.relations[0] = { ...x.relations[0]!, oid: "100" }; }, (x: ReturnType<typeof root>) => { x.arrayTypes[0] = { ...x.arrayTypes[0]!, oid: "102" }; }]; for (const mutate of invalid) { const value = root(); mutate(value); expect(() => parseOwnedStoreCatalogSnapshotV1(value, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); }
  expect(parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), relations: [{ ...catalogRelation(), oid: "101" }], constraints: [{ ...constraint(), relationOid: "999", referencedRelationOid: "101", columns: ["x".repeat(64)], referencedColumns: ["y".repeat(64)] }] }, Object.freeze({ maxIdentifierLength: 64n })).constraints[0]!.relationOid).toBe("999");
  expect(parseOwnedStoreCatalogSnapshotV1({ ...catalogSnapshot(), constraints: [{ ...constraint(), name: "x".repeat(64) }] }, Object.freeze({ maxIdentifierLength: 64n })).constraints[0]!.name).toHaveLength(64);
  const classes = Array.from({ length: 32767 }, (_, index) => ({ oid: String(index + 100), schema: "other", name: `c${index}`, kind: "other" })); const rules = Array.from({ length: 32767 }, (_, index) => ({ ...rule(), oid: String(index + 40000) })); const requestedScopes = Array.from({ length: 8320 }, (_, index) => ({ schema: `s${String(index).padStart(4, "0")}`, tablePrefix: "p" })); const operatorOids = Array(65536).fill("1"); const exact = { ...catalogSnapshot(), requestedScopes, existingSchemas: requestedScopes.map(x => x.schema), catalogClasses: classes, rules, constraints: [{ ...constraint(), oid: "80000", primaryForeignEqualityOperatorOids: operatorOids, primaryPrimaryEqualityOperatorOids: operatorOids, foreignForeignEqualityOperatorOids: operatorOids, defaultEqualityOperatorOids: operatorOids }], sequences: [{ ...sequence(), relationOid: "90000" }] }; expect(parseOwnedStoreCatalogSnapshotV1(exact, catalogContext).rules).toHaveLength(32767);
  expect(() => parseOwnedStoreCatalogSnapshotV1({ ...exact, sequences: [{ ...sequence(), relationOid: "90000" }, { ...sequence(), relationOid: "90001" }] }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); let hooks = 0; const late = [{ ...sequence(), relationOid: "90000" }, { ...sequence(), relationOid: "90000" }]; Object.defineProperty(late, "1", { get() { hooks++; return { ...sequence(), relationOid: "90000" }; } }); expect(() => parseOwnedStoreCatalogSnapshotV1({ ...exact, sequences: late }, catalogContext)).toThrow("ORM_OWNED_STORE_DRIFT"); expect(hooks).toBe(0); expect(parseOwnedStoreCatalogSnapshotV1(catalogSnapshot(), catalogContext).contract).toBe("bazis.orm-owned-store-catalog-snapshot/v1");
});

const b2Expected: OrmExpectedSchema = {
  tables: [{
    schema: "public",
    table: "bazis_items",
    columns: [{ property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "number", value: 1 }, generation: "none" }],
    primaryKey: { name: "pk_items", columns: ["id"] },
    indexes: [{ name: "ix_items_id", columns: ["id"], unique: false, method: "btree" }],
    foreignKeys: [],
    checks: [{ name: "ck_items_id", expression: { kind: "compare", op: ">=", left: "id", right: 1 } }],
  }],
};
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type MutableCatalogSnapshot = Mutable<OwnedStoreCatalogSnapshotV1>;
type MutableExpectedSchema = Mutable<OrmExpectedSchema>;
const mutableB2Expected = (): MutableExpectedSchema => ({
  tables: [{
    schema: "public",
    table: "bazis_items",
    columns: [{ property: "id", column: "id", physicalType: "integer", nullable: false, default: { kind: "number", value: 1 }, generation: "none" }],
    primaryKey: { name: "pk_items", columns: ["id"] },
    indexes: [{ name: "ix_items_id", columns: ["id"], unique: false, method: "btree" }],
    foreignKeys: [],
    checks: [{ name: "ck_items_id", expression: { kind: "compare", op: ">=", left: "id", right: 1 } }],
  }],
});
const b2Definition = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "b2", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "bazis_" } });
const b2Relation = (
  oid: string,
  name: string,
  kind: "ordinaryTable" | "index",
  rawKind: string,
  rowTypeOid: string | null,
  toastRelationOid: string | null = null,
) : MutableCatalogSnapshot["relations"][number] => ({ oid, namespaceOid: "12000", schema: "public", name, kind, rawKind, persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: kind === "ordinaryTable" ? "default" : "nothing", tablespaceOid: "0", accessMethod: kind === "ordinaryTable" ? "heap" : "btree", options: [], rowTypeOid, toastRelationOid });
const b2Index = (oid: string, name: string, primary: boolean, unique: boolean, backingConstraintOid: string | null): MutableCatalogSnapshot["indexes"][number] => ({
  ...index(),
  indexRelationOid: oid,
  tableRelationOid: "10",
  name,
  primary,
  unique,
  backingConstraintOid,
  attributeNumbers: ["1"],
  columnNames: ["id"],
  opclassOids: ["99"],
  defaultOpclassOids: ["99"],
  predicate: null as string | null,
});
const b2Snapshot = (): MutableCatalogSnapshot => ({
  ...catalogSnapshot(),
  contract: "bazis.orm-owned-store-catalog-snapshot/v1",
  requestedScopes: [{ schema: "public", tablePrefix: "bazis_" }],
  existingSchemas: ["public"],
  catalogClasses: [{ oid: "1", schema: "pg_catalog", name: "pg_class", kind: "pg_class" }, { oid: "2", schema: "pg_catalog", name: "pg_type", kind: "pg_type" }, { oid: "3", schema: "pg_catalog", name: "pg_constraint", kind: "pg_constraint" }, { oid: "4", schema: "pg_catalog", name: "pg_attrdef", kind: "pg_attrdef" }, { oid: "5", schema: "pg_catalog", name: "pg_namespace", kind: "pg_namespace" }],
  relations: [b2Relation("10", "bazis_items", "ordinaryTable", "r", "11"), b2Relation("12", "pk_items", "index", "i", null), b2Relation("13", "ix_items_id", "index", "i", null)],
  rowTypes: [{ oid: "11", relationOid: "10", schema: "public", name: "bazis_items", kind: "composite", arrayTypeOid: "15" }],
  arrayTypes: [{ oid: "15", elementTypeOid: "11", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_bazis_items", kind: "base", category: "array" }],
  columns: [{ ...column(), relationOid: "10", name: "id", physicalType: "integer", notNull: true, default: { kind: "number", value: 1 } as CanonicalDefault, defaultObjectOid: "14" as string | null, generation: "none", identityCode: "", generatedCode: "", storageCode: "p", typeDefaultStorageCode: "p", compressionCode: "" }],
  indexes: [b2Index("12", "pk_items", true, true, "16"), b2Index("13", "ix_items_id", false, false, null)],
  constraints: [{ ...constraint(), oid: "16", relationOid: "10", referencedRelationOid: null as string | null, name: "pk_items", kind: "primaryKey", columns: ["id"], referencedColumns: [] as string[], backingIndexOid: "12", onDelete: null, onUpdate: null, match: null, noInherit: true }, { ...constraint(), oid: "17", relationOid: "10", referencedRelationOid: null as string | null, name: "ck_items_id", kind: "check", columns: ["id"], referencedColumns: [] as string[], backingIndexOid: null, onDelete: null, onUpdate: null, match: null, noInherit: false, checkExpression: { kind: "compare", op: ">=", left: "id", right: 1 } }],
  dependencies: [{ dependentClassOid: "1", dependentOid: "10", dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" }, { dependentClassOid: "2", dependentOid: "11", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "2", dependentOid: "15", dependentSubId: "0", referencedClassOid: "2", referencedOid: "11", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "4", dependentOid: "14", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "3", dependentOid: "16", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "1", dependentOid: "12", dependentSubId: "0", referencedClassOid: "3", referencedOid: "16", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "1", dependentOid: "13", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "3", dependentOid: "17", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "3", dependentOid: "17", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "normal" }] 
});

test("projects one parsed ordinary table and closes its raw dependencies", () => {
  const scopes = [{ schema: "public", tablePrefix: "bazis_" }]; const parsed = parseOwnedStoreCatalogSnapshotV1(b2Snapshot(), catalogContext); expect(() => verifyOwnedStoreCatalogAllV1(parsed, { stores: [{ definition: b2Definition, expectedSchema: b2Expected }], requestedScopes: scopes })).not.toThrow();
  for (const mutate of [(input: ReturnType<typeof b2Snapshot>) => { input.relations[0]!.namespaceOid = "11999"; }, (input: ReturnType<typeof b2Snapshot>) => { input.columns[0]!.compressionCode = "p"; }, (input: ReturnType<typeof b2Snapshot>) => { input.indexes[1]!.predicate = "id > 0"; }, (input: ReturnType<typeof b2Snapshot>) => { input.constraints[1]!.noInherit = true; }, (input: ReturnType<typeof b2Snapshot>) => { input.dependencies.pop(); }]) { const input = b2Snapshot(); mutate(input); expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(input, catalogContext), { stores: [{ definition: b2Definition, expectedSchema: b2Expected }], requestedScopes: scopes })).toThrow("ORM_OWNED_STORE_DRIFT"); }
});

const verifyB21 = (input: unknown, expected: OrmExpectedSchema = b2Expected): void => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(input, catalogContext), { stores: [{ definition: b2Definition, expectedSchema: expected }], requestedScopes: [{ schema: "public", tablePrefix: "bazis_" }] });
// @ts-expect-error old three-argument semantic API was deliberately removed.
const oldSemanticInvocationMustFail = (): void => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(b2Snapshot(), catalogContext), b2Expected, []);
const drift = (work: () => void): void => { try { work(); throw new Error("expected drift"); } catch (error) { expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError); expect((error as OrmOwnedStoreAdmissionError).code).toBe("ORM_OWNED_STORE_DRIFT"); expect((error as Error).message).toBe("ORM_OWNED_STORE_DRIFT"); } };

const b2FixedRegistry = (publicSchemaExists = true) => {
  const source = b2Snapshot(), rootOid = "50", rowOid = "51", arrayOid = "52", constraintOid = "53", indexOid = "54";
  const root = { ...source.relations[0]!, oid: rootOid, name: "__bazis_orm_owned_stores_v1", rowTypeOid: rowOid };
  const names = ["store_key", "contract", "format_version", "owned_schema", "table_prefix", "owned_scope_hash", "model_hash", "created_at"] as const;
  const types: readonly string[] = ["text", "text", "integer", "text", "text", "text", "text", "datetime"];
  const columns = names.map((name, index) => ({ ...source.columns[0]!, relationOid: rootOid, attnum: String(index + 1), name, physicalType: types[index]!, typeOid: types[index] === "text" ? "25" : types[index] === "datetime" ? "1184" : "20", default: { kind: "none" } as CanonicalDefault, defaultObjectOid: null, collationOid: types[index] === "text" ? "100" : "0", typeDefaultCollationOid: types[index] === "text" ? "100" : "0", storageCode: types[index] === "text" ? "x" : "p", typeDefaultStorageCode: types[index] === "text" ? "x" : "p" }));
  const pkName = "__bazis_orm_owned_stores_v1_pkey";
  return {
    contract: "bazis.orm-owned-store-registry-snapshot/v1", publicSchemaExists,
    state: { kind: "present", rows: [rowFor("b2", "bazis_")], shape: {
      catalogClasses: source.catalogClasses, relation: root,
      rowType: { ...source.rowTypes[0]!, oid: rowOid, relationOid: rootOid, name: root.name, arrayTypeOid: arrayOid },
      arrayType: { ...source.arrayTypes[0]!, oid: arrayOid, elementTypeOid: rowOid, name: "_bazis_orm_owned_stores_v1" }, columns,
      indexes: [{ ...source.indexes[0]!, indexRelationOid: indexOid, tableRelationOid: rootOid, name: pkName, backingConstraintOid: constraintOid as string | null, columnNames: ["store_key"], collationOids: ["100"], opclassOids: ["3126"], defaultOpclassOids: ["3126"] }],
      indexRelations: [{ ...source.relations[1]!, oid: indexOid, name: pkName }],
      constraints: [{ ...source.constraints[0]!, oid: constraintOid, relationOid: rootOid, name: pkName, columns: ["store_key"], backingIndexOid: indexOid }],
      triggers: [], rules: [], policies: [], inheritance: [], sequences: [], toast: null,
      dependencies: [
        { dependentClassOid: "1", dependentOid: rootOid, dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" },
        { dependentClassOid: "2", dependentOid: rowOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "0", kind: "internal" },
        { dependentClassOid: "2", dependentOid: arrayOid, dependentSubId: "0", referencedClassOid: "2", referencedOid: rowOid, referencedSubId: "0", kind: "internal" },
        { dependentClassOid: "3", dependentOid: constraintOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "1", kind: "automatic" },
        { dependentClassOid: "1", dependentOid: indexOid, dependentSubId: "0", referencedClassOid: "3", referencedOid: constraintOid, referencedSubId: "0", kind: "internal" },
      ],
    } },
  };
};
const inspectB2PreCreate = (rawRegistry: unknown, input = b2Snapshot()) => inspectOwnedStoreCatalogPreCreateV1(
  parseOwnedStoreCatalogSnapshotV1(input, catalogContext),
  parseOwnedStoreRegistrySnapshotV1(rawRegistry, [b2Definition], catalogContext),
  { stores: [{ definition: b2Definition, expectedSchema: b2Expected }], requestedScopes: [{ schema: "public", tablePrefix: "bazis_" }] },
);
const preCreateError = (work: () => unknown, code: "ORM_OWNED_STORE_DRIFT" | "ORM_OWNED_STORE_OWNERSHIP_CONFLICT") => {
  try { work(); throw new Error("expected admission error"); } catch (error) { expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError); expect((error as OrmOwnedStoreAdmissionError).code).toBe(code); expect((error as Error).message).toBe(code); }
};

test("pre-create accepts fixed present Registry when public schema exists", () => {
  expect(inspectB2PreCreate(b2FixedRegistry())).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
});

test("pre-create rejects present Registry without public schema as exact drift", () => {
  preCreateError(() => inspectB2PreCreate(b2FixedRegistry(false)), "ORM_OWNED_STORE_DRIFT");
});

test("pre-create preserves actual inbound ownership conflict before Registry flag drift", () => {
  const input = b2Snapshot();
  input.constraints.push({ ...input.constraints[0]!, oid: "90", relationOid: "91", referencedRelationOid: "10", name: "inbound", kind: "foreignKey", columns: ["id"], referencedColumns: ["id"], backingIndexOid: "12" });
  preCreateError(() => inspectB2PreCreate(b2FixedRegistry(false), input), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
});

test("pre-create keeps absent Registry without public schema as a create failure", () => {
  expect(() => parseOwnedStoreRegistrySnapshotV1(registryAbsent(false), [b2Definition], catalogContext)).toThrow("ORM_OWNED_STORE_CREATE_FAILED");
});

const b2FixedRegistryWithToast = () => {
  const registry = b2FixedRegistry(), shape = registry.state.shape, toastOid = "55", indexOid = "56";
  const toastRelation = { ...shape.relation, oid: toastOid, namespaceOid: "11999", schema: "pg_toast", name: "pg_toast_55", kind: "toastTable", rawKind: "t", replicaIdentity: "nothing", rowTypeOid: null, toastRelationOid: null };
  const toastColumns = ([
    ["chunk_id", "oid", "26"], ["chunk_seq", "integer", "23"], ["chunk_data", "bytea", "17"],
  ] as const).map(([name, physicalType, typeOid], index) => ({ ...shape.columns[2]!, relationOid: toastOid, attnum: String(index + 1), name, physicalType, typeOid, notNull: false, default: { kind: "none" } as CanonicalDefault, defaultObjectOid: null, generation: "none", identityCode: "", generatedCode: "", collationOid: "0", typeDefaultCollationOid: "0", storageCode: "p", typeDefaultStorageCode: "p", compressionCode: "" }));
  const toastIndex = { ...shape.indexes[0]!, indexRelationOid: indexOid, tableRelationOid: toastOid, name: "pg_toast_55_index", primary: true, unique: true, keyAttributeCount: "2", totalAttributeCount: "2", attributeNumbers: ["1", "2"], columnNames: ["chunk_id", "chunk_seq"], collationOids: ["0", "0"], opclassOids: ["3124", "3124"], defaultOpclassOids: ["3124", "3124"], options: ["0", "0"], backingConstraintOid: null };
  const toastIndexRelation = { ...toastRelation, oid: indexOid, name: toastIndex.name, kind: "index", rawKind: "i", accessMethod: "btree" };
  return { ...registry, state: { ...registry.state, shape: { ...shape, relation: { ...shape.relation, toastRelationOid: toastOid }, toast: { ownerTableOid: shape.relation.oid, relation: toastRelation, columns: toastColumns, indexes: [toastIndex], indexRelations: [toastIndexRelation], dependencies: [
    { dependentClassOid: "1", dependentOid: toastOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: shape.relation.oid, referencedSubId: "0", kind: "internal" },
    { dependentClassOid: "1", dependentOid: indexOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: toastOid, referencedSubId: "1", kind: "automatic" },
    { dependentClassOid: "1", dependentOid: indexOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: toastOid, referencedSubId: "2", kind: "automatic" },
  ] } } } };
};

test("durable fixed Registry closes shape, ordered facts, and dependency ledger", () => {
  expect(inspectB2PreCreate(b2FixedRegistry())).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
  const mutations: readonly [(registry: ReturnType<typeof b2FixedRegistry>) => void, string][] = [
    [(registry) => { registry.state.shape.columns[0]!.attnum = "2"; }, "column attnum"],
    [(registry) => { registry.state.shape.columns.pop(); }, "missing column"],
    [(registry) => { registry.state.shape.columns.push({ ...registry.state.shape.columns[0]!, attnum: "9" }); }, "extra column"],
    [(registry) => { registry.state.shape.columns[0]!.physicalType = "character varying"; }, "raw alias"],
    [(registry) => { registry.state.shape.indexes[0]!.backingConstraintOid = null; }, "backing index"],
    [(registry) => { registry.state.shape.rowType.arrayTypeOid = "999"; }, "row array"],
    [(registry) => { registry.state.shape.dependencies.pop(); }, "dependency"],
    [(registry) => { registry.state.shape.dependencies.push({ ...registry.state.shape.dependencies[0]!, dependentSubId: "2" }); }, "extra dependency"],
  ];
  for (const [mutate, label] of mutations) { const registry = b2FixedRegistry(); mutate(registry); preCreateError(() => inspectB2PreCreate(registry), "ORM_OWNED_STORE_DRIFT"); expect(label).toBeTruthy(); }
});

test("durable fixed Registry TOAST accepts closure and rejects isolated facts", () => {
  expect(inspectB2PreCreate(b2FixedRegistryWithToast())).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
  const mutations: readonly [(registry: ReturnType<typeof b2FixedRegistryWithToast>) => void, string][] = [
    [(registry) => { registry.state.shape.toast!.ownerTableOid = "999"; }, "owner"],
    [(registry) => { registry.state.shape.toast!.columns[0]!.notNull = true; }, "column"],
    [(registry) => { registry.state.shape.toast!.indexes[0]!.method = "hash"; }, "index"],
    [(registry) => { registry.state.shape.toast!.dependencies.pop(); }, "dependency"],
  ];
  for (const [mutate, label] of mutations) { const registry = b2FixedRegistryWithToast(); mutate(registry); preCreateError(() => inspectB2PreCreate(registry), "ORM_OWNED_STORE_DRIFT"); expect(label).toBeTruthy(); }
});

test("durable pre-create classifies every captured root kind without an identity", () => {
  for (const kind of ["ordinaryTable", "partitionedTable", "foreignTable", "view", "materializedView", "sequence", "index", "partitionedIndex", "toastTable", "other"] as const) {
    const input = b2Snapshot(); input.relations[0]!.kind = kind; input.relations[0]!.rawKind = kind === "ordinaryTable" ? "r" : "x";
    const registry = b2FixedRegistry(); registry.state.rows = [];
    expect(inspectB2PreCreate(registry, input)).toEqual({ kind: "occupiedMissingIdentity", storeKeys: ["b2"] });
  }
});

test("durable Registry keeps its local names separate from Main and rejects pg_type collisions", () => {
  const main = b2Snapshot(), registry = b2FixedRegistry();
  expect(main.relations[0]!.name).toBe("bazis_items");
  expect(registry.state.shape.relation.name).toBe("__bazis_orm_owned_stores_v1");
  expect(inspectB2PreCreate(registry, main)).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
  const rowArrayCollision = b2FixedRegistry(); rowArrayCollision.state.shape.arrayType.name = rowArrayCollision.state.shape.rowType.name;
  preCreateError(() => inspectB2PreCreate(rowArrayCollision), "ORM_OWNED_STORE_DRIFT");
  const classCollision = b2FixedRegistry(); classCollision.state.shape.catalogClasses[0]!.name = "pg_type";
  preCreateError(() => inspectB2PreCreate(classCollision), "ORM_OWNED_STORE_DRIFT");
});

const b2SevenNormalizedTypes = () => {
  const input = b2Snapshot(), types: readonly string[] = ["integer", "real", "text", "boolean", "datetime", "json", "uuid"];
  const typeOids: readonly string[] = ["23", "700", "25", "16", "1184", "3802", "2950"];
  input.dependencies = input.dependencies.filter((edge) => edge.dependentClassOid !== "4");
  input.columns = types.map((physicalType, index) => ({ ...input.columns[0]!, attnum: String(index + 1), name: index === 0 ? "id" : `v_${physicalType}`, physicalType, typeOid: typeOids[index]!, notNull: true, default: { kind: "none" } as CanonicalDefault, defaultObjectOid: null, collationOid: physicalType === "text" ? "100" : "0", typeDefaultCollationOid: physicalType === "text" ? "100" : "0", storageCode: physicalType === "text" ? "x" : "p", typeDefaultStorageCode: physicalType === "text" ? "x" : "p" }));
  const expected: OrmExpectedSchema = { tables: [{ ...b2Expected.tables[0]!, columns: types.map((physicalType, index) => ({ property: index === 0 ? "id" : `v_${physicalType}`, column: index === 0 ? "id" : `v_${physicalType}`, physicalType, nullable: false, default: { kind: "none" }, generation: "none" })) }] };
  return { input, expected };
};

test("durable complete normalized seven-type model rejects aliases on a fresh reread", () => {
  const fixture = b2SevenNormalizedTypes();
  expect(() => verifyB21(fixture.input, fixture.expected)).not.toThrow();
  const fresh = b2SevenNormalizedTypes(); fresh.input.columns[2]!.physicalType = "character varying";
  expect(() => parseOwnedStoreCatalogSnapshotV1(fresh.input, catalogContext)).not.toThrow();
  drift(() => verifyB21(fresh.input, fresh.expected));
});

const b2SevenDefaults = () => {
  const fixture = b2SevenNormalizedTypes();
  const defaults: readonly CanonicalDefault[] = [{ kind: "none" }, { kind: "null" }, { kind: "number", value: 7 }, { kind: "boolean", value: true }, { kind: "string", value: "value" }, { kind: "currentTimestamp" }, { kind: "uuidV4" }];
  fixture.input.columns.forEach((column, index) => { column.default = defaults[index]!; column.defaultObjectOid = index === 0 ? null : String(70 + index); });
  const expected: OrmExpectedSchema = { tables: fixture.expected.tables.map((table) => ({ ...table, columns: table.columns.map((column, index) => ({ ...column, default: defaults[index]! })) })) };
  for (let index = 1; index < defaults.length; index++) fixture.input.dependencies.push({ dependentClassOid: "4", dependentOid: String(70 + index), dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: String(index + 1), kind: "automatic" });
  return { input: fixture.input, expected };
};

test("durable seven-type defaults bind every attrdef owner and reject fresh wrong owners", () => {
  const fixture = b2SevenDefaults();
  expect(() => verifyB21(fixture.input, fixture.expected)).not.toThrow();
  for (let index = 1; index < 7; index++) {
    const fresh = b2SevenDefaults();
    fresh.input.dependencies.find((edge) => edge.dependentClassOid === "4" && edge.dependentOid === String(70 + index))!.referencedSubId = "1";
    expect(() => parseOwnedStoreCatalogSnapshotV1(fresh.input, catalogContext)).not.toThrow();
    drift(() => verifyB21(fresh.input, fresh.expected));
  }
});

const mixedDottedPreCreate = () => {
  const fixture = b2DottedTwoStores();
  const secondObject = (oid: string | null): boolean => oid !== null && Number(oid) >= 110 && Number(oid) < 1000;
  fixture.input.relations = fixture.input.relations.filter((entry) => !secondObject(entry.oid));
  fixture.input.rowTypes = fixture.input.rowTypes.filter((entry) => !secondObject(entry.oid));
  fixture.input.arrayTypes = fixture.input.arrayTypes.filter((entry) => !secondObject(entry.oid));
  fixture.input.columns = fixture.input.columns.filter((entry) => !secondObject(entry.relationOid));
  fixture.input.indexes = fixture.input.indexes.filter((entry) => !secondObject(entry.tableRelationOid));
  fixture.input.constraints = fixture.input.constraints.filter((entry) => !secondObject(entry.relationOid));
  fixture.input.dependencies = fixture.input.dependencies.filter((entry) => !secondObject(entry.dependentOid) && !secondObject(entry.referencedOid));
  const first = fixture.context.stores[0]!.definition;
  const registry = b2FixedRegistry();
  registry.state.rows = [{ ...rowFor(first.storeKey, first.ownedScope.tablePrefix), ownedSchema: first.ownedScope.schema, ownedScopeHash: canonicalOwnedStoreScopeHashV1(first) }];
  return { fixture, registry };
};

test("durable mixed existing A plus rootless B keeps the full context union", () => {
  const { fixture, registry } = mixedDottedPreCreate();
  const snapshot = parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext);
  const parsedRegistry = parseOwnedStoreRegistrySnapshotV1(registry, fixture.context.stores.map((store) => store.definition), catalogContext);
  const outcome = inspectOwnedStoreCatalogPreCreateV1(snapshot, parsedRegistry, fixture.context);
  expect(outcome).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: ["dottedTwo"] });
  expect(Object.isFrozen(outcome)).toBe(true);
  if (outcome.kind === "ready") expect(Object.isFrozen(outcome.emptyMissingIdentityStoreKeys)).toBe(true);
});

test("durable fresh post-create rejects rootless or partial B before complete A plus B passes", () => {
  const rootless = mixedDottedPreCreate().fixture;
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(rootless.input, catalogContext), rootless.context)).toThrow("ORM_OWNED_STORE_DRIFT");
  const partial = b2DottedTwoStores();
  partial.input.columns = partial.input.columns.filter((entry) => entry.relationOid !== "110");
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(partial.input, catalogContext), partial.context)).toThrow("ORM_OWNED_STORE_DRIFT");
  const complete = b2DottedTwoStores();
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(complete.input, catalogContext), complete.context)).not.toThrow();
});

test("durable actual captured B inbound wins before Registry and model drift", () => {
  const fixture = b2DottedTwoStores(), registry = b2FixedRegistry();
  const first = fixture.context.stores[0]!.definition;
  registry.state.rows = [{ ...rowFor(first.storeKey, first.ownedScope.tablePrefix), ownedSchema: first.ownedScope.schema, ownedScopeHash: canonicalOwnedStoreScopeHashV1(first) }];
  fixture.input.constraints.push({ ...fixture.input.constraints[0]!, oid: "590", relationOid: "591", referencedRelationOid: "110", name: "inbound_b", kind: "foreignKey", columns: ["id"], referencedColumns: ["id"], backingIndexOid: "112" });
  const snapshot = parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext);
  const parsedRegistry = parseOwnedStoreRegistrySnapshotV1(registry, fixture.context.stores.map((store) => store.definition), catalogContext);
  preCreateError(() => inspectOwnedStoreCatalogPreCreateV1(snapshot, parsedRegistry, fixture.context), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
});

test("durable rootless unknown target remains drift, not invented B ownership", () => {
  const { fixture, registry } = mixedDottedPreCreate();
  fixture.input.constraints.push({ ...fixture.input.constraints[0]!, oid: "590", relationOid: "591", referencedRelationOid: "110", name: "unknown_b", kind: "foreignKey", columns: ["id"], referencedColumns: ["id"], backingIndexOid: "12" });
  const snapshot = parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext);
  const parsedRegistry = parseOwnedStoreRegistrySnapshotV1(registry, fixture.context.stores.map((store) => store.definition), catalogContext);
  preCreateError(() => inspectOwnedStoreCatalogPreCreateV1(snapshot, parsedRegistry, fixture.context), "ORM_OWNED_STORE_DRIFT");
});

test("durable ready and occupied results are frozen independent values", () => {
  const readyInput = b2Snapshot(), ready = inspectB2PreCreate(b2FixedRegistry(), readyInput);
  expect(Object.isFrozen(ready)).toBe(true);
  if (ready.kind === "ready") { expect(Object.isFrozen(ready.emptyMissingIdentityStoreKeys)).toBe(true); readyInput.relations[0]!.name = "changed"; expect(ready.emptyMissingIdentityStoreKeys).toEqual([]); }
  const occupiedInput = b2Snapshot(), occupiedRegistry = b2FixedRegistry(); occupiedRegistry.state.rows = [];
  const occupied = inspectB2PreCreate(occupiedRegistry, occupiedInput);
  expect(Object.isFrozen(occupied)).toBe(true);
  if (occupied.kind === "occupiedMissingIdentity") { expect(Object.isFrozen(occupied.storeKeys)).toBe(true); occupiedInput.relations[0]!.name = "changed"; expect(occupied.storeKeys).toEqual(["b2"]); }
});

test("durable rootless-ready classification cannot hide unrelated class or dependency residue", () => {
  const cases: readonly [(fixture: ReturnType<typeof mixedDottedPreCreate>["fixture"]) => void, string][] = [
    [(fixture) => { fixture.input.catalogClasses.push({ oid: "590", schema: "other", name: "unrelated_class", kind: "other" }); }, "class"],
    [(fixture) => { fixture.input.dependencies.push({ dependentClassOid: "1", dependentOid: "590", dependentSubId: "0", referencedClassOid: "1", referencedOid: "591", referencedSubId: "0", kind: "normal" }); }, "dependency"],
  ];
  for (const [mutate, label] of cases) {
    const { fixture, registry } = mixedDottedPreCreate(); mutate(fixture);
    const snapshot = parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext);
    const parsedRegistry = parseOwnedStoreRegistrySnapshotV1(registry, fixture.context.stores.map((store) => store.definition), catalogContext);
    preCreateError(() => inspectOwnedStoreCatalogPreCreateV1(snapshot, parsedRegistry, fixture.context), "ORM_OWNED_STORE_DRIFT");
    expect(label).toBeTruthy();
  }
});
test("binds PK backing index name and ordered physical keys", () => { const input=b2Snapshot(); input.indexes[0]!.name="other"; input.relations[1]!.name="other"; drift(()=>verifyB21(input)); });
test("rejects duplicate raw row and array owners before semantic maps", () => { const rows=b2Snapshot(); rows.rowTypes.unshift({ ...rows.rowTypes[0]!, oid:"18" }); drift(()=>verifyB21(rows)); const arrays=b2Snapshot(); arrays.arrayTypes.unshift({ ...arrays.arrayTypes[0]!, oid:"19" }); drift(()=>verifyB21(arrays)); });
test("binds CHECK raw refs and forbids FK-only referenced columns", () => { const input=b2Snapshot(); input.constraints[1]!.columns=[]; drift(()=>verifyB21(input)); const foreign=b2Snapshot(); foreign.constraints[1]!.referencedColumns=["id"]; drift(()=>verifyB21(foreign)); });
test("accepts captured default collation and rejects its isolated drift", () => { const input=b2Snapshot(); const textDefault:CanonicalDefault={kind:"string",value:"one"}; const textCheck:CheckAst={kind:"compare",op:">=",left:"id",right:"a"}; input.columns[0]!.physicalType="text"; input.columns[0]!.typeOid="25"; input.columns[0]!.default=textDefault; input.columns[0]!.storageCode="x"; input.columns[0]!.typeDefaultStorageCode="x"; input.columns[0]!.collationOid="100"; input.columns[0]!.typeDefaultCollationOid="100"; input.constraints[1]!.checkExpression=textCheck; input.indexes.forEach(i=>i.collationOids=["100"]); const expected: OrmExpectedSchema={tables:[{...b2Expected.tables[0]!,columns:[{...b2Expected.tables[0]!.columns[0]!,physicalType:"text",default:textDefault}],checks:[{name:"ck_items_id",expression:textCheck}]}]}; expect(()=>verifyB21(input,expected)).not.toThrow(); input.indexes[1]!.collationOids=["0"]; drift(()=>verifyB21(input,expected)); });
test("fails closed for dangling TOAST and identity without sequence", () => { const toast=b2Snapshot(); toast.relations[0]!.toastRelationOid="99"; drift(()=>verifyB21(toast)); const identity=b2Snapshot(); identity.columns[0]!.generation="identityByDefault"; identity.columns[0]!.identityCode="d"; const expected: OrmExpectedSchema={tables:[{...b2Expected.tables[0]!,columns:[{...b2Expected.tables[0]!.columns[0]!,generation:"identityByDefault"}]}]}; drift(()=>verifyB21(identity,expected)); });
test("scopes OID 2200 namespace handling without scalar blanket rejection", () => { const input=b2Snapshot(); input.columns[0]!.typeOid="2200"; expect(()=>verifyB21(input)).not.toThrow(); });
test("requires numeric default attrdef AUTO and rejects wrong default owner", () => { expect(()=>verifyB21(b2Snapshot())).not.toThrow(); const input=b2Snapshot(); input.dependencies[3]!.referencedOid="99"; drift(()=>verifyB21(input)); });
test("rejects duplicate symbolic catalog classes before map collapse", () => { const input=b2Snapshot(); input.catalogClasses.unshift({ ...input.catalogClasses[0]!, oid:"99" }); drift(()=>verifyB21(input)); });
test("rejects unused unsupported catalog class facts", () => { const input=b2Snapshot(); input.catalogClasses.push({ oid:"99", schema:"other", name:"other", kind:"other" }); drift(()=>verifyB21(input)); });
test("collection order is not physical column order", () => { const input=b2Snapshot(); input.columns=[...input.columns].reverse(); expect(()=>verifyB21(input)).not.toThrow(); });
test("physical attnum order remains bound to expected order", () => { const input=b2Snapshot(); input.columns[0]!.attnum="2"; drift(()=>verifyB21(input)); });
function b2TwoColumns() { const input=b2Snapshot(); input.columns.push({ ...input.columns[0]!, attnum:"2", name:"other", default:{kind:"none"}, defaultObjectOid:null }); input.dependencies.push({dependentClassOid:"3",dependentOid:"16",dependentSubId:"0",referencedClassOid:"1",referencedOid:"10",referencedSubId:"2",kind:"automatic"}); input.indexes[0]!.keyAttributeCount="2"; input.indexes[0]!.totalAttributeCount="2"; input.indexes[0]!.attributeNumbers=["1","2"]; input.indexes[0]!.columnNames=["id","other"]; input.indexes[0]!.collationOids=["0","0"]; input.indexes[0]!.opclassOids=["99","99"]; input.indexes[0]!.defaultOpclassOids=["99","99"]; input.indexes[0]!.options=["0","0"]; input.constraints[0]!.columns=["id","other"]; const expected=mutableB2Expected(), table=expected.tables[0]!; table.columns.push({property:"other",column:"other",physicalType:"integer",nullable:false,default:{kind:"none"},generation:"none"}); table.primaryKey={name:"pk_items",columns:["id","other"]}; return {input,expected}; }
test("two-column raw collection shuffle is not physical order",()=>{const {input,expected}=b2TwoColumns();input.columns.reverse();expect(()=>verifyB21(input,expected)).not.toThrow();});
test("coherent two-column attnum swap rejects",()=>{const {input,expected}=b2TwoColumns();expect(()=>verifyB21(input,expected)).not.toThrow();expect(()=>parseOwnedStoreCatalogSnapshotV1(input,catalogContext)).not.toThrow();input.columns[0]!.attnum="2";input.columns[1]!.attnum="1";for(const index of input.indexes){index.attributeNumbers=index.columnNames.map(name=>name==="id"?"2":"1");}for(const edge of input.dependencies)if(edge.referencedClassOid==="1"&&edge.referencedOid==="10"&&(edge.referencedSubId==="1"||edge.referencedSubId==="2"))edge.referencedSubId=edge.referencedSubId==="1"?"2":"1";expect(()=>parseOwnedStoreCatalogSnapshotV1(input,catalogContext)).not.toThrow();drift(()=>verifyB21(input,expected));});
test("PK ordered backing keys reject reversal",()=>{const {input,expected}=b2TwoColumns();input.indexes[0]!.attributeNumbers=["2","1"];input.indexes[0]!.columnNames=["other","id"];drift(()=>verifyB21(input,expected));});
test("pg_attrdef identity is unique across two defaulted column owners",()=>{const {input,expected}=b2TwoColumns();const secondDefault:CanonicalDefault={kind:"number",value:1};input.columns[1]!.default=secondDefault;input.columns[1]!.defaultObjectOid="18";expected.tables[0]!.columns[1]!.default=secondDefault;input.dependencies.push({dependentClassOid:"4",dependentOid:"18",dependentSubId:"0",referencedClassOid:"1",referencedOid:"10",referencedSubId:"2",kind:"automatic"});expect(()=>parseOwnedStoreCatalogSnapshotV1(input,catalogContext)).not.toThrow();expect(()=>verifyB21(input,expected)).not.toThrow();input.columns[1]!.defaultObjectOid="14";input.dependencies[input.dependencies.length-1]!.dependentOid="14";expect(()=>parseOwnedStoreCatalogSnapshotV1(input,catalogContext)).not.toThrow();drift(()=>verifyB21(input,expected));});

function b2DottedTwoStores() {
  const configure = (input: ReturnType<typeof b2Snapshot>, schema: string, table: string, namespaceOid: string, remap: ReadonlyMap<string, string>): void => {
    const oid = (value: string): string => remap.get(value) ?? value;
    const nullableOid = (value: string | null): string | null => value === null ? null : oid(value);
    input.relations = input.relations.map((relation) => ({ ...relation, oid: oid(relation.oid), namespaceOid, schema, name: relation.kind === "ordinaryTable" ? table : relation.name, rowTypeOid: nullableOid(relation.rowTypeOid), toastRelationOid: nullableOid(relation.toastRelationOid) }));
    input.rowTypes = input.rowTypes.map((rowType) => ({ ...rowType, oid: oid(rowType.oid), relationOid: oid(rowType.relationOid), schema, name: table, arrayTypeOid: oid(rowType.arrayTypeOid) }));
    input.arrayTypes = input.arrayTypes.map((arrayType) => ({ ...arrayType, oid: oid(arrayType.oid), elementTypeOid: oid(arrayType.elementTypeOid), relationOid: arrayType.relationOid, arrayTypeOid: arrayType.arrayTypeOid, schema }));
    input.columns = input.columns.map((column) => ({ ...column, relationOid: oid(column.relationOid), defaultObjectOid: nullableOid(column.defaultObjectOid) }));
    input.indexes = input.indexes.map((index) => ({ ...index, indexRelationOid: oid(index.indexRelationOid), tableRelationOid: oid(index.tableRelationOid), backingConstraintOid: nullableOid(index.backingConstraintOid) }));
    input.constraints = input.constraints.map((constraint) => ({ ...constraint, oid: oid(constraint.oid), relationOid: oid(constraint.relationOid), referencedRelationOid: nullableOid(constraint.referencedRelationOid), backingIndexOid: nullableOid(constraint.backingIndexOid) }));
    input.dependencies = input.dependencies.map((dependency) => ({ ...dependency, dependentOid: oid(dependency.dependentOid), referencedOid: dependency.referencedClassOid === "5" ? namespaceOid : oid(dependency.referencedOid) }));
  };
  const first = b2Snapshot(), second = b2Snapshot();
  configure(first, "tenant", "nested.bazis_items", "12000", new Map());
  configure(second, "tenant.nested", "bazis_items", "12001", new Map([["10", "110"], ["11", "111"], ["12", "112"], ["13", "113"], ["14", "114"], ["15", "115"], ["16", "116"], ["17", "117"]]));
  const scopes = [{ schema: "tenant", tablePrefix: "nested.bazis_" }, { schema: "tenant.nested", tablePrefix: "bazis_" }];
  const firstDefinition = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "dottedOne", formatVersion: 1, ownedScope: scopes[0]! });
  const secondDefinition = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "dottedTwo", formatVersion: 1, ownedScope: scopes[1]! });
  const expected = (schema: string, table: string): OrmExpectedSchema => ({ tables: [{ ...b2Expected.tables[0]!, schema, table }] });
  return {
    input: {
      ...first,
      requestedScopes: scopes,
      existingSchemas: ["tenant", "tenant.nested"],
      catalogClasses: first.catalogClasses,
      relations: [...first.relations, ...second.relations],
      rowTypes: [...first.rowTypes, ...second.rowTypes],
      arrayTypes: [...first.arrayTypes, ...second.arrayTypes],
      columns: [...first.columns, ...second.columns],
      indexes: [...first.indexes, ...second.indexes],
      constraints: [...first.constraints, ...second.constraints],
      triggers: [...first.triggers, ...second.triggers],
      rules: [...first.rules, ...second.rules],
      policies: [...first.policies, ...second.policies],
      inheritance: [...first.inheritance, ...second.inheritance],
      dependencies: [...first.dependencies, ...second.dependencies],
      sequences: [...first.sequences, ...second.sequences],
    },
    context: { stores: [{ definition: firstDefinition, expectedSchema: expected("tenant", "nested.bazis_items") }, { definition: secondDefinition, expectedSchema: expected("tenant.nested", "bazis_items") }], requestedScopes: scopes },
  };
}

test("keeps distinct dotted schema/table pairs in two-store global lookups", () => {
  const positive = b2DottedTwoStores();
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(positive.input, catalogContext), positive.context)).not.toThrow();
  const mismatch = b2DottedTwoStores();
  mismatch.input.columns.find((column) => column.relationOid === "10")!.notNull = false;
  expect(() => parseOwnedStoreCatalogSnapshotV1(mismatch.input, catalogContext)).not.toThrow();
  drift(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(mismatch.input, catalogContext), mismatch.context));
});

test("keeps a global bijection between captured schemas and namespace OIDs", () => {
  const positive = b2DottedTwoStores();
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(positive.input, catalogContext), positive.context)).not.toThrow();
  const sameSchema = b2DottedTwoStores();
  sameSchema.input.relations.find((relation) => relation.oid === "12")!.namespaceOid = "15000";
  expect(() => parseOwnedStoreCatalogSnapshotV1(sameSchema.input, catalogContext)).not.toThrow();
  drift(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(sameSchema.input, catalogContext), sameSchema.context));
  const sameNamespace = b2DottedTwoStores();
  sameNamespace.input.relations.find((relation) => relation.oid === "112")!.schema = "other";
  expect(() => parseOwnedStoreCatalogSnapshotV1(sameNamespace.input, catalogContext)).not.toThrow();
  drift(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(sameNamespace.input, catalogContext), sameNamespace.context));
});

function b2SameStoreForeignKey() {
  const input = b2DottedTwoStores().input;
  const names = new Map<string, string>([["10", "bazis_a_items"], ["110", "bazis_b_items"]]);
  const indexNames = new Map<string, string>([["12", "pk_a_items"], ["13", "ix_a_items_id"], ["112", "pk_b_items"], ["113", "ix_b_items_id"]]);
  const primaryNames = new Map<string, string>([["16", "pk_a_items"], ["116", "pk_b_items"]]);
  input.requestedScopes = [{ schema: "public", tablePrefix: "bazis_" }];
  input.existingSchemas = ["public"];
  for (const relation of input.relations) {
    relation.schema = "public";
    relation.namespaceOid = "12000";
    if (relation.kind === "ordinaryTable")
      relation.name = names.get(relation.oid)!;
    else
      relation.name = indexNames.get(relation.oid)!;
  }
  for (const rowType of input.rowTypes) {
    rowType.schema = "public";
    rowType.name = names.get(rowType.relationOid)!;
  }
  const rowTypeNames = new Map(input.rowTypes.map((rowType) => [rowType.oid, rowType.name]));
  for (const arrayType of input.arrayTypes) {
    arrayType.schema = "public";
    arrayType.name = `_${rowTypeNames.get(arrayType.elementTypeOid)!}`;
  }
  for (const index of input.indexes)
    index.name = indexNames.get(index.indexRelationOid)!;
  for (const constraint of input.constraints)
    if (constraint.kind === "primaryKey")
      constraint.name = primaryNames.get(constraint.oid)!;
  for (const dependency of input.dependencies)
    if (dependency.referencedClassOid === "5")
      dependency.referencedOid = "12000";
  input.catalogClasses.push({ oid: "6", schema: "pg_catalog", name: "pg_proc", kind: "pg_proc" }, { oid: "7", schema: "pg_catalog", name: "pg_trigger", kind: "pg_trigger" });
  input.constraints.push({ ...input.constraints[0]!, oid: "118", relationOid: "10", referencedRelationOid: "110", name: "fk_a_b", kind: "foreignKey", columns: ["id"], referencedColumns: ["id"], backingIndexOid: "112", onDelete: "cascade", onUpdate: "noAction", match: "simple", noInherit: true, checkExpression: null, primaryForeignEqualityOperatorOids: ["99"], primaryPrimaryEqualityOperatorOids: ["99"], foreignForeignEqualityOperatorOids: ["99"], defaultEqualityOperatorOids: ["99"] });
  const triggers = [
    { oid: "121", relationOid: "10", functionOid: "1644", functionName: "RI_FKey_check_ins", typeBits: "5" },
    { oid: "122", relationOid: "10", functionOid: "1645", functionName: "RI_FKey_check_upd", typeBits: "17" },
    { oid: "123", relationOid: "110", functionOid: "1646", functionName: "RI_FKey_cascade_del", typeBits: "9" },
    { oid: "124", relationOid: "110", functionOid: "1655", functionName: "RI_FKey_noaction_upd", typeBits: "17" },
  ].map((trigger, index): MutableCatalogSnapshot["triggers"][number] => ({ ...trigger, name: `ri_${index}`, internal: true, constraintOid: "118", parentTriggerOid: null, enabled: "origin", functionSchema: "pg_catalog" }));
  input.triggers = triggers;
  input.dependencies.push(
    { dependentClassOid: "3", dependentOid: "118", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" },
    { dependentClassOid: "3", dependentOid: "118", dependentSubId: "0", referencedClassOid: "1", referencedOid: "110", referencedSubId: "1", kind: "normal" },
    { dependentClassOid: "3", dependentOid: "118", dependentSubId: "0", referencedClassOid: "1", referencedOid: "112", referencedSubId: "0", kind: "normal" },
    ...triggers.map((trigger): MutableCatalogSnapshot["dependencies"][number] => ({ dependentClassOid: "7", dependentOid: trigger.oid, dependentSubId: "0", referencedClassOid: "3", referencedOid: "118", referencedSubId: "0", kind: "internal" })),
  );
  const definition = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "b2Foreign", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "bazis_" } });
  const expected: OrmExpectedSchema = { tables: [
    { ...b2Expected.tables[0]!, table: "bazis_a_items", primaryKey: { name: "pk_a_items", columns: ["id"] }, indexes: [{ name: "ix_a_items_id", columns: ["id"], unique: false, method: "btree" }], foreignKeys: [{ name: "fk_a_b", columns: ["id"], target: { schema: "public", table: "bazis_b_items" }, targetColumns: ["id"], onDelete: "cascade", onUpdate: "noAction" }] },
    { ...b2Expected.tables[0]!, table: "bazis_b_items", primaryKey: { name: "pk_b_items", columns: ["id"] }, indexes: [{ name: "ix_b_items_id", columns: ["id"], unique: false, method: "btree" }] },
  ] };
  return { input, context: { stores: [{ definition, expectedSchema: expected }], requestedScopes: [{ schema: "public", tablePrefix: "bazis_" }] } };
}

const verifyB2ForeignKey = (fixture: ReturnType<typeof b2SameStoreForeignKey>): void => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext), fixture.context);
const foreignKeyDrift = (fixture: ReturnType<typeof b2SameStoreForeignKey>): void => {
  expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
  drift(() => verifyB2ForeignKey(fixture));
};

test("same-store FK has exact default vectors and four RI trigger roles", () => {
  const fixture = b2SameStoreForeignKey();
  expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
  expect(() => verifyB2ForeignKey(fixture)).not.toThrow();
});

for (const vector of ["primaryForeignEqualityOperatorOids", "primaryPrimaryEqualityOperatorOids", "foreignForeignEqualityOperatorOids", "defaultEqualityOperatorOids"] as const)
  test(`B2 FK rejects mismatched ${vector}`, () => {
    const fixture = b2SameStoreForeignKey();
    fixture.input.constraints.find((constraint) => constraint.oid === "118")![vector] = ["96"];
    foreignKeyDrift(fixture);
  });

test("FK rejects a nonpinned default operator", () => {
  const fixture = b2SameStoreForeignKey(), constraint = fixture.input.constraints.find((entry) => entry.oid === "118")!;
  constraint.primaryForeignEqualityOperatorOids = ["12000"];
  constraint.primaryPrimaryEqualityOperatorOids = ["12000"];
  constraint.foreignForeignEqualityOperatorOids = ["12000"];
  constraint.defaultEqualityOperatorOids = ["12000"];
  foreignKeyDrift(fixture);
});

for (const count of [0, 1, 3, 5])
  test(`B2 FK rejects ${count} RI triggers`, () => {
    const fixture = b2SameStoreForeignKey();
    fixture.input.triggers = count === 5 ? [...fixture.input.triggers, { ...fixture.input.triggers[0]!, oid: "125" }] : fixture.input.triggers.slice(0, count);
    foreignKeyDrift(fixture);
  });

for (const mutate of [
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.relationOid = "110"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.functionSchema = "public"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.functionName = "RI_FKey_check_upd"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.functionOid = "12000"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.typeBits = "17"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.constraintOid = "16"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.internal = false; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.parentTriggerOid = "125"; },
  (fixture: ReturnType<typeof b2SameStoreForeignKey>) => { fixture.input.triggers[0]!.enabled = "always"; },
])
  test("FK rejects an RI trigger role or context mutation", () => {
    const fixture = b2SameStoreForeignKey();
    mutate(fixture);
    foreignKeyDrift(fixture);
  });

test("FK requires trigger INTERNAL and rejects a presented pinned PROC edge", () => {
  const missing = b2SameStoreForeignKey();
  missing.input.dependencies = missing.input.dependencies.filter((dependency) => !(dependency.dependentClassOid === "7" && dependency.dependentOid === "121"));
  foreignKeyDrift(missing);
  const presented = b2SameStoreForeignKey();
  presented.input.dependencies.push({ dependentClassOid: "7", dependentOid: "121", dependentSubId: "0", referencedClassOid: "6", referencedOid: "1644", referencedSubId: "0", kind: "normal" });
  foreignKeyDrift(presented);
});

function b2Identity(namespaceOid = "12000") {
  const base = b2Snapshot();
  const sequenceRelation: MutableCatalogSnapshot["relations"][number] = { ...base.relations[0]!, oid: "18", namespaceOid, name: "actual_identity_sequence_name", kind: "sequence", rawKind: "S", replicaIdentity: "nothing", accessMethod: null, rowTypeOid: null, toastRelationOid: null };
  const input: MutableCatalogSnapshot = {
    ...base,
    relations: [...base.relations.map((relation) => ({ ...relation, namespaceOid })), sequenceRelation],
    columns: base.columns.map((column) => ({ ...column, default: { kind: "none" } as CanonicalDefault, defaultObjectOid: null as string | null, generation: "identityByDefault" as const, identityCode: "d" as const })),
    dependencies: base.dependencies.filter((dependency) => !(dependency.dependentClassOid === "4" && dependency.dependentOid === "14") && !(dependency.dependentClassOid === "1" && dependency.dependentOid === "10" && dependency.referencedClassOid === "5")),
    sequences: [{ relationOid: "18", type: "bigint" as const, start: "1", increment: "1", minimum: "1", maximum: "9223372036854775807", cache: "1", cycle: false }],
  };
  if (namespaceOid === "2200" || BigInt(namespaceOid) >= 12000n)
    input.dependencies.push({ dependentClassOid: "1", dependentOid: "10", dependentSubId: "0", referencedClassOid: "5", referencedOid: namespaceOid, referencedSubId: "0", kind: "normal" }, { dependentClassOid: "1", dependentOid: "18", dependentSubId: "0", referencedClassOid: "5", referencedOid: namespaceOid, referencedSubId: "0", kind: "normal" });
  input.dependencies.push({ dependentClassOid: "1", dependentOid: "18", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "internal" });
  const expected = mutableB2Expected();
  expected.tables[0]!.columns[0]!.default = { kind: "none" };
  expected.tables[0]!.columns[0]!.generation = "identityByDefault";
  return { input, expected };
}

const verifyB2Identity = (fixture: ReturnType<typeof b2Identity>): void => verifyB21(fixture.input, fixture.expected);
const identityDrift = (fixture: ReturnType<typeof b2Identity>): void => {
  expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
  drift(() => verifyB2Identity(fixture));
};

test("identity binds an actual sequence name, bigint tuple, and owner", () => {
  const fixture = b2Identity();
  expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
  expect(() => verifyB2Identity(fixture)).not.toThrow();
});

for (const [type, maximum] of [["smallint", "32767"], ["integer", "2147483647"]] as const)
  test(`B2 identity rejects exact ${type} sequence tuple`, () => {
    const fixture = b2Identity();
    fixture.input.sequences[0]!.type = type;
    fixture.input.sequences[0]!.maximum = maximum;
    identityDrift(fixture);
  });

for (const [type, maximum] of [["bigint", "9223372036854775807"], ["smallint", "32767"], ["integer", "2147483647"]] as const)
  for (const field of ["start", "increment", "minimum", "maximum", "cache", "cycle"] as const)
    test(`B2 identity rejects ${type} sequence ${field} mutation`, () => {
      const fixture = b2Identity(), sequence = fixture.input.sequences[0]!;
      sequence.type = type;
      sequence.maximum = maximum;
      if (field === "cycle") sequence.cycle = true;
      else sequence[field] = "2";
      identityDrift(fixture);
    });

for (const mutate of [
  (fixture: ReturnType<typeof b2Identity>) => { fixture.input.dependencies.at(-1)!.dependentClassOid = "2"; },
  (fixture: ReturnType<typeof b2Identity>) => { fixture.input.dependencies.at(-1)!.referencedOid = "99"; },
  (fixture: ReturnType<typeof b2Identity>) => { fixture.input.dependencies.at(-1)!.referencedSubId = "2"; },
  (fixture: ReturnType<typeof b2Identity>) => { fixture.input.dependencies.at(-1)!.kind = "automatic"; },
])
  test("identity rejects owner class, table, attnum, or kind mutation", () => {
    const fixture = b2Identity();
    mutate(fixture);
    identityDrift(fixture);
  });

test("identity rejects missing or second sequence ownership", () => {
  const missing = b2Identity();
  missing.input.dependencies = missing.input.dependencies.filter((dependency) => !(dependency.dependentClassOid === "1" && dependency.dependentOid === "18" && dependency.referencedClassOid === "1" && dependency.referencedOid === "10"));
  identityDrift(missing);
  const second = b2Identity();
  second.input.dependencies.push({ dependentClassOid: "1", dependentOid: "18", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "2", kind: "internal" });
  identityDrift(second);
});

test("identity rejects nonidentity owners and unsupported physical markers", () => {
  const nonidentity = b2Identity();
  nonidentity.input.columns[0]!.generation = "none";
  nonidentity.input.columns[0]!.identityCode = "";
  nonidentity.expected.tables[0]!.columns[0]!.generation = "none";
  identityDrift(nonidentity);
  for (const physicalType of ["integer:smallint", "integer:integer"]) {
    const unsupported = b2Identity();
    unsupported.input.columns[0]!.physicalType = physicalType;
    identityDrift(unsupported);
  }
});

test("identity applies namespace expected-zero and expected-one rules", () => {
  for (const namespaceOid of ["11999", "2200", "12000"]) {
    const fixture = b2Identity(namespaceOid);
    expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
    expect(() => verifyB2Identity(fixture)).not.toThrow();
  }
});

test("identity rejects sequence relation, row, and TOAST facts", () => {
  const relation = b2Identity();
  relation.input.relations.find((entry) => entry.oid === "18")!.rawKind = "r";
  identityDrift(relation);
  const row = b2Identity();
  row.input.rowTypes.push({ ...row.input.rowTypes[0]!, oid: "19", relationOid: "18", name: "actual_identity_sequence_name" });
  identityDrift(row);
  const toast = b2Identity();
  toast.input.relations.find((entry) => entry.oid === "18")!.toastRelationOid = "19";
  identityDrift(toast);
});

function b2Toast(namespaceOid = "11999") {
  const base = b2Snapshot();
  const toastRelation: MutableCatalogSnapshot["relations"][number] = { ...base.relations[0]!, oid: "30", namespaceOid, schema: "pg_toast", name: "actual_toast_relation", kind: "toastTable", rawKind: "t", replicaIdentity: "nothing", rowTypeOid: null, toastRelationOid: null };
  const toastIndexRelation: MutableCatalogSnapshot["relations"][number] = { ...base.relations[1]!, oid: "31", namespaceOid, schema: "pg_toast", name: "actual_toast_index", kind: "index", rawKind: "i", replicaIdentity: "nothing", rowTypeOid: null, toastRelationOid: null };
  const toastColumns = [["chunk_id", "oid", "26"], ["chunk_seq", "integer", "23"], ["chunk_data", "bytea", "17"]] as const;
  const input: MutableCatalogSnapshot = {
    ...base,
    relations: [...base.relations.map((relation, index) => ({ ...relation, namespaceOid: "2200", toastRelationOid: index === 0 ? "30" : null })), toastRelation, toastIndexRelation],
    columns: [...base.columns, ...toastColumns.map(([name, physicalType, typeOid], index) => ({ ...base.columns[0]!, relationOid: "30", attnum: String(index + 1), name, physicalType, typeOid, notNull: false, default: { kind: "none" } as CanonicalDefault, defaultObjectOid: null as string | null, generation: "none" as const, identityCode: "" as const, generatedCode: "" as const, storageCode: "p", compressionCode: "" as const }))],
    indexes: [...base.indexes, { ...base.indexes[0]!, indexRelationOid: "31", tableRelationOid: "30", name: "actual_toast_index", method: "btree", unique: true, primary: true, keyAttributeCount: "2", totalAttributeCount: "2", attributeNumbers: ["1", "2"], columnNames: ["chunk_id", "chunk_seq"], collationOids: ["0", "0"], opclassOids: ["99", "99"], defaultOpclassOids: ["99", "99"], options: ["0", "0"], expression: null, predicate: null, backingConstraintOid: null }],
    dependencies: base.dependencies.map((dependency) => dependency.dependentClassOid === "1" && dependency.dependentOid === "10" && dependency.referencedClassOid === "5" ? { ...dependency, referencedOid: "2200" } : dependency),
  };
  input.dependencies.push({ dependentClassOid: "1", dependentOid: "30", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "0", kind: "internal" }, { dependentClassOid: "1", dependentOid: "31", dependentSubId: "0", referencedClassOid: "1", referencedOid: "30", referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "1", dependentOid: "31", dependentSubId: "0", referencedClassOid: "1", referencedOid: "30", referencedSubId: "2", kind: "automatic" });
  return { input };
}

const verifyB2Toast = (fixture: ReturnType<typeof b2Toast>): void => verifyB21(fixture.input);
const toastDrift = (fixture: ReturnType<typeof b2Toast>): void => {
  expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
  drift(() => verifyB2Toast(fixture));
};

test("TOAST accepts special closure at both namespaces and arbitrary raw order", () => {
  for (const namespaceOid of ["11999", "12000"]) {
    const fixture = b2Toast(namespaceOid);
    expect(() => parseOwnedStoreCatalogSnapshotV1(fixture.input, catalogContext)).not.toThrow();
    expect(() => verifyB2Toast(fixture)).not.toThrow();
  }
  const shuffled = b2Toast();
  shuffled.input.relations.reverse();
  shuffled.input.columns.reverse();
  shuffled.input.indexes.reverse();
  expect(() => verifyB2Toast(shuffled)).not.toThrow();
});

for (const mutate of [
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "30")!.rawKind = "r"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "30")!.kind = "other"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "30")!.schema = "public"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "30")!.toastRelationOid = "32"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "10")!.toastRelationOid = "99"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.dependencies.at(-3)!.referencedOid = "99"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.rowTypes.push({ ...fixture.input.rowTypes[0]!, oid: "32", relationOid: "30", schema: "pg_toast", name: "actual_toast_relation", arrayTypeOid: "33" }); },
])
  test("TOAST rejects relation, nested, or owner drift", () => {
    const fixture = b2Toast();
    mutate(fixture);
    toastDrift(fixture);
  });

for (const mutate of [
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.name = "wrong"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.attnum = "4"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.physicalType = "text"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.typeOid = "12000"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.notNull = true; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.dropped = true; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.local = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.inheritanceCount = "1"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.default = { kind: "number", value: 1 }; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.generation = "identityByDefault"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.collationOid = "1"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.storageCode = "x"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.columns.find((column) => column.relationOid === "30")!.compressionCode = "p"; },
])
  test("TOAST rejects fixed column fact drift", () => {
    const fixture = b2Toast();
    mutate(fixture);
    toastDrift(fixture);
  });

for (const mutate of [
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.method = "hash"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.relations.find((relation) => relation.oid === "31")!.accessMethod = "hash"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.unique = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.primary = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.backingConstraintOid = "16"; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.attributeNumbers = ["2", "1"]; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.defaultOpclassOids = ["98", "99"]; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.opclassOids = ["98", "99"]; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.collationOids = ["1", "0"]; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.options = ["1", "0"]; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.immediate = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.valid = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.ready = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.live = false; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.exclusion = true; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.replicaIdentity = true; },
  (fixture: ReturnType<typeof b2Toast>) => { fixture.input.indexes.find((index) => index.indexRelationOid === "31")!.nullsNotDistinct = true; },
])
  test("TOAST rejects exact index or physical relation drift", () => {
    const fixture = b2Toast();
    mutate(fixture);
    toastDrift(fixture);
  });

test("TOAST requires three edges and rejects namespace or symbolic extras", () => {
  for (const index of [-3, -2, -1]) {
    const missing = b2Toast();
    missing.input.dependencies.splice(index, 1);
    toastDrift(missing);
  }
  const namespace = b2Toast();
  namespace.input.dependencies.push({ dependentClassOid: "1", dependentOid: "30", dependentSubId: "0", referencedClassOid: "5", referencedOid: "11999", referencedSubId: "0", kind: "normal" });
  toastDrift(namespace);
  const indexNamespace = b2Toast();
  indexNamespace.input.dependencies.push({ dependentClassOid: "1", dependentOid: "31", dependentSubId: "0", referencedClassOid: "5", referencedOid: "11999", referencedSubId: "0", kind: "normal" });
  toastDrift(indexNamespace);
  const extra = b2Toast();
  extra.input.dependencies.push({ dependentClassOid: "1", dependentOid: "31", dependentSubId: "0", referencedClassOid: "1", referencedOid: "30", referencedSubId: "0", kind: "automatic" });
  toastDrift(extra);
});

for (const attach of [
  (fixture: ReturnType<typeof b2Toast>) => fixture.input.constraints.push({ ...fixture.input.constraints[0]!, oid: "32", relationOid: "30", name: "toast_constraint" }),
  (fixture: ReturnType<typeof b2Toast>) => fixture.input.rules.push({ ...rule(), oid: "33", relationOid: "30" }),
  (fixture: ReturnType<typeof b2Toast>) => fixture.input.policies.push({ ...policy(), oid: "34", relationOid: "30" }),
  (fixture: ReturnType<typeof b2Toast>) => fixture.input.triggers.push({ ...trigger(), oid: "35", relationOid: "30", enabled: "origin" }),
  (fixture: ReturnType<typeof b2Toast>) => fixture.input.inheritance.push({ childRelationOid: "30", parentRelationOid: "10", sequence: "1" }),
])
  test("TOAST rejects forbidden attached facts", () => {
    const fixture = b2Toast();
    attach(fixture);
    toastDrift(fixture);
  });

const ownershipConflict = (work: () => void): void => {
  try {
    work();
    throw new Error("expected ownership conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
    expect((error as OrmOwnedStoreAdmissionError).code).toBe("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    expect((error as Error).message).toBe("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  }
};

const addOpaqueInboundForeignKey = (input: ReturnType<typeof b2Snapshot>): void => {
  input.constraints.push({
    ...input.constraints[0]!,
    oid: "29000",
    relationOid: "29001",
    referencedRelationOid: "10",
    name: "x".repeat(63),
    kind: "foreignKey",
    columns: ["x".repeat(63)],
    referencedColumns: ["id"],
    backingIndexOid: "12",
    checkExpression: null,
  });
};

test("inbound ownership conflicts precede independent verifier drift families", () => {
  const cases: readonly [
    string,
    (input: ReturnType<typeof b2Snapshot>) => OrmExpectedSchema | undefined,
  ][] = [
    ["duplicate row owner", (input) => {
      input.rowTypes.unshift({ ...input.rowTypes[0]!, oid: "18" });
      return undefined;
    }],
    ["duplicate array element", (input) => {
      input.arrayTypes.unshift({ ...input.arrayTypes[0]!, oid: "19" });
      return undefined;
    }],
    ["dangling TOAST", (input) => {
      input.relations[0]!.toastRelationOid = "99";
      return undefined;
    }],
    ["identity without sequence", (input) => {
      input.columns[0]!.generation = "identityByDefault";
      input.columns[0]!.identityCode = "d";
      return {
        tables: [{
          ...b2Expected.tables[0]!,
          columns: [{
            ...b2Expected.tables[0]!.columns[0]!,
            generation: "identityByDefault",
          }],
        }],
      };
    }],
    ["model nullability", (input) => {
      input.columns[0]!.notNull = false;
      return undefined;
    }],
  ];

  for (const [_name, mutate] of cases) {
    const withoutInbound = b2Snapshot();
    const expected = mutate(withoutInbound) ?? b2Expected;
    expect(() => parseOwnedStoreCatalogSnapshotV1(withoutInbound, catalogContext)).not.toThrow();
    drift(() => verifyB21(withoutInbound, expected));

    const withInbound = b2Snapshot();
    const inboundExpected = mutate(withInbound) ?? b2Expected;
    addOpaqueInboundForeignKey(withInbound);
    expect(() => parseOwnedStoreCatalogSnapshotV1(withInbound, catalogContext)).not.toThrow();
    ownershipConflict(() => verifyB21(withInbound, inboundExpected));
  }
});

test("raw pg_class names reject table, sequence, index, and catalogue collisions", () => {
  const tableSequence = b2Identity();
  tableSequence.input.relations.find((relation) => relation.oid === "18")!.name = "bazis_items";
  expect(() => parseOwnedStoreCatalogSnapshotV1(tableSequence.input, catalogContext)).not.toThrow();
  drift(() => verifyB2Identity(tableSequence));

  const tableIndex = b2Snapshot();
  tableIndex.relations[1]!.name = "bazis_items";
  expect(() => parseOwnedStoreCatalogSnapshotV1(tableIndex, catalogContext)).not.toThrow();
  drift(() => verifyB21(tableIndex));

  const catalogueRelation = b2Snapshot();
  catalogueRelation.relations[0]!.schema = "pg_catalog";
  catalogueRelation.relations[0]!.name = "pg_class";
  expect(() => parseOwnedStoreCatalogSnapshotV1(catalogueRelation, catalogContext)).not.toThrow();
  drift(() => verifyB21(catalogueRelation));
});

test("raw pg_type names reject array and row collisions", () => {
  const arrays = b2Snapshot();
  arrays.arrayTypes.push({ ...arrays.arrayTypes[0]!, oid: "19" });
  expect(() => parseOwnedStoreCatalogSnapshotV1(arrays, catalogContext)).not.toThrow();
  drift(() => verifyB21(arrays));

  const rowArray = b2Snapshot();
  rowArray.arrayTypes[0]!.name = rowArray.rowTypes[0]!.name;
  expect(() => parseOwnedStoreCatalogSnapshotV1(rowArray, catalogContext)).not.toThrow();
  drift(() => verifyB21(rowArray));
});

test("raw object names allow cross-catalogue and cross-schema identity reuse", () => {
  const crossCatalogue = b2Snapshot();
  expect(crossCatalogue.relations[0]!.name).toBe(crossCatalogue.rowTypes[0]!.name);
  expect(() => verifyB21(crossCatalogue)).not.toThrow();

  const crossSchema = b2DottedTwoStores();
  expect(crossSchema.input.arrayTypes[0]!.name).toBe(crossSchema.input.arrayTypes[1]!.name);
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(crossSchema.input, catalogContext), crossSchema.context)).not.toThrow();

  const duplicateCheckNames = b2SameStoreForeignKey();
  expect(duplicateCheckNames.input.constraints.filter((constraint) => constraint.kind === "check").map((constraint) => constraint.name)).toEqual(["ck_items_id", "ck_items_id"]);
  expect(() => verifyB2ForeignKey(duplicateCheckNames)).not.toThrow();
});

test("inbound ownership conflict precedes raw object-name drift", () => {
  const input = b2Snapshot();
  input.relations[1]!.name = "bazis_items";
  addOpaqueInboundForeignKey(input);
  expect(() => parseOwnedStoreCatalogSnapshotV1(input, catalogContext)).not.toThrow();
  ownershipConflict(() => verifyB21(input));
});
