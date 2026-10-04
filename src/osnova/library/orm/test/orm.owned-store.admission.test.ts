import { expect, test } from "bun:test";
import { defineOrmOwnedStoreV1, withRetry } from "@osnova/library/orm";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreModelPreimageV1, canonicalOwnedStoreScopeHashV1, canonicalOwnedStoreScopeLockPreimageV1, canonicalOwnedStoreStoreLockPreimageV1, ownedStoreAdvisoryLockV1 } from "../Schema/OwnedStoreCanonical";
import { admitOwnedStoresV1, discardOwnedStoreAdmissionV1, publishOwnedStoreAdmissionV1, type OwnedStoreAdmissionRequestV1 } from "../Schema/OwnedStoreAdmission";
import { failure, registerPostgresOwnedStoreCapability, type OwnedStoreCreateOperationV1, type OwnedStoreIdentityInsertV1, type OwnedStoreSecondaryLockPlanV1, type RegistryLockedOwnedStoreSessionV1, type SecondaryLockedOwnedStoreSessionV1 } from "../Providers/ormOwnedStoreRuntime";
import type { DatabaseProvider } from "../Providers/types";
import type { ExpectedColumn, ExpectedTable, OrmExpectedSchema } from "../Schema/ExpectedSchema";
import { OrmOwnedStoreAdmissionError } from "../errors";
import { inspectOwnedStoreCatalogPreCreateV1, parseOwnedCatalogColumnV1, parseOwnedCatalogConstraintV1, parseOwnedCatalogIndexV1, parseOwnedStoreCatalogSnapshotV1, parseOwnedStoreRegistrySnapshotV1, verifyOwnedStoreCatalogAllV1, type OwnedCatalogColumnV1, type OwnedCatalogConstraintV1, type OwnedCatalogIndexV1, type OwnedStoreCatalogSnapshotV1 } from "../Schema/OwnedStoreCatalog";

const definition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_" } });
const expected = Object.freeze({ tables: Object.freeze([{ schema: "public", table: "osnova_td_jobs", columns: Object.freeze([{ property: "id", column: "id", physicalType: "integer", nullable: false, default: Object.freeze({ kind: "none" as const }), generation: "none" as const }]), primaryKey: Object.freeze({ name: "pk_jobs", columns: Object.freeze(["id"]) }), indexes: Object.freeze([]), foreignKeys: Object.freeze([]), checks: Object.freeze([]) }]) });
const request = (): OwnedStoreAdmissionRequestV1 => Object.freeze({ stores: Object.freeze([Object.freeze({ definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` })]) });
let providerEffects = 0;
function unexpected(): never { providerEffects++; throw new Error("unexpected provider access"); }
const dialect: DatabaseProvider["dialect"] = Object.freeze({
  name: "test", supportsReturning: false, quoteId() { return unexpected(); }, qualifyTable() { return unexpected(); }, parameter() { return unexpected(); }, columnType() { return unexpected(); },
  encode() { return unexpected(); }, decode() { return unexpected(); }, rowLockClause() { return unexpected(); }, createTableSql() { return unexpected(); }, createIndexSql() { return unexpected(); }, createIndexSqlOne() { return unexpected(); }, addColumnSql() { return unexpected(); }, dropColumnSql() { return unexpected(); },
});
const provider: DatabaseProvider = Object.freeze({
  name: "postgres", dialect, limits: Object.freeze({ maxParametersPerCommand: 1 }),
  async query() { return unexpected(); }, async execute() { return unexpected(); },
  async transaction<T>(): Promise<T> { return unexpected(); }, async ping() { return unexpected(); },
  async introspect() { return unexpected(); }, async close() { return unexpected(); },
});
async function rejects(input: OwnedStoreAdmissionRequestV1, code: OrmOwnedStoreAdmissionError["code"] = "ORM_OWNED_STORE_IDENTITY_MISMATCH"): Promise<void> {
  let caught: unknown; try { await admitOwnedStoresV1(provider, input); } catch (error) { caught = error; }
  exact(caught, code);
}
function prepared(schema: OrmExpectedSchema): OwnedStoreAdmissionRequestV1 {
  return { stores: [{ definition, expected: schema, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, schema) as `sha256:${string}` }] };
}

test("prepared owned-store request rejects bad hashes before a provider capability can run", async () => {
  const bad = { ...request(), stores: [{ ...request().stores[0]!, modelHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as const }] };
  await rejects(bad);
});
test("prepared owned-store request fails closed for an unsupported provider", async () => {
  await preflights(expected);
});
test("prepared owned-store request rejects duplicate owned scope before provider work", async () => {
  const duplicate = Object.freeze({ ...request(), stores: Object.freeze([request().stores[0]!, request().stores[0]!]) });
  await rejects(duplicate, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
});

test("prepared expected defaults and checks are closed data, not caller-controlled descriptors", async () => {
  let accessed = 0;
  const value = request().stores[0]!;
  const hostileDefault = { kind: "none" };
  Object.defineProperty(hostileDefault, "value", { get() { accessed++; return "secret"; }, enumerable: true });
  const hostileExpected = { ...value, expected: { tables: [{ ...expected.tables[0]!, columns: [{ ...expected.tables[0]!.columns[0]!, default: hostileDefault }] }] } };
  await hostile({ stores: [hostileExpected] });
  expect(accessed).toBe(0);
});

test("prepared expected graph rejects a table outside its nominal owned scope", async () => {
  const value = request().stores[0]!;
  const escaped = { tables: [{ ...expected.tables[0]!, table: "foreign_records" }] };
  const input = { ...value, expected: escaped, modelHash: canonicalOwnedStoreModelHashV1(definition, escaped) as `sha256:${string}` };
  await rejects({ stores: [input] });
});

test("prepared request rejects non-native signals before capability resolution", async () => {
  let accessed = 0;
  const signal = { get aborted() { accessed++; return false; } };
  await hostile({ ...request(), signal });
  expect(accessed).toBe(0);
});

test("prepared Check AST retains supported literals while preflighting unsupported provider", async () => {
  const checked = { tables: [{ ...expected.tables[0]!, checks: [{ name: "ck_jobs_id", expression: {
    kind: "and" as const, left: { kind: "compare" as const, op: ">=" as const, left: "id", right: 0 },
    right: { kind: "not" as const, inner: { kind: "in" as const, left: "id", values: [1, 2] } },
  } }] }] };
  const input = { ...request().stores[0]!, expected: checked, modelHash: canonicalOwnedStoreModelHashV1(definition, checked) as `sha256:${string}` };
  await preflights(checked);
});

test("prepared arrays reject numeric-looking keys outside their dense index domain", async () => {
  for (const key of ["4294967295", "9007199254740992"]) {
    const stores = [...request().stores];
    Object.defineProperty(stores, key, { value: request().stores[0]!, enumerable: true });
    const input: OwnedStoreAdmissionRequestV1 = { stores };
    await rejects(input);
  }
});

test("prepared signal validation never traverses an arbitrary prototype", async () => {
  let hooks = 0;
  const prototype = new Proxy({}, { getPrototypeOf() { hooks++; throw new Error("prototype hook"); } });
  const signal = Object.create(prototype) as AbortSignal;
  const input: OwnedStoreAdmissionRequestV1 = { ...request(), signal };
  await rejects(input);
  expect(hooks).toBe(0);
});

test("projection admits canonical datetime offsets and typed CHECK before unsupported-provider preflight", async () => {
  const base = expected.tables[0]!;
  const schema: OrmExpectedSchema = { tables: [{ ...base, columns: [...base.columns, { property: "created", column: "created", physicalType: "datetime", nullable: false, default: { kind: "string" as const, value: "2026-09-10T10:20:30+03:00" }, generation: "none" as const }], checks: [{ name: "ck_jobs_id", expression: { kind: "compare" as const, op: ">=" as const, left: "id", right: 0 } }] }] };
  await preflights(schema);
});

test("projection rejects UUID default outside its exact generated singleton key representation", async () => {
  const base = expected.tables[0]!;
  const schema = { tables: [{ ...base, columns: [...base.columns, { property: "token", column: "token", physicalType: "text", nullable: false, default: { kind: "uuidV4" as const }, generation: "none" as const }] }] } as typeof expected;
  await rejects(prepared(schema));
});

/* These builders deliberately do not reuse the production compiler.  They model
 * the unbranded Prepared DTO boundary that admission is responsible for closing. */
const defaultNone = (): ExpectedColumn["default"] => ({ kind: "none" });
function column(property: string, physicalType: string, nullable = false, value: ExpectedColumn["default"] = defaultNone(), generation: ExpectedColumn["generation"] = "none"): ExpectedColumn {
  return Object.freeze({ property, column: property, physicalType, nullable, default: value, generation });
}
function table(name: string, columns: readonly ExpectedColumn[], key: readonly string[] = ["id"], extras: Partial<Pick<ExpectedTable, "indexes" | "foreignKeys" | "checks">> = {}): ExpectedTable {
  return Object.freeze({ schema: "public", table: name, columns: Object.freeze([...columns]), primaryKey: Object.freeze({ name: `pk_${name}`, columns: Object.freeze([...key]) }), indexes: Object.freeze(extras.indexes ? [...extras.indexes] : []), foreignKeys: Object.freeze(extras.foreignKeys ? [...extras.foreignKeys] : []), checks: Object.freeze(extras.checks ? [...extras.checks] : []) });
}
function schema(...tables: ExpectedTable[]): OrmExpectedSchema { return Object.freeze({ tables: Object.freeze(tables) }); }
function typedRequest(expectedSchema: OrmExpectedSchema, storeDefinition = definition): OwnedStoreAdmissionRequestV1 {
  return Object.freeze({ stores: Object.freeze([Object.freeze({ definition: storeDefinition, expected: expectedSchema, ownedScopeHash: canonicalOwnedStoreScopeHashV1(storeDefinition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(storeDefinition, expectedSchema) as `sha256:${string}` })]) });
}
async function invalid(expectedSchema: OrmExpectedSchema): Promise<void> {
  const input = typedRequest(expectedSchema); // Canonicalizable semantic negatives must carry their own valid hash.
  let caught: unknown;
  try { await admitOwnedStoresV1(provider, input); throw new Error("admission unexpectedly reached provider"); }
  catch (error) {
    caught = error;
  }
  exact(caught, "ORM_OWNED_STORE_IDENTITY_MISMATCH");
}
async function preflights(expectedSchema: OrmExpectedSchema): Promise<void> {
  let caught: unknown; try { await admitOwnedStoresV1(provider, typedRequest(expectedSchema)); } catch (error) { caught = error; }
  exact(caught, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
}
/** The only untyped boundary in this file: deliberately malformed hostile input. */
async function hostile(raw: unknown): Promise<void> {
  let caught: unknown; try { await admitOwnedStoresV1(provider, raw as OwnedStoreAdmissionRequestV1); } catch (error) { caught = error; }
  exact(caught, "ORM_OWNED_STORE_IDENTITY_MISMATCH");
}
function exact(error: unknown, code: OrmOwnedStoreAdmissionError["code"]): void {
  expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
  if (!(error instanceof OrmOwnedStoreAdmissionError)) throw new Error("expected owned-store admission error");
  expect(error.name).toBe("OrmOwnedStoreAdmissionError"); expect(error.code).toBe(code); expect(error.message).toBe(code);
  expect(Object.hasOwn(error, "cause")).toBe(false); expect(providerEffects).toBe(0);
}
function rawInvalid(expectedSchema: unknown): OwnedStoreAdmissionRequestV1 {
  const valid = typedRequest(schema(table("osnova_td_tag", [column("id", "integer")]))).stores[0]!;
  return { stores: [{ ...valid, expected: expectedSchema as OrmExpectedSchema }] };
}

test("projection validates every primary-key and generation representation", async () => {
  const basic = () => schema(table("osnova_td_keys", [column("id", "integer")]));
  await preflights(basic());
  await preflights(schema(table("osnova_td_compound", [column("tenant", "text"), column("id", "integer")], ["tenant", "id"])));
  await preflights(schema(table("osnova_td_identity", [column("id", "integer", false, defaultNone(), "identityByDefault")] )));
  await preflights(schema(table("osnova_td_uuid", [column("id", "uuid", false, { kind: "uuidV4" }, "uuidDefault")] )));
  const cases: readonly [string, OrmExpectedSchema][] = [
    ["missing", schema(table("osnova_td_keys", [column("id", "integer")], []))],
    ["duplicate", schema(table("osnova_td_keys", [column("id", "integer")], ["id", "id"]))],
    ["unknown", schema(table("osnova_td_keys", [column("id", "integer")], ["missing"]))],
    ["nullable", schema(table("osnova_td_keys", [column("id", "integer", true)]))],
    ["generated composite", schema(table("osnova_td_keys", [column("a", "integer", false, defaultNone(), "identityByDefault"), column("b", "integer")], ["a", "b"]))],
    ["generated non-key", schema(table("osnova_td_keys", [column("id", "integer"), column("v", "integer", false, defaultNone(), "identityByDefault")]))],
    ["identity type", schema(table("osnova_td_keys", [column("id", "text", false, defaultNone(), "identityByDefault")]))],
    ["uuid type", schema(table("osnova_td_keys", [column("id", "text", false, { kind: "uuidV4" }, "uuidDefault")]))],
    ["non-generated default", schema(table("osnova_td_keys", [column("id", "integer", false, { kind: "number", value: 1 })]))],
    ["current timestamp", schema(table("osnova_td_keys", [column("id", "integer", false, { kind: "currentTimestamp" })]))],
  ];
  for (const [label, value] of cases) await invalid(value);
});

test("projection validates default domains including canonical RFC3339 offsets", async () => {
  await preflights(schema(table("osnova_td_defaults", [
    column("id", "integer"), column("nullable", "text", true, { kind: "null" }), column("flag", "boolean", false, { kind: "boolean", value: true }),
    column("jsonFlag", "json", false, { kind: "boolean", value: false }), column("integer", "integer", false, { kind: "number", value: Number.MAX_SAFE_INTEGER }),
    column("real", "real", false, { kind: "number", value: 1.25 }), column("jsonNumber", "json", false, { kind: "number", value: 1.25 }),
    column("text", "text", false, { kind: "string", value: "ok" }), column("json", "json", false, { kind: "string", value: "ok" }),
    column("plus", "datetime", false, { kind: "string", value: "2026-02-28T23:59:59+03:00" }), column("minus", "datetime", false, { kind: "string", value: "2026-02-28T23:59:59-05:30" }),
  ])));
  const invalidDefault = (name: string, c: ExpectedColumn) => schema(table(name, [column("id", "integer"), c]));
  const cases: readonly [string, ExpectedColumn][] = [
    ["required-null", column("v", "text", false, { kind: "null" })], ["boolean-text", column("v", "text", false, { kind: "boolean", value: true })],
    ["number-text", column("v", "text", false, { kind: "number", value: 1 })], ["integer-unsafe", column("v", "integer", false, { kind: "number", value: Number.MAX_SAFE_INTEGER + 1 })],
    ["real-infinite", column("v", "real", false, { kind: "number", value: Infinity })], ["datetime-calendar", column("v", "datetime", false, { kind: "string", value: "2026-02-30T10:00:00Z" })],
    ["datetime-zone", column("v", "datetime", false, { kind: "string", value: "2026-02-28T10:00:00+24:00" })], ["lone-surrogate", column("v", "text", false, { kind: "string", value: "\ud800" })],
  ];
  for (const [label, value] of cases) {
    const candidate = invalidDefault(`osnova_td_${label}`, value);
    if (label === "real-infinite" || label === "lone-surrogate") await hostile(rawInvalid(candidate));
    else await invalid(candidate);
  }
});

test("projection CHECK validation uses physical columns and redacts malformed expressions", async () => {
  const columns = [column("id", "integer"), column("other", "integer"), column("flag", "boolean")];
  await preflights(schema(table("osnova_td_checks", columns, ["id"], { checks: [
    { name: "ck_id", expression: { kind: "in", left: "id", values: [1, 2] } },
    { name: "ck_compare", expression: { kind: "compare", op: ">=", left: "id", right: "\0other" } },
  ] })));
  await preflights(schema(table("osnova_td_uuidcheck", [column("uuid", "uuid", false, { kind: "uuidV4" }, "uuidDefault")], ["uuid"], { checks: [{ name: "ck_uuid", expression: { kind: "null", left: "uuid", not: true } }] })));
  const expressionCases: readonly [string, unknown][] = [
    ["unknown", { kind: "null", left: "missing", not: false }], ["literal", { kind: "compare", op: "=", left: "id", right: "text" }],
    ["null compare", { kind: "compare", op: "=", left: "id", right: null }], ["ordered boolean", { kind: "compare", op: ">", left: "flag", right: true }],
    ["malformed", { kind: "wat" }],
  ];
  for (const [label, expression] of expressionCases) {
    const candidate = schema(table(`osnova_td_check_${label}`, columns, ["id"], { checks: [{ name: "ck", expression }] }));
    if (label === "malformed") await hostile(rawInvalid(candidate));
    else await invalid(candidate);
  }
  // validateCheckAst maps UUID to logical text; admission must additionally
  // reject a physical UUID/text comparison that that logical projection permits.
  await invalid(schema(table("osnova_td_physical", [column("id", "integer"), column("text", "text")], ["id"], { checks: [{ name: "ck_physical", expression: { kind: "compare", op: "=", left: "id", right: "\0text" } }] })));
  await invalid(schema(table("osnova_td_uuid_text", [column("uuid", "uuid", false, { kind: "uuidV4" }, "uuidDefault"), column("text", "text")], ["uuid"], { checks: [{ name: "ck_uuid_text", expression: { kind: "compare", op: "=", left: "uuid", right: "\0text" } }] })));
});

function foreignKey(columns: readonly string[], target: string, targetColumns: readonly string[], onDelete = "noAction", onUpdate = "noAction"): ExpectedTable["foreignKeys"][number] {
  return Object.freeze({ name: "fk_child_parent", columns: Object.freeze([...columns]), target: Object.freeze({ schema: "public", table: target }), targetColumns: Object.freeze([...targetColumns]), onDelete, onUpdate });
}
test("projection validates same-store foreign keys, actions, and composite nullability", async () => {
  const parent = table("osnova_td_parent", [column("tenant", "text"), column("id", "integer")], ["tenant", "id"]);
  const child = (nullable: boolean, fk = foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"])) => table("osnova_td_child", [column("id", "integer"), column("tenant", "text", nullable), column("parentId", "integer", nullable)], ["id"], { foreignKeys: [fk] });
  for (const action of ["noAction", "restrict", "cascade", "setNull"] as const) await preflights(schema(parent, child(action === "setNull", foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"], action, action))));
  const cases: readonly [string, ExpectedTable][] = [
    ["unknown", child(false, foreignKey(["missing"], "osnova_td_parent", ["id"]))], ["duplicate", child(false, foreignKey(["tenant", "tenant"], "osnova_td_parent", ["tenant", "id"]))],
    ["count", child(false, foreignKey(["tenant"], "osnova_td_parent", ["tenant", "id"]))], ["partial", child(false, foreignKey(["parentId"], "osnova_td_parent", ["id"]))],
    ["reordered", child(false, foreignKey(["tenant", "parentId"], "osnova_td_parent", ["id", "tenant"]))], ["invalid-action", child(false, foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"], "drop"))],
    ["set-null-delete", child(false, foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"], "setNull"))], ["set-null-update", child(false, foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"], "noAction", "setNull"))],
    ["mixed-null", table("osnova_td_child", [column("id", "integer"), column("tenant", "text", true), column("parentId", "integer")], ["id"], { foreignKeys: [foreignKey(["tenant", "parentId"], "osnova_td_parent", ["tenant", "id"])] })],
  ];
  for (const [label, value] of cases) await invalid(schema(parent, value));
  const typeParent = table("osnova_td_type_parent", [column("tenant", "text"), column("id", "integer")], ["tenant", "id"]);
  const matched = table("osnova_td_type_child", [column("id", "integer"), column("tenant", "text"), column("parentId", "integer")], ["id"], { foreignKeys: [foreignKey(["tenant", "parentId"], "osnova_td_type_parent", ["tenant", "id"])] });
  await preflights(schema(typeParent, matched));
  const mismatched = table("osnova_td_type_child", [column("id", "integer"), column("tenant", "integer"), column("parentId", "integer")], ["id"], { foreignKeys: [foreignKey(["tenant", "parentId"], "osnova_td_type_parent", ["tenant", "id"])] });
  await invalid(schema(typeParent, mismatched));
});

test("projection keeps foreign-key ownership store-local even when another prepared store has the target", async () => {
  const otherDefinition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "other", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_other_" } });
  const local = schema(table("osnova_td_child", [column("id", "integer"), column("parentId", "integer")], ["id"], { foreignKeys: [foreignKey(["parentId"], "osnova_other_parent", ["id"])] }));
  const remote = schema(table("osnova_other_parent", [column("id", "integer")]));
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected: local, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, local) as `sha256:${string}` },
    { definition: otherDefinition, expected: remote, ownedScopeHash: canonicalOwnedStoreScopeHashV1(otherDefinition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(otherDefinition, remote) as `sha256:${string}` },
  ] };
  await rejects(input);
});

test("projection relation namespaces are global while constraint namespaces remain table-local", async () => {
  const one = table("osnova_td_one", [column("id", "integer")], ["id"], { indexes: [{ name: "ix_shared", columns: ["id"], unique: false, method: "btree" }], checks: [{ name: "same", expression: { kind: "null", left: "id", not: true } }] });
  const two = table("osnova_td_two", [column("id", "integer")], ["id"], { indexes: [{ name: "ix_two", columns: ["id"], unique: false, method: "btree" }], checks: [{ name: "same", expression: { kind: "null", left: "id", not: true } }] });
  await preflights(schema(one, two));
  const duplicateTable = table("osnova_td_one", [column("id", "integer")]);
  const duplicateIndex = table("osnova_td_two", [column("id", "integer")], ["id"], { indexes: [{ name: "ix_shared", columns: ["id"], unique: false, method: "btree" }] });
  const localCollision = table("osnova_td_local", [column("id", "integer")], ["id"], { checks: [{ name: "pk_osnova_td_local", expression: { kind: "null", left: "id", not: true } }] });
  await invalid(schema(one, duplicateTable));
  await invalid(schema(one, duplicateIndex));
  await invalid(schema(localCollision));
});

test("projection permits distinct constraint namespaces and rejects every global relation collision family", async () => {
  const a = table("osnova_td_alpha", [column("id", "integer")], ["id"], { checks: [{ name: "shared", expression: { kind: "null", left: "id", not: true } }], foreignKeys: [] });
  const b = table("osnova_td_beta", [column("id", "integer")], ["id"], { indexes: [{ name: "shared", columns: ["id"], unique: false, method: "btree" }], checks: [{ name: "__osnova_orm_owned_stores_v1", expression: { kind: "null", left: "id", not: true } }] });
  await preflights(schema(a, b));
  const collision = (left: ExpectedTable, right: ExpectedTable) => invalid(schema(left, right));
  const base = table("osnova_td_relation", [column("id", "integer")]);
  await collision(base, table("osnova_td_other", [column("id", "integer")], ["id"], { indexes: [{ name: "osnova_td_relation", columns: ["id"], unique: false, method: "btree" }] }));
  await collision(base, { ...table("osnova_td_other2", [column("id", "integer")]), primaryKey: { name: "osnova_td_relation", columns: ["id"] } });
  const pk = { ...table("osnova_td_pk", [column("id", "integer")]), primaryKey: { name: "global_pk", columns: ["id"] } };
  await collision(pk, { ...table("osnova_td_pk2", [column("id", "integer")]), primaryKey: { name: "global_pk", columns: ["id"] } });
  await collision(pk, table("osnova_td_pk3", [column("id", "integer")], ["id"], { indexes: [{ name: "global_pk", columns: ["id"], unique: false, method: "btree" }] }));
  const other = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "collision", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_c_" } });
  const first = schema(table("osnova_td_cross", [column("id", "integer")])); const second = schema(table("osnova_c_cross", [column("id", "integer")], ["id"], { indexes: [{ name: "osnova_td_cross", columns: ["id"], unique: false, method: "btree" }] }));
  const input: OwnedStoreAdmissionRequestV1 = { stores: [{ definition, expected: first, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, first) as `sha256:${string}` }, { definition: other, expected: second, ownedScopeHash: canonicalOwnedStoreScopeHashV1(other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(other, second) as `sha256:${string}` }] };
  await hostile(input);
});

test("projection permits Registry constraint text and repeated FK names outside relation namespace", async () => {
  const parent = table("osnova_td_namespace_parent", [column("id", "integer")]);
  const fk = (name: string): ExpectedTable["foreignKeys"][number] => Object.freeze({ ...foreignKey(["parentId"], "osnova_td_namespace_parent", ["id"]), name });
  const first = table("osnova_td_namespace_one", [column("id", "integer"), column("parentId", "integer")], ["id"], { indexes: [{ name: "same_text", columns: ["id"], unique: false, method: "btree" }], checks: [{ name: "ck_one", expression: { kind: "null", left: "id", not: true } }], foreignKeys: [fk("same_text")] });
  const second = table("osnova_td_namespace_two", [column("id", "integer"), column("parentId", "integer")], ["id"], { checks: [{ name: "__osnova_orm_owned_stores_v1_pkey", expression: { kind: "null", left: "id", not: true } }], foreignKeys: [fk("same_text")] });
  const third = table("osnova_td_namespace_three", [column("id", "integer"), column("parentId", "integer")], ["id"], { foreignKeys: [fk("__osnova_orm_owned_stores_v1_pkey")] });
  await preflights(schema(parent, first, second, third));
});

test("projection reserves both fixed Registry relations and rejects descriptor capture", async () => {
  for (const relation of ["__osnova_orm_owned_stores_v1", "__osnova_orm_owned_stores_v1_pkey"]) {
    const base = table(`osnova_td_${relation.slice(-4)}`, [column("id", "integer")]);
    const pkCollision = schema({ ...base, primaryKey: { ...base.primaryKey, name: relation } });
    const indexCollision = schema(table(`osnova_td_ix_${relation.slice(-4)}`, [column("id", "integer")], ["id"], { indexes: [{ name: relation, columns: ["id"], unique: false, method: "btree" }] }));
    for (const candidate of [pkCollision, indexCollision]) await rejects(typedRequest(candidate), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  }
  for (const prefix of ["__osnova_orm_owned_stores_v1", "__osnova_orm_owned_stores_v1_pkey"]) {
    const captured = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: `reserved-${prefix}`, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: prefix } });
    const capturedExpected = schema(table(prefix, [column("id", "integer")]));
    const input = typedRequest(capturedExpected, captured);
    await rejects(input, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    const rejected = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: `rejected-${prefix}`, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_reject_" }, rejectIfPresent: [{ schema: "public", tablePrefix: prefix }] });
    const rejectedExpected = schema(table("osnova_td_reject_table", [column("id", "integer")]));
    await rejects(typedRequest(rejectedExpected, rejected), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
  }
});

test("projection snapshot CHECK boundaries reject depth, occurrence and cyclic hostile data before provider access", async () => {
  const nested = (count: number): unknown => { let value: unknown = { kind: "null", left: "id", not: false }; for (let index = 1; index < count; index++) value = { kind: "not", inner: value }; return value; };
  const full = (leaves: number): unknown => leaves === 1 ? { kind: "null", left: "id", not: false } : { kind: "and", left: full(leaves / 2), right: full(leaves / 2) };
  const check = (name: string, expression: unknown) => schema(table(name, [column("id", "integer")], ["id"], { checks: [{ name: "ck", expression }] }));
  await preflights(check("osnova_td_depth64", nested(64)));
  await hostile(rawInvalid(check("osnova_td_depth65", nested(65))));
  await preflights(check("osnova_td_nodes4096", { kind: "not", inner: full(2048) }));
  await hostile(rawInvalid(check("osnova_td_nodes4097", { kind: "not", inner: { kind: "not", inner: full(2048) } })));
  const cycle: { kind: "not"; inner?: unknown } = { kind: "not" }; cycle.inner = cycle;
  await hostile(rawInvalid(check("osnova_td_cycle", cycle)));
  let shared: unknown = { kind: "null", left: "id", not: false };
  for (let index = 0; index < 11; index++) shared = { kind: "and", left: shared, right: shared };
  await preflights(check("osnova_td_dag4096", { kind: "not", inner: shared }));
  await hostile(rawInvalid(check("osnova_td_dag4097", { kind: "not", inner: { kind: "not", inner: shared } })));
});

test("projection snapshot rejects hostile descriptors without evaluating user hooks", async () => {
  const item = typedRequest(schema(table("osnova_td_hostile", [column("id", "integer")]))).stores[0]!;
  let hooks = 0;
  const getter = { tables: [] as unknown[] }; Object.defineProperty(getter, "tables", { enumerable: true, get() { hooks++; return []; } });
  const symbol = { tables: [] as unknown[] }; Object.defineProperty(symbol, Symbol("extra"), { value: true, enumerable: true });
  const sparse = { tables: [table("osnova_td_sparse", [column("id", "integer")])] }; Object.defineProperty(sparse.tables, 2, { value: sparse.tables[0], enumerable: true });
  const revoked = Proxy.revocable({ tables: [] }, {}); revoked.revoke();
  const cases: readonly unknown[] = [
    { stores: [{ ...item, expected: getter }] }, { stores: [{ ...item, expected: symbol }] }, { stores: [{ ...item, expected: sparse }] }, { stores: [{ ...item, expected: revoked.proxy }] },
    { stores: [{ ...item, expected: { tables: [], extra: true } }] }, { stores: [{ ...item, expected: { tables: Array(65_537).fill(undefined) } }] },
  ];
  for (const value of cases) await hostile(value);
  expect(hooks).toBe(0);
});

test("admission snapshot enforces the exact per-model value-node budget without an aggregate store limit", async () => {
  const budget = (prefix: string, finalValues: number, fullChecks: number): OrmExpectedSchema => schema(table(`${prefix}budget`, [column("id", "integer"), column("left", "boolean"), column("right", "boolean")], ["id"], {
    checks: Array.from({ length: fullChecks + 1 }, (_, index) => ({ name: `ck_${index}`, expression: { kind: "in", left: "left", values: Array(index === fullChecks ? finalValues : 99).fill(index % 2 === 0) } })),
  }));
  // 36 fixed nodes + 9,523 * (6 + 99) + (6 + 43) = exactly 1,000,000.
  const atMillion = budget("osnova_td_", 43, 9523);
  expect(canonicalOwnedStoreModelPreimageV1(definition, atMillion).byteLength).toBeLessThan(4 * 1024 * 1024);
  await preflights(atMillion);
  await hostile(rawInvalid(budget("osnova_td_", 44, 9523)));

  // Each independently hashed store has 600,000 nodes: 36 + 5,713*105 + 99.
  const left = budget("osnova_td_left_", 93, 5713);
  const secondDefinition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "budget-second", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_b_right_" } });
  const right = budget("osnova_b_right_", 93, 5713);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected: left, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, left) as `sha256:${string}` },
    { definition: secondDefinition, expected: right, ownedScopeHash: canonicalOwnedStoreScopeHashV1(secondDefinition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(secondDefinition, right) as `sha256:${string}` },
  ] };
  await rejects(input, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  // This checks a million-node size boundary, not a latency contract. Leave
  // headroom for allocation/GC when the full suite runs on a busy machine.
}, 15_000);

/** B3 boundary controls use a local recording capability only; they do not model C SQL. */
function contextSession(maxIdentifierLength: unknown): RegistryLockedOwnedStoreSessionV1 {
  return Object.freeze({
    get maxIdentifierLength(): bigint { return maxIdentifierLength as bigint; },
    async inspectRegistry(): Promise<never> { throw new Error("unexpected registry read"); },
    async lockSecondary(): Promise<never> { throw new Error("unexpected secondary lock"); },
  });
}
async function admissionError(work: () => Promise<unknown>, code: OrmOwnedStoreAdmissionError["code"]): Promise<void> {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OrmOwnedStoreAdmissionError);
  if (!(caught instanceof OrmOwnedStoreAdmissionError)) throw new Error("expected owned-store admission error");
  expect(Object.getPrototypeOf(caught)).toBe(OrmOwnedStoreAdmissionError.prototype); expect(caught.name).toBe("OrmOwnedStoreAdmissionError"); expect(caught.code).toBe(code); expect(caught.message).toBe(code); expect(Object.hasOwn(caught, "cause")).toBe(false); expect(providerEffects).toBe(0);
}
test("B3 server context validates a returned value before Registry access", async () => {
  for (const [value, code] of [["63", "ORM_OWNED_STORE_DRIFT"], [62n, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"]] as const) {
    let calls = 0;
    registerPostgresOwnedStoreCapability(provider, { async withOwnedStoreAdmission(_signal, work) { calls++; return work(contextSession(value)); } });
    await admissionError(() => admitOwnedStoresV1(provider, request()), code);
    expect(calls).toBe(1);
  }
});
test("B3 server-context getter failures are operationally redacted", async () => {
  let reads = 0, registryReads = 0;
  const session: RegistryLockedOwnedStoreSessionV1 = Object.freeze({
    get maxIdentifierLength(): bigint { reads++; throw failure("ORM_OWNED_STORE_DRIFT"); },
    async inspectRegistry(): Promise<never> { registryReads++; throw new Error("must not read"); },
    async lockSecondary(): Promise<never> { throw new Error("must not lock"); },
  });
  registerPostgresOwnedStoreCapability(provider, { async withOwnedStoreAdmission(_signal, work) { return work(session); } });
  await admissionError(() => admitOwnedStoresV1(provider, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(reads).toBe(1); expect(registryReads).toBe(0);
});
test("B3 preserves an exact safe capability rejection before callback entry", async () => {
  let callback = 0;
  registerPostgresOwnedStoreCapability(provider, { async withOwnedStoreAdmission() { callback++; throw failure("ORM_OWNED_STORE_DRIFT"); } });
  await admissionError(() => admitOwnedStoresV1(provider, request()), "ORM_OWNED_STORE_DRIFT");
  expect(callback).toBe(1);
});

/** Local B1 recording facts: raw parser inputs remain explicit and independent. */
function recordingColumn(): OwnedCatalogColumnV1 { return {
  relationOid: "10", attnum: "1", name: "id", dropped: false, local: true, inheritanceCount: "0", physicalType: "integer", typeOid: "23", notNull: true,
  default: { kind: "none" }, defaultObjectOid: null, generation: "none", identityCode: "", generatedCode: "", collationOid: "0", typeDefaultCollationOid: "0", storageCode: "p", typeDefaultStorageCode: "p", compressionCode: "",
}; }
function recordingIndex(): OwnedCatalogIndexV1 { return {
  indexRelationOid: "12", tableRelationOid: "10", name: "pk_jobs", method: "btree", unique: true, primary: true, exclusion: false, immediate: true, valid: true, ready: true, live: true, replicaIdentity: false, nullsNotDistinct: false,
  keyAttributeCount: "1", totalAttributeCount: "1", attributeNumbers: ["1"], columnNames: ["id"], collationOids: ["0"], opclassOids: ["99"], defaultOpclassOids: ["99"], options: ["0"], expression: null, predicate: null, backingConstraintOid: "16",
}; }
function recordingPrimaryKey(): OwnedCatalogConstraintV1 { return {
  oid: "16", relationOid: "10", referencedRelationOid: null, name: "pk_jobs", kind: "primaryKey", columns: ["id"], referencedColumns: [], backingIndexOid: "12", onDelete: null, onUpdate: null, match: null,
  deferrable: false, initiallyDeferred: false, validated: true, parentConstraintOid: null, inheritanceCount: "0", noInherit: true, deleteSetColumns: [], primaryForeignEqualityOperatorOids: [], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: [], defaultEqualityOperatorOids: [], checkExpression: null,
}; }
test("B1 recording facts parse a non-default integer primary-key physical contract", () => {
  const context = Object.freeze({ maxIdentifierLength: 63n });
  expect(parseOwnedCatalogColumnV1(recordingColumn()).default.kind).toBe("none");
  expect(parseOwnedCatalogIndexV1(recordingIndex()).name).toBe("pk_jobs");
  expect(parseOwnedCatalogConstraintV1(recordingPrimaryKey(), context).backingIndexOid).toBe("12");
});

function recordingCatalogSnapshot(): OwnedStoreCatalogSnapshotV1 { return {
  contract: "osnova.orm-owned-store-catalog-snapshot/v1", requestedScopes: [{ schema: "public", tablePrefix: "osnova_td_" }], existingSchemas: ["public"],
  catalogClasses: [{ oid: "1", schema: "pg_catalog", name: "pg_class", kind: "pg_class" }, { oid: "2", schema: "pg_catalog", name: "pg_type", kind: "pg_type" }, { oid: "3", schema: "pg_catalog", name: "pg_constraint", kind: "pg_constraint" }, { oid: "4", schema: "pg_catalog", name: "pg_attrdef", kind: "pg_attrdef" }, { oid: "5", schema: "pg_catalog", name: "pg_namespace", kind: "pg_namespace" }],
  relations: [
    { oid: "10", namespaceOid: "12000", schema: "public", name: "osnova_td_jobs", kind: "ordinaryTable", rawKind: "r", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "default", tablespaceOid: "0", accessMethod: "heap", options: [], rowTypeOid: "11", toastRelationOid: null },
    { oid: "12", namespaceOid: "12000", schema: "public", name: "pk_jobs", kind: "index", rawKind: "i", persistence: "permanent", isPartition: false, rowSecurity: false, forceRowSecurity: false, replicaIdentity: "nothing", tablespaceOid: "0", accessMethod: "btree", options: [], rowTypeOid: null, toastRelationOid: null },
  ], rowTypes: [{ oid: "11", relationOid: "10", schema: "public", name: "osnova_td_jobs", kind: "composite", arrayTypeOid: "15" }], arrayTypes: [{ oid: "15", elementTypeOid: "11", relationOid: "0", arrayTypeOid: "0", schema: "public", name: "_osnova_td_jobs", kind: "base", category: "array" }],
  columns: [recordingColumn()], indexes: [recordingIndex()], constraints: [recordingPrimaryKey()], triggers: [], rules: [], policies: [], inheritance: [], sequences: [],
  dependencies: [
    { dependentClassOid: "1", dependentOid: "10", dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" },
    { dependentClassOid: "2", dependentOid: "11", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "0", kind: "internal" },
    { dependentClassOid: "2", dependentOid: "15", dependentSubId: "0", referencedClassOid: "2", referencedOid: "11", referencedSubId: "0", kind: "internal" },
    { dependentClassOid: "3", dependentOid: "16", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "1", kind: "automatic" },
    { dependentClassOid: "1", dependentOid: "12", dependentSubId: "0", referencedClassOid: "3", referencedOid: "16", referencedSubId: "0", kind: "internal" },
  ],
}; }
test("B1 recording Catalogue snapshot parses and verifies the current admitted store", () => {
  const context = Object.freeze({ maxIdentifierLength: 63n });
  const snapshot = parseOwnedStoreCatalogSnapshotV1(recordingCatalogSnapshot(), context);
  expect(snapshot.relations[0]!.name).toBe("osnova_td_jobs"); expect(snapshot.requestedScopes).toEqual([{ schema: "public", tablePrefix: "osnova_td_" }]);
  expect(() => verifyOwnedStoreCatalogAllV1(snapshot, { stores: [{ definition, expectedSchema: expected }], requestedScopes: [{ schema: "public", tablePrefix: "osnova_td_" }] })).not.toThrow();
});

function recordingRegistrySnapshot() {
  const source = recordingCatalogSnapshot(), rootOid = "50", rowOid = "51", arrayOid = "52", constraintOid = "53", indexOid = "54";
  const root = { ...source.relations[0]!, oid: rootOid, name: "__osnova_orm_owned_stores_v1", rowTypeOid: rowOid };
  const names = ["store_key", "contract", "format_version", "owned_schema", "table_prefix", "owned_scope_hash", "model_hash", "created_at"] as const;
  const types = ["text", "text", "integer", "text", "text", "text", "text", "datetime"] as const;
  const columns = names.map((name, index) => ({ ...recordingColumn(), relationOid: rootOid, attnum: String(index + 1), name, physicalType: types[index]!, typeOid: types[index] === "text" ? "25" : types[index] === "datetime" ? "1184" : "20", notNull: true, collationOid: types[index] === "text" ? "100" : "0", typeDefaultCollationOid: types[index] === "text" ? "100" : "0", storageCode: types[index] === "text" ? "x" : "p", typeDefaultStorageCode: types[index] === "text" ? "x" : "p" }));
  const pkName = "__osnova_orm_owned_stores_v1_pkey";
  return { contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "present", rows: [{ storeKey: definition.storeKey, contract: definition.contract, formatVersion: "1", ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition), modelHash: canonicalOwnedStoreModelHashV1(definition, expected), createdAtEpochMicroseconds: "0" }], shape: {
    catalogClasses: source.catalogClasses, relation: root, rowType: { ...source.rowTypes[0]!, oid: rowOid, relationOid: rootOid, name: root.name, arrayTypeOid: arrayOid }, arrayType: { ...source.arrayTypes[0]!, oid: arrayOid, elementTypeOid: rowOid, name: "_osnova_orm_owned_stores_v1" }, columns,
    indexes: [{ ...recordingIndex(), indexRelationOid: indexOid, tableRelationOid: rootOid, name: pkName, backingConstraintOid: constraintOid, columnNames: ["store_key"], collationOids: ["100"], opclassOids: ["3126"], defaultOpclassOids: ["3126"] }], indexRelations: [{ ...source.relations[1]!, oid: indexOid, name: pkName }], constraints: [{ ...recordingPrimaryKey(), oid: constraintOid, relationOid: rootOid, name: pkName, columns: ["store_key"], backingIndexOid: indexOid }], triggers: [], rules: [], policies: [], inheritance: [], sequences: [], toast: null,
    dependencies: [{ dependentClassOid: "1", dependentOid: rootOid, dependentSubId: "0", referencedClassOid: "5", referencedOid: "12000", referencedSubId: "0", kind: "normal" }, { dependentClassOid: "2", dependentOid: rowOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "0", kind: "internal" }, { dependentClassOid: "2", dependentOid: arrayOid, dependentSubId: "0", referencedClassOid: "2", referencedOid: rowOid, referencedSubId: "0", kind: "internal" }, { dependentClassOid: "3", dependentOid: constraintOid, dependentSubId: "0", referencedClassOid: "1", referencedOid: rootOid, referencedSubId: "1", kind: "automatic" }, { dependentClassOid: "1", dependentOid: indexOid, dependentSubId: "0", referencedClassOid: "3", referencedOid: constraintOid, referencedSubId: "0", kind: "internal" }],
  } } };
}
test("B1 recording Registry snapshot and current Catalogue classify as exact reopen", () => {
  const context = Object.freeze({ maxIdentifierLength: 63n }); const scopes = [{ schema: "public", tablePrefix: "osnova_td_" }];
  const registry = parseOwnedStoreRegistrySnapshotV1(recordingRegistrySnapshot(), [definition], context); const catalogue = parseOwnedStoreCatalogSnapshotV1(recordingCatalogSnapshot(), context);
  expect(inspectOwnedStoreCatalogPreCreateV1(catalogue, registry, { stores: [{ definition, expectedSchema: expected }], requestedScopes: scopes })).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
});

function recordingProvider(): DatabaseProvider { return Object.freeze({ ...provider }); }
function recordingCapability(mode: "reopen" | "create", serverContext: unknown = 63n, applyFailure?: unknown, insertFailure?: unknown, finalRegistryRaw?: unknown, finalRegistryFailure?: unknown, initialRegistryRaw?: unknown, initialRegistryFailure?: unknown, catalogueRaw?: unknown, postCatalogueRaw?: unknown, lockFailure?: unknown, catalogueFailure?: unknown) {
  const events: string[] = []; let catalogueReads = 0, contextReads = 0; const scopes: { readonly schema: string; readonly tablePrefix: string; }[][] = []; const plans: OwnedStoreSecondaryLockPlanV1[] = []; const created: OwnedStoreCreateOperationV1[][] = []; const inserted: OwnedStoreIdentityInsertV1[][] = []; const context = Object.freeze({ maxIdentifierLength: 63n });
  const registryRaw = recordingRegistrySnapshot(); const registry = parseOwnedStoreRegistrySnapshotV1(registryRaw, [definition], context); const emptyRegistry = parseOwnedStoreRegistrySnapshotV1({ ...registryRaw, state: { ...registryRaw.state, rows: [] } }, [definition], context);
  const fullCatalogue = parseOwnedStoreCatalogSnapshotV1(recordingCatalogSnapshot(), context); const emptyCatalogue = parseOwnedStoreCatalogSnapshotV1({ ...recordingCatalogSnapshot(), relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], dependencies: [] }, context);
  const secondary: SecondaryLockedOwnedStoreSessionV1 = Object.freeze({
    async inspectCatalog(requested: readonly { readonly schema: string; readonly tablePrefix: string; }[]) { events.push("catalogue"); scopes.push([...requested]); if (catalogueFailure !== undefined) throw catalogueFailure; if (mode !== "create") return catalogueRaw === undefined ? fullCatalogue : catalogueRaw as OwnedStoreCatalogSnapshotV1; if (catalogueReads++ === 0) return catalogueRaw === undefined ? emptyCatalogue : catalogueRaw as OwnedStoreCatalogSnapshotV1; return postCatalogueRaw === undefined ? fullCatalogue : postCatalogueRaw as OwnedStoreCatalogSnapshotV1; },
    async createRegistryV1() { events.push("createRegistry"); }, async applyCreateOperations(operations: readonly OwnedStoreCreateOperationV1[]) { events.push("create"); created.push([...operations]); if (applyFailure !== undefined) throw applyFailure; },
    async insertIdentities(rows: readonly OwnedStoreIdentityInsertV1[]) { events.push("insert"); inserted.push([...rows]); if (insertFailure !== undefined) throw insertFailure; }, async inspectRegistry() { events.push("finalRegistry"); if (finalRegistryFailure !== undefined) throw finalRegistryFailure; return finalRegistryRaw === undefined ? registry : finalRegistryRaw as ReturnType<typeof parseOwnedStoreRegistrySnapshotV1>; },
  });
  const locked: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ get maxIdentifierLength(): bigint { contextReads++; return typeof serverContext === "function" ? (serverContext as () => unknown)() as bigint : serverContext as bigint; }, async inspectRegistry() { events.push("registry"); if (initialRegistryFailure !== undefined) throw initialRegistryFailure; return initialRegistryRaw === undefined ? mode === "create" ? emptyRegistry : registry : initialRegistryRaw as ReturnType<typeof parseOwnedStoreRegistrySnapshotV1>; }, async lockSecondary(plan: OwnedStoreSecondaryLockPlanV1) { events.push("lock"); plans.push(plan); if (lockFailure !== undefined) throw lockFailure; return secondary; } });
  return { events, scopes, plans, created, inserted, get contextReads() { return contextReads; }, capability: { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("callback"); return work(locked); } } };
}
test("B3 recording capability reopens one store then publishes one idempotently revocable lease", async () => {
  const local = recordingProvider(), record = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, record.capability);
  const receipt = await admitOwnedStoresV1(local, request()); expect(Object.isFrozen(receipt)).toBe(true);
  expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]);
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(1); const lease = leases[0]; if (!lease) throw new Error("missing lease"); expect(Object.isFrozen(lease)).toBe(true); expect(lease.active).toBe(true); lease.revoke(); lease.revoke(); expect(lease.active).toBe(false);
});
test("B3 rejectIfPresent requests its scope while reopening and rejects an existing reject root", async () => {
  const rejecting = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_" }, rejectIfPresent: [{ schema: "public", tablePrefix: "osnova_b_" }] }); const requestedScopes = [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]; const input = typedRequest(expected, rejecting);
  const onlyA = { ...recordingCatalogSnapshot(), requestedScopes }; const local = recordingProvider(), reopen = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, undefined, undefined, onlyA); registerPostgresOwnedStoreCapability(local, reopen.capability); const receipt = await admitOwnedStoresV1(local, input); expect(reopen.scopes).toEqual([requestedScopes]); expect(reopen.created).toEqual([]); expect(reopen.inserted).toEqual([]); const lease = publishOwnedStoreAdmissionV1(local, receipt)[0]; if (!lease) throw new Error("missing reject reopen lease"); lease.revoke();
  const full = recordingTwoStores().catalogue, rejected = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, undefined, undefined, full); const blocked = recordingProvider(); registerPostgresOwnedStoreCapability(blocked, rejected.capability); await admissionError(() => admitOwnedStoresV1(blocked, input), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); expect(rejected.events).toEqual(["callback", "registry", "lock", "catalogue"]); expect(rejected.scopes).toEqual([requestedScopes]); expect(rejected.created).toEqual([]); expect(rejected.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 post-create rejectIfPresent root blocks identity insert", async () => {
  const rejecting = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_" }, rejectIfPresent: [{ schema: "public", tablePrefix: "osnova_b_" }] }); const scopes = [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]; const empty = { ...recordingCatalogSnapshot(), requestedScopes: scopes, relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], dependencies: [] }; const full = recordingTwoStores().catalogue; const registry = recordingRegistrySnapshot(); const emptyRegistry = { ...registry, state: { ...registry.state, rows: [] } }; const local = recordingProvider(), record = recordingCapability("create", 63n, undefined, undefined, undefined, undefined, emptyRegistry, undefined, empty, full); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, typedRequest(expected, rejecting)), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue"]); expect(record.scopes).toEqual([scopes, scopes]); expect(record.created).toEqual([[{ kind: "createTable", table: expected.tables[0]! }]]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 raw Catalogue parse failure maps by initial versus post-create phase", async () => {
  const raw = recordingCatalogSnapshot(), malformed = { ...raw, columns: raw.columns.map(column => ({ ...column, attnum: "01" })) };
  const reopenProvider = recordingProvider(), reopen = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, undefined, undefined, malformed); registerPostgresOwnedStoreCapability(reopenProvider, reopen.capability); await admissionError(() => admitOwnedStoresV1(reopenProvider, request()), "ORM_OWNED_STORE_DRIFT"); expect(reopen.events).toEqual(["callback", "registry", "lock", "catalogue"]); expect(reopen.created).toEqual([]); expect(reopen.inserted).toEqual([]); expect(providerEffects).toBe(0);
  const createProvider = recordingProvider(), create = recordingCapability("create", 63n, undefined, undefined, undefined, undefined, undefined, undefined, undefined, malformed); registerPostgresOwnedStoreCapability(createProvider, create.capability); await admissionError(() => admitOwnedStoresV1(createProvider, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(create.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue"]); expect(create.created).toHaveLength(1); expect(create.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 lock and Catalogue operational failures preserve reached phase and redact raw/proxy errors", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("operational proxy"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const [phase, failureValue] of [["lock", new Error("lock raw")], ["lock", proxy], ["catalogue", new Error("catalogue raw")], ["catalogue", proxy]] as const) { const local = recordingProvider(), record = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, phase === "lock" ? failureValue : undefined, phase === "catalogue" ? failureValue : undefined); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(record.events).toEqual(phase === "lock" ? ["callback", "registry", "lock"] : ["callback", "registry", "lock", "catalogue"]); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 native already-aborted signal rejects before capability entry", async () => {
  const controller = new AbortController(); controller.abort(); const local = recordingProvider(), record = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, { ...request(), signal: controller.signal }), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(record.events).toEqual([]); expect(record.contextReads).toBe(0); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 native abort after completed callback prevents receipt after capability release", async () => {
  const controller = new AbortController(), local = recordingProvider(), recorded = recordingCapability("reopen"); let release: (() => void) | undefined; const gate = new Promise<void>(resolve => { release = resolve; }); let readyResolve: (() => void) | undefined; const ready = new Promise<void>(resolve => { readyResolve = resolve; }); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { const value = await recorded.capability.withOwnedStoreAdmission(signal, work); if (!readyResolve) throw new Error("missing abort ready resolver"); readyResolve(); await gate; return value; } });
  let settled = false; const pending = admitOwnedStoresV1(local, { ...request(), signal: controller.signal }).then(value => { settled = true; return value; }, error => { settled = true; throw error; }); try { const state = await Promise.race([ready.then(() => "ready" as const), pending.then(() => "settled" as const)]); if (state !== "ready") throw new Error("admission settled before abort"); expect(settled).toBe(false); controller.abort(); } finally { if (!release) throw new Error("missing abort release"); release(); }
  await admissionError(() => pending, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 successful native signal admission does not attach post-publication listeners", async () => {
  const controller = new AbortController(), signal = controller.signal; let added = 0, removed = 0; const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal); Object.defineProperties(signal, { addEventListener: { value(...args: Parameters<AbortSignal["addEventListener"]>) { added++; return add(...args); } }, removeEventListener: { value(...args: Parameters<AbortSignal["removeEventListener"]>) { removed++; return remove(...args); } } }); const local = recordingProvider(), record = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, record.capability); const receipt = await admitOwnedStoresV1(local, { ...request(), signal }); const lease = publishOwnedStoreAdmissionV1(local, receipt)[0]; if (!lease) throw new Error("missing native-signal lease"); expect(Object.isFrozen(lease)).toBe(true); expect(lease.active).toBe(true); controller.abort(); expect(lease.active).toBe(true); lease.revoke(); lease.revoke(); expect(lease.active).toBe(false); expect(added).toBe(0); expect(removed).toBe(0); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 recording capability creates the missing store, rechecks, inserts sorted identity, then publishes", async () => {
  const local = recordingProvider(), record = recordingCapability("create"); registerPostgresOwnedStoreCapability(local, record.capability);
  const receipt = await admitOwnedStoresV1(local, request()); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]);
  expect(record.contextReads).toBe(1);
  expect(record.created).toHaveLength(1); expect(record.created[0]!.map(item => item.kind)).toEqual(["createTable"]); expect((record.created[0]![0] as Extract<OwnedStoreCreateOperationV1, { kind: "createTable" }>).table.table).toBe("osnova_td_jobs");
  expect(record.inserted).toHaveLength(1); expect(record.inserted[0]![0]).toMatchObject({ storeKey: "fixtures", ownedSchema: "public", tablePrefix: "osnova_td_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition), modelHash: canonicalOwnedStoreModelHashV1(definition, expected) });
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(1); const lease = leases[0]; if (!lease) throw new Error("missing lease"); expect(lease.active).toBe(true);
});
test("B3 applyCreateOperations rejection maps every safe, raw, and proxy error to CREATE_FAILED", async () => {
  let proxyHooks = 0; const proxy = new Proxy(new Error("proxy mutation marker"), { get() { proxyHooks++; throw new Error("hook"); }, getPrototypeOf() { proxyHooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { proxyHooks++; throw new Error("hook"); }, ownKeys() { proxyHooks++; throw new Error("hook"); } });
  for (const thrown of [...safeAdmissionCodes.map(code => failure(code)), new Error("raw mutation marker"), proxy]) {
    const local = recordingProvider(), record = recordingCapability("create", 63n, thrown); registerPostgresOwnedStoreCapability(local, record.capability);
    await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create"]); expect(record.created).toHaveLength(1); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0);
  }
  expect(proxyHooks).toBe(0);
});
test("B3 insertIdentities rejection maps every safe, raw, and proxy error after a verified create", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("proxy insert marker"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const thrown of [...safeAdmissionCodes.map(code => failure(code)), new Error("raw insert marker"), proxy]) { const local = recordingProvider(), record = recordingCapability("create", 63n, undefined, thrown); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert"]); expect(record.created).toHaveLength(1); expect(record.inserted).toHaveLength(1); expect(record.inserted[0]![0]!.storeKey).toBe("fixtures"); expect(providerEffects).toBe(0); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 reopen final Registry semantic and read failures stop without mutation", async () => {
  const base = recordingRegistrySnapshot(); const malformedCreatedAt = { ...base, state: { ...base.state, rows: [{ ...base.state.rows[0]!, createdAtEpochMicroseconds: "01" }] } }; const malformedShape = { ...base, state: { ...base.state, shape: { ...base.state.shape, columns: [] } } }; const missingCurrent = { ...base, state: { ...base.state, rows: [] } }; const modelMismatch = { ...base, state: { ...base.state, rows: [{ ...base.state.rows[0]!, modelHash: "sha256:" + "1".repeat(64) }] } };
  const cases: readonly [unknown, OrmOwnedStoreAdmissionError["code"]][] = [[{ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "absent" } }, "ORM_OWNED_STORE_DRIFT"], [missingCurrent, "ORM_OWNED_STORE_DRIFT"], [malformedCreatedAt, "ORM_OWNED_STORE_DRIFT"], [malformedShape, "ORM_OWNED_STORE_DRIFT"], [{ ...base, publicSchemaExists: false }, "ORM_OWNED_STORE_DRIFT"], [modelMismatch, "ORM_OWNED_STORE_IDENTITY_MISMATCH"]];
  for (const [raw, code] of cases) { const local = recordingProvider(), recorded = recordingCapability("reopen", 63n, undefined, undefined, raw); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), code); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(providerEffects).toBe(0); }
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("final read proxy"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const failureValue of [new Error("final read raw"), proxy]) { const local = recordingProvider(), recorded = recordingCapability("reopen", 63n, undefined, undefined, undefined, failureValue); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 post-mutation final Registry semantic failures map to CREATE_FAILED after insert", async () => {
  const base = recordingRegistrySnapshot(); const malformedCreatedAt = { ...base, state: { ...base.state, rows: [{ ...base.state.rows[0]!, createdAtEpochMicroseconds: "01" }] } }; const malformedShape = { ...base, state: { ...base.state, shape: { ...base.state.shape, columns: [] } } }; const missingCurrent = { ...base, state: { ...base.state, rows: [] } }; const modelMismatch = { ...base, state: { ...base.state, rows: [{ ...base.state.rows[0]!, modelHash: "sha256:" + "1".repeat(64) }] } };
  for (const raw of [{ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "absent" } }, missingCurrent, malformedCreatedAt, malformedShape, { ...base, publicSchemaExists: false }, modelMismatch]) { const local = recordingProvider(), record = recordingCapability("create", 63n, undefined, undefined, raw); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]); expect(record.created).toHaveLength(1); expect(record.inserted).toHaveLength(1); expect(providerEffects).toBe(0); }
});
test("B3 post-mutation final Registry read failures are operational LOCK failures", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("proxy final marker"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const failureValue of [new Error("raw final marker"), proxy]) { const local = recordingProvider(), record = recordingCapability("create", 63n, undefined, undefined, undefined, failureValue); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]); expect(record.created).toHaveLength(1); expect(record.inserted).toHaveLength(1); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 final Registry overlapping offgraph ownership wins before public-schema status", async () => {
  const archive = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "archive", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_jobs_" } }); const base = recordingRegistrySnapshot();
  for (const [mode, publicSchemaExists, events] of [["reopen", true, ["callback", "registry", "lock", "catalogue", "finalRegistry"]], ["reopen", false, ["callback", "registry", "lock", "catalogue", "finalRegistry"]], ["create", true, ["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]], ["create", false, ["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]]] as const) {
    const finalRaw = { ...base, publicSchemaExists, state: { ...base.state, rows: [...base.state.rows, { storeKey: archive.storeKey, contract: archive.contract, formatVersion: "1", ownedSchema: archive.ownedScope.schema, tablePrefix: archive.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(archive), modelHash: "sha256:" + "1".repeat(64), createdAtEpochMicroseconds: "0" }] } }; const local = recordingProvider(), record = recordingCapability(mode, 63n, undefined, undefined, finalRaw); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"); expect(record.events).toEqual([...events]); expect(providerEffects).toBe(0); if (mode === "reopen") { expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); } else { expect(record.created).toHaveLength(1); expect(record.inserted).toHaveLength(1); }
  }
});
test("B3 initial Registry fences reject raw malformed, identity, ownership, and absent-public states before locking", async () => {
  const base = recordingRegistrySnapshot(), current = base.state.rows[0]!; const archive = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "archive", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_jobs_" } }); const disjointArchive = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "archive-disjoint", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_a_" } }); const off = { storeKey: archive.storeKey, contract: archive.contract, formatVersion: "1", ownedSchema: "public", tablePrefix: "osnova_td_jobs_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(archive), modelHash: "sha256:" + "1".repeat(64), createdAtEpochMicroseconds: "0" }; const disjointOff = { ...off, storeKey: disjointArchive.storeKey, ownedSchema: disjointArchive.ownedScope.schema, tablePrefix: disjointArchive.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(disjointArchive) };
  const cases: readonly [unknown, OrmOwnedStoreAdmissionError["code"]][] = [[{ ...base, state: { ...base.state, shape: { ...base.state.shape, columns: [] } } }, "ORM_OWNED_STORE_DRIFT"], [{ ...base, state: { ...base.state, rows: [{ ...current, createdAtEpochMicroseconds: "01" }] } }, "ORM_OWNED_STORE_DRIFT"], [{ ...base, state: { ...base.state, rows: [current, { ...disjointOff, createdAtEpochMicroseconds: "01" }] } }, "ORM_OWNED_STORE_DRIFT"], [{ ...base, state: { ...base.state, rows: [{ ...current, ownedScopeHash: "sha256:" + "1".repeat(64) }] } }, "ORM_OWNED_STORE_DRIFT"], [{ ...base, state: { ...base.state, rows: [{ ...current, modelHash: "sha256:" + "1".repeat(64) }] } }, "ORM_OWNED_STORE_IDENTITY_MISMATCH"], [{ ...base, state: { ...base.state, rows: [current, current] } }, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"], [{ ...base, state: { ...base.state, rows: [current, off] } }, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"], [{ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: false, state: { kind: "absent" } }, "ORM_OWNED_STORE_CREATE_FAILED"]];
  for (const [raw, code] of cases) { const local = recordingProvider(), record = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, raw); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), code); expect(record.events).toEqual(["callback", "registry"]); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0); }
});
test("B3 initial Registry read errors and recomputed current identity changes stop before locking", async () => {
  const changedScope = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_wx_" } }); const changedFormat = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 2, ownedScope: { schema: "public", tablePrefix: "osnova_td_" } }); const base = recordingRegistrySnapshot(), current = base.state.rows[0]!;
  for (const row of [{ ...current, ownedSchema: changedScope.ownedScope.schema, tablePrefix: changedScope.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(changedScope) }, { ...current, formatVersion: "2", ownedScopeHash: canonicalOwnedStoreScopeHashV1(changedFormat) }]) { const local = recordingProvider(), record = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, { ...base, state: { ...base.state, rows: [row] } }); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); expect(record.events).toEqual(["callback", "registry"]); }
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("initial proxy"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } }); for (const error of [new Error("initial raw"), proxy]) { const local = recordingProvider(), record = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, undefined, error); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(record.events).toEqual(["callback", "registry"]); } expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 Catalogue phase classifies public status, inbound ownership, and missing identity before mutation", async () => {
  const registry = recordingRegistrySnapshot(), emptyRegistry = { ...registry, state: { ...registry.state, rows: [] } }, catalogue = recordingCatalogSnapshot(); const inbound = { ...catalogue, constraints: [...catalogue.constraints, { ...recordingPrimaryKey(), oid: "90", relationOid: "91", referencedRelationOid: "10", name: "inbound", kind: "foreignKey" as const, columns: ["id"], referencedColumns: ["id"], backingIndexOid: "12", onDelete: "noAction", onUpdate: "noAction", match: "simple" }] };
  const cases: readonly [unknown, unknown, OrmOwnedStoreAdmissionError["code"]][] = [[{ ...registry, publicSchemaExists: false }, catalogue, "ORM_OWNED_STORE_DRIFT"], [{ ...registry, publicSchemaExists: false }, inbound, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"], [emptyRegistry, catalogue, "ORM_OWNED_STORE_IDENTITY_MISSING"]];
  for (const [initial, currentCatalogue, code] of cases) { const local = recordingProvider(), record = recordingCapability("reopen", 63n, undefined, undefined, undefined, undefined, initial, undefined, currentCatalogue); registerPostgresOwnedStoreCapability(local, record.capability); await admissionError(() => admitOwnedStoresV1(local, request()), code); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue"]); expect(record.created).toEqual([]); expect(record.inserted).toEqual([]); expect(providerEffects).toBe(0); }
});
test("B3 snapshots mutable caller request data before capability work", async () => {
  const mutableTable = { ...expected.tables[0]!, columns: [...expected.tables[0]!.columns], primaryKey: { ...expected.tables[0]!.primaryKey, columns: [...expected.tables[0]!.primaryKey.columns] }, indexes: [], foreignKeys: [], checks: [] }; const mutableExpected = { tables: [mutableTable] }; const mutableDefinition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_" } }); const held = { definition, expected: mutableExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, mutableExpected) as `sha256:${string}` }; const heldStores = [held]; const mutableRequest: { stores: typeof held[] } = { stores: heldStores }; const local = recordingProvider(), record = recordingCapability("create"); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { heldStores.splice(0); mutableRequest.stores = []; held.definition = mutableDefinition; held.ownedScopeHash = "sha256:" + "1".repeat(64) as `sha256:${string}`; held.modelHash = "sha256:" + "2".repeat(64) as `sha256:${string}`; mutableExpected.tables.splice(0); mutableTable.table = "osnova_td_mutated"; mutableTable.columns.splice(0); mutableTable.columns = []; return record.capability.withOwnedStoreAdmission(signal, work); } }); const receipt = await admitOwnedStoresV1(local, mutableRequest); expect(record.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]); expect(record.created).toEqual([[{ kind: "createTable", table: expected.tables[0]! }]]); expect(record.inserted).toEqual([[{ storeKey: definition.storeKey, contract: definition.contract, formatVersion: definition.formatVersion, ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }]]); const operation = record.created[0]![0]; if (!operation || operation.kind !== "createTable") throw new Error("missing snapshot table create"); expect(operation.table).not.toBe(mutableTable); const storePreimage = canonicalOwnedStoreStoreLockPreimageV1(definition), scopePreimage = canonicalOwnedStoreScopeLockPreimageV1(definition.ownedScope); expect(record.plans[0]!.stores.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key }))).toEqual([{ kind: "store", preimage: storePreimage.toString("hex"), key: ownedStoreAdvisoryLockV1(storePreimage) }]); expect(record.plans[0]!.scopes.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key }))).toEqual([{ kind: "scope", preimage: scopePreimage.toString("hex"), key: ownedStoreAdvisoryLockV1(scopePreimage) }]); const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(1); leases[0]!.revoke(); expect(mutableDefinition).not.toBe(definition); expect(providerEffects).toBe(0);
});
test("B3 hostile request envelopes reject before fresh capability entry without invoking hooks", async () => {
  const valid = request(), original = valid.stores[0]!;
  const cases: { readonly name: string; readonly input: unknown; readonly hooks: () => readonly number[]; }[] = [];
  const trapped = (value: object) => { const hooks: [number, number, number, number] = [0, 0, 0, 0]; return { proxy: new Proxy(value, { get() { hooks[0]++; throw new Error("hook"); }, getPrototypeOf() { hooks[1]++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks[2]++; throw new Error("hook"); }, ownKeys() { hooks[3]++; throw new Error("hook"); } }), hooks: () => hooks }; };
  const revoked = (value: object) => { const hooks: [number, number, number, number] = [0, 0, 0, 0], proxy = Proxy.revocable(value, { get() { hooks[0]++; throw new Error("hook"); }, getPrototypeOf() { hooks[1]++; throw new Error("hook"); }, getOwnPropertyDescriptor() { hooks[2]++; throw new Error("hook"); }, ownKeys() { hooks[3]++; throw new Error("hook"); } }); proxy.revoke(); return { proxy: proxy.proxy, hooks: () => hooks }; };
  const rootProxy = trapped(valid); cases.push({ name: "root proxy", input: rootProxy.proxy, hooks: rootProxy.hooks });
  const revokedRoot = revoked(valid); cases.push({ name: "root revoked", input: revokedRoot.proxy, hooks: revokedRoot.hooks });
  { let calls = 0; const input = {}; Object.defineProperty(input, "stores", { enumerable: true, get() { calls++; return valid.stores; } }); cases.push({ name: "root stores accessor", input, hooks: () => [calls] }); }
  cases.push({ name: "root unknown", input: { ...valid, extra: true }, hooks: () => [] });
  cases.push({ name: "root symbol", input: Object.assign({ ...valid }, { [Symbol("x")]: true }), hooks: () => [] });
  cases.push({ name: "root boxed", input: new Number(1), hooks: () => [] });
  cases.push({ name: "root nonplain", input: Object.assign(Object.create({}), valid), hooks: () => [] });
  const storesProxy = trapped(valid.stores); cases.push({ name: "stores proxy", input: { stores: storesProxy.proxy }, hooks: storesProxy.hooks });
  const revokedStores = revoked(valid.stores); cases.push({ name: "stores revoked", input: { stores: revokedStores.proxy }, hooks: revokedStores.hooks });
  const sparse: unknown[] = []; sparse.length = 1; cases.push({ name: "stores sparse", input: { stores: sparse }, hooks: () => [] });
  { let calls = 0; const stores: unknown[] = []; Object.defineProperty(stores, "0", { enumerable: true, get() { calls++; return original; } }); stores.length = 1; cases.push({ name: "stores index accessor", input: { stores }, hooks: () => [calls] }); }
  cases.push({ name: "stores symbol", input: { stores: Object.assign([...valid.stores], { [Symbol("x")]: true }) }, hooks: () => [] });
  cases.push({ name: "stores extended", input: { stores: Object.assign([...valid.stores], { extra: true }) }, hooks: () => [] });
  const itemProxy = trapped(original); cases.push({ name: "item proxy", input: { stores: [itemProxy.proxy] }, hooks: itemProxy.hooks });
  const revokedItem = revoked(original); cases.push({ name: "item revoked", input: { stores: [revokedItem.proxy] }, hooks: revokedItem.hooks });
  for (const key of ["definition", "expected"] as const) { let calls = 0; const item = { ...original }; Object.defineProperty(item, key, { enumerable: true, get() { calls++; return original[key]; } }); cases.push({ name: `item ${key} accessor`, input: { stores: [item] }, hooks: () => [calls] }); }
  cases.push({ name: "item unknown", input: { stores: [{ ...original, extra: true }] }, hooks: () => [] });
  cases.push({ name: "item symbol", input: { stores: [Object.assign({ ...original }, { [Symbol("x")]: true })] }, hooks: () => [] });
  cases.push({ name: "item nonplain", input: { stores: [Object.assign(Object.create({}), original)] }, hooks: () => [] });
  { let coercions = 0; const hash = { valueOf() { coercions++; return "x"; }, toString() { coercions++; return "x"; } }; cases.push({ name: "hash coercion", input: { stores: [{ ...original, modelHash: hash }] }, hooks: () => [coercions] }); }
  { let coercions = 0; const hash = new String(original.modelHash); Object.defineProperties(hash, { valueOf: { value() { coercions++; return original.modelHash; } }, toString: { value() { coercions++; return original.modelHash; } } }); cases.push({ name: "hash boxed String", input: { stores: [{ ...original, modelHash: hash }] }, hooks: () => [coercions] }); }
  for (const item of cases) { const local = recordingProvider(); let entries = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { entries++; throw new Error("unexpected"); } }); await admissionError(() => admitOwnedStoresV1(local, item.input as OwnedStoreAdmissionRequestV1), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); expect(entries, item.name).toBe(0); const hooks = item.hooks(); expect(hooks, item.name).toEqual(hooks.map(() => 0)); }
});
test("B3 repeats the exact UTF-8 semantic secondary lock plan before an operational Catalogue failure", async () => {
  const reject = { schema: "public", tablePrefix: "legacy_" } as const;
  const bmp = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "bmp", formatVersion: 1, ownedScope: { schema: "a", tablePrefix: "\uE000_long_" }, rejectIfPresent: [reject] });
  const astral = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "astral", formatVersion: 1, ownedScope: { schema: "a", tablePrefix: "\u{10000}_" }, rejectIfPresent: [reject] });
  const offgraph = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "archive", formatVersion: 1, ownedScope: { schema: "a.b", tablePrefix: "a_" } });
  const unicodeExpected = (prefix: string): OrmExpectedSchema => Object.freeze({ tables: Object.freeze([Object.freeze({ ...expected.tables[0]!, schema: "a", table: `${prefix}jobs`, primaryKey: Object.freeze({ name: `pk_${prefix}jobs`, columns: Object.freeze(["id"]) }) })]) });
  const bmpExpected = unicodeExpected(bmp.ownedScope.tablePrefix), astralExpected = unicodeExpected(astral.ownedScope.tablePrefix);
  const input: OwnedStoreAdmissionRequestV1 = Object.freeze({ stores: Object.freeze([
    Object.freeze({ definition: astral, expected: astralExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(astral) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(astral, astralExpected) as `sha256:${string}` }),
    Object.freeze({ definition: bmp, expected: bmpExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(bmp) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(bmp, bmpExpected) as `sha256:${string}` }),
  ]) });
  const context = Object.freeze({ maxIdentifierLength: 63n });
  const registryRaw = { ...recordingRegistrySnapshot(), state: { ...recordingRegistrySnapshot().state, rows: [{ storeKey: offgraph.storeKey, contract: offgraph.contract, formatVersion: "1", ownedSchema: offgraph.ownedScope.schema, tablePrefix: offgraph.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(offgraph), modelHash: "sha256:" + "1".repeat(64), createdAtEpochMicroseconds: "0" }] } };
  const registry = parseOwnedStoreRegistrySnapshotV1(registryRaw, [bmp, astral], context);
  const events: string[] = [], plans: OwnedStoreSecondaryLockPlanV1[] = [], catalogueScopes: { readonly schema: string; readonly tablePrefix: string; }[][] = [], mutations: string[] = [];
  let contextReads = 0;
  const secondary: SecondaryLockedOwnedStoreSessionV1 = Object.freeze({ async inspectCatalog(scopes: readonly { readonly schema: string; readonly tablePrefix: string; }[]) { events.push("catalogue"); catalogueScopes.push([...scopes]); throw new Error("catalogue observation stop"); }, async createRegistryV1() { mutations.push("createRegistry"); }, async applyCreateOperations() { mutations.push("create"); }, async insertIdentities() { mutations.push("insert"); }, async inspectRegistry() { mutations.push("finalRegistry"); return registry; } });
  const locked: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ get maxIdentifierLength() { contextReads++; return 63n; }, async inspectRegistry() { events.push("registry"); return registry; }, async lockSecondary(plan: OwnedStoreSecondaryLockPlanV1) { events.push("lock"); plans.push(plan); return secondary; } });
  const local = recordingProvider(); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("callback"); return work(locked); } });
  for (let attempt = 0; attempt < 2; attempt++) await admissionError(() => admitOwnedStoresV1(local, input), "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  const orderedDefinitions = [bmp, astral, offgraph];
  const orderedScopes = [bmp.ownedScope, astral.ownedScope, offgraph.ownedScope, reject];
  const entryView = (kind: "store" | "scope", preimages: readonly Uint8Array[]) => preimages.map(preimage => ({ kind, preimage: Buffer.from(preimage).toString("hex"), key: ownedStoreAdvisoryLockV1(preimage) }));
  const plansView = plans.map(plan => ({ stores: plan.stores.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key })), scopes: plan.scopes.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key })) }));
  const expectedPlan = { stores: entryView("store", orderedDefinitions.map(canonicalOwnedStoreStoreLockPreimageV1)), scopes: entryView("scope", orderedScopes.map(canonicalOwnedStoreScopeLockPreimageV1)) };
  expect(events).toEqual(["callback", "registry", "lock", "catalogue", "callback", "registry", "lock", "catalogue"]); expect(contextReads).toBe(2); expect(plansView).toEqual([expectedPlan, expectedPlan]); expect(Buffer.from(plans[0]!.stores[0]!.preimage).equals(Buffer.from(plans[1]!.stores[0]!.preimage))).toBe(true); expect(Buffer.from(plans[0]!.scopes[0]!.preimage).equals(Buffer.from(plans[1]!.scopes[0]!.preimage))).toBe(true);
  expect(catalogueScopes).toEqual([[bmp.ownedScope, astral.ownedScope, reject], [bmp.ownedScope, astral.ownedScope, reject]]); expect(mutations).toEqual([]); expect(providerEffects).toBe(0);
  for (const plan of plans) { expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.stores)).toBe(true); expect(Object.isFrozen(plan.scopes)).toBe(true); expect(plan.stores.every(Object.isFrozen)).toBe(true); expect(plan.scopes.every(Object.isFrozen)).toBe(true); }
});

function recordingTwoStores() {
  const other = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures-b", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_b_" } });
  const otherBase = table("osnova_b_jobs", [column("id", "integer")], ["id"]); const otherExpected = schema({ ...otherBase, primaryKey: { name: "pk_b_jobs", columns: ["id"] } });
  const first = recordingCatalogSnapshot(); const source = recordingCatalogSnapshot();
  const remap = new Map([["10", "110"], ["11", "111"], ["12", "112"], ["15", "115"], ["16", "116"]]); const oid = (value: string) => remap.get(value) ?? value;
  const second = { ...source, relations: source.relations.map(relation => ({ ...relation, oid: oid(relation.oid), name: relation.kind === "ordinaryTable" ? "osnova_b_jobs" : "pk_b_jobs", rowTypeOid: relation.rowTypeOid === null ? null : oid(relation.rowTypeOid) })), rowTypes: source.rowTypes.map(row => ({ ...row, oid: oid(row.oid), relationOid: oid(row.relationOid), name: "osnova_b_jobs", arrayTypeOid: oid(row.arrayTypeOid) })), arrayTypes: source.arrayTypes.map(row => ({ ...row, oid: oid(row.oid), elementTypeOid: oid(row.elementTypeOid), name: "_osnova_b_jobs" })), columns: source.columns.map(item => ({ ...item, relationOid: oid(item.relationOid) })), indexes: source.indexes.map(item => ({ ...item, indexRelationOid: oid(item.indexRelationOid), tableRelationOid: oid(item.tableRelationOid), name: "pk_b_jobs", backingConstraintOid: item.backingConstraintOid === null ? null : oid(item.backingConstraintOid) })), constraints: source.constraints.map(item => ({ ...item, oid: oid(item.oid), relationOid: oid(item.relationOid), name: "pk_b_jobs", backingIndexOid: item.backingIndexOid === null ? null : oid(item.backingIndexOid) })), dependencies: source.dependencies.map(item => ({ ...item, dependentOid: oid(item.dependentOid), referencedOid: item.referencedClassOid === "5" ? item.referencedOid : oid(item.referencedOid) })) };
  const scopes = [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }];
  const catalogue = { ...first, requestedScopes: scopes, relations: [...first.relations, ...second.relations], rowTypes: [...first.rowTypes, ...second.rowTypes], arrayTypes: [...first.arrayTypes, ...second.arrayTypes], columns: [...first.columns, ...second.columns], indexes: [...first.indexes, ...second.indexes], constraints: [...first.constraints, ...second.constraints], dependencies: [...first.dependencies, ...second.dependencies] };
  const base = recordingRegistrySnapshot();
  const registry = { ...base, state: { ...base.state, rows: [{ storeKey: other.storeKey, contract: other.contract, formatVersion: "1", ownedSchema: "public", tablePrefix: "osnova_b_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(other), modelHash: canonicalOwnedStoreModelHashV1(other, otherExpected), createdAtEpochMicroseconds: "0" }, ...(base.state.rows as readonly unknown[])] } };
  return { other, otherExpected, catalogue, registry, scopes };
}
test("B1/B2 recording two-store graph preflights as one shared-schema current Registry", () => {
  const fixture = recordingTwoStores(), context = Object.freeze({ maxIdentifierLength: 63n });
  const registry = parseOwnedStoreRegistrySnapshotV1(fixture.registry, [definition, fixture.other], context); const catalogue = parseOwnedStoreCatalogSnapshotV1(fixture.catalogue, context);
  const semantic = { stores: [{ definition, expectedSchema: expected }, { definition: fixture.other, expectedSchema: fixture.otherExpected }], requestedScopes: fixture.scopes };
  expect(() => verifyOwnedStoreCatalogAllV1(catalogue, semantic)).not.toThrow(); expect(inspectOwnedStoreCatalogPreCreateV1(catalogue, registry, semantic)).toEqual({ kind: "ready", emptyMissingIdentityStoreKeys: [] });
});

function recordingTwoStoreCapability(mode: "reopen" | "mixed" | "allMissing" = "reopen", offgraph = false, mixedInitialCatalogueRaw?: unknown, mixedPostCatalogueRaw?: unknown, mixedPostCatalogueFailure?: unknown) {
  const fixture = recordingTwoStores(), context = Object.freeze({ maxIdentifierLength: 63n }); const events: string[] = []; const plans: OwnedStoreSecondaryLockPlanV1[] = []; const scopes: { readonly schema: string; readonly tablePrefix: string; }[][] = []; const creates: OwnedStoreCreateOperationV1[][] = []; const inserts: OwnedStoreIdentityInsertV1[][] = [];
  const offDefinition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "archive", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_a_" } });
  const offRow = { storeKey: offDefinition.storeKey, contract: offDefinition.contract, formatVersion: "1", ownedSchema: "public", tablePrefix: "osnova_a_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(offDefinition), modelHash: "sha256:" + "1".repeat(64), createdAtEpochMicroseconds: "0" };
  const completeRaw = offgraph ? { ...fixture.registry, state: { ...fixture.registry.state, rows: [offRow, ...fixture.registry.state.rows] } } : fixture.registry;
  const existingRaw = recordingRegistrySnapshot();
  const registry = parseOwnedStoreRegistrySnapshotV1(completeRaw, [definition, fixture.other], context); const existingRegistry = parseOwnedStoreRegistrySnapshotV1(existingRaw, [definition, fixture.other], context); const emptyRegistry = parseOwnedStoreRegistrySnapshotV1({ ...fixture.registry, state: { ...fixture.registry.state, rows: [] } }, [definition, fixture.other], context); const catalogue = parseOwnedStoreCatalogSnapshotV1(mixedPostCatalogueRaw ?? fixture.catalogue, context); const existingCatalogue = parseOwnedStoreCatalogSnapshotV1(mixedInitialCatalogueRaw ?? { ...recordingCatalogSnapshot(), requestedScopes: fixture.scopes }, context); const emptyCatalogue = parseOwnedStoreCatalogSnapshotV1({ ...recordingCatalogSnapshot(), requestedScopes: fixture.scopes, relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], dependencies: [] }, context); let catalogueReads = 0;
  const secondary: SecondaryLockedOwnedStoreSessionV1 = Object.freeze({ async inspectCatalog(requested: readonly { readonly schema: string; readonly tablePrefix: string; }[]) { events.push("catalogue"); scopes.push([...requested]); if (mode === "mixed" && catalogueReads++ === 0) return existingCatalogue; if (mode === "mixed" && mixedPostCatalogueFailure !== undefined) throw mixedPostCatalogueFailure; if (mode === "allMissing" && catalogueReads++ === 0) return emptyCatalogue; return catalogue; }, async createRegistryV1() { events.push("createRegistry"); }, async applyCreateOperations(operations: readonly OwnedStoreCreateOperationV1[]) { events.push("create"); creates.push([...operations]); }, async insertIdentities(rows: readonly OwnedStoreIdentityInsertV1[]) { events.push("insert"); inserts.push([...rows]); }, async inspectRegistry() { events.push("finalRegistry"); return registry; } });
  const locked: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ maxIdentifierLength: 63n, async inspectRegistry() { events.push("registry"); return mode === "mixed" ? existingRegistry : mode === "allMissing" ? emptyRegistry : registry; }, async lockSecondary(plan: OwnedStoreSecondaryLockPlanV1) { events.push("lock"); plans.push(plan); return secondary; } });
  return { fixture, offDefinition, events, plans, scopes, creates, inserts, capability: { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("callback"); return work(locked); } } };
}
test("B3 two-store reopen holds one union lock and publishes graph-isolated leases", async () => {
  const local = recordingProvider(), one = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, one.capability); const oneReceipt = await admitOwnedStoresV1(local, request());
  const two = recordingTwoStoreCapability(); registerPostgresOwnedStoreCapability(local, two.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` },
    { definition: two.fixture.other, expected: two.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(two.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(two.fixture.other, two.fixture.otherExpected) as `sha256:${string}` },
  ] };
  const twoReceipt = await admitOwnedStoresV1(local, input); expect(two.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(two.plans).toHaveLength(1); expect(two.plans[0]!.stores).toHaveLength(2); expect(two.plans[0]!.scopes).toHaveLength(2); expect(two.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]); expect(two.creates).toEqual([]); expect(two.inserts).toEqual([]);
  const firstLeases = publishOwnedStoreAdmissionV1(local, oneReceipt); const secondLeases = publishOwnedStoreAdmissionV1(local, twoReceipt); expect(firstLeases).toHaveLength(1); expect(secondLeases).toHaveLength(2); const first = firstLeases[0], second = secondLeases[0], third = secondLeases[1]; if (!first || !second || !third) throw new Error("missing lease"); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(second)).toBe(true); expect(Object.isFrozen(third)).toBe(true); expect(first.active).toBe(true); expect(second.active).toBe(true); expect(third.active).toBe(true); first.revoke(); expect(first.active).toBe(false); expect(second.active).toBe(true); expect(third.active).toBe(true);
});

test("B3 two-store reopen locks a valid unrelated Registry row without cataloguing its scope", async () => {
  const local = recordingProvider(), recorded = recordingTwoStoreCapability("reopen", true); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` },
    { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` },
  ] };
  const receipt = await admitOwnedStoresV1(local, input); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.plans).toHaveLength(1);
  const plan = recorded.plans[0]!;
  const definitions = [recorded.offDefinition, recorded.fixture.other, definition];
  const scopes = definitions.map(item => item.ownedScope);
  const expectedEntries = (kind: "store" | "scope", preimages: readonly Uint8Array[]) => preimages.map(preimage => ({ kind, preimage: Buffer.from(preimage).toString("hex"), key: ownedStoreAdvisoryLockV1(preimage) }));
  expect(plan.stores.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key }))).toEqual(expectedEntries("store", definitions.map(canonicalOwnedStoreStoreLockPreimageV1)));
  expect(plan.scopes.map(entry => ({ kind: entry.kind, preimage: Buffer.from(entry.preimage).toString("hex"), key: entry.key }))).toEqual(expectedEntries("scope", scopes.map(canonicalOwnedStoreScopeLockPreimageV1)));
  expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]);
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(2); for (const lease of leases) lease.revoke(); expect(leases.every(lease => !lease.active)).toBe(true);
});

test("B3 two-store mixed create mutates only the absent store and records its identity", async () => {
  const local = recordingProvider(), recorded = recordingTwoStoreCapability("mixed"); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` },
    { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` },
  ] };
  const receipt = await admitOwnedStoresV1(local, input); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]); expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }], [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]);
  expect(recorded.creates).toHaveLength(1); expect(recorded.creates[0]!).toHaveLength(1); const operation = recorded.creates[0]![0], secondTable = recorded.fixture.otherExpected.tables[0]; if (!operation || operation.kind !== "createTable" || !secondTable) throw new Error("missing second-store table create"); expect(operation.table).toEqual(secondTable);
  expect(recorded.inserts).toEqual([[{ storeKey: recorded.fixture.other.storeKey, contract: "osnova.orm-owned-store/v1", formatVersion: 1, ownedSchema: "public", tablePrefix: "osnova_b_", ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` }]]);
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(2); for (const lease of leases) lease.revoke(); expect(leases.every(lease => !lease.active)).toBe(true);
});
test("B3 mixed two-store pre-create rejects existing A drift before creating missing B", async () => {
  const raw = recordingCatalogSnapshot(); const damaged = { ...raw, requestedScopes: [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }], columns: raw.columns.map(column => ({ ...column, notNull: false })) }; const local = recordingProvider(), recorded = recordingTwoStoreCapability("mixed", false, damaged); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [{ definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }, { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` }] };
  await admissionError(() => admitOwnedStoresV1(local, input), "ORM_OWNED_STORE_DRIFT"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue"]); expect(recorded.creates).toEqual([]); expect(recorded.inserts).toEqual([]); expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]); expect(recorded.plans[0]!.stores).toHaveLength(2); expect(providerEffects).toBe(0);
});
test("B3 mixed two-store rechecks pre-existing A after creating B", async () => {
  const fixture = recordingTwoStores(), damagedPost = { ...fixture.catalogue, columns: fixture.catalogue.columns.map(column => column.relationOid === "10" ? { ...column, notNull: false } : column) }; const local = recordingProvider(), recorded = recordingTwoStoreCapability("mixed", false, undefined, damagedPost); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [{ definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }, { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` }] };
  await admissionError(() => admitOwnedStoresV1(local, input), "ORM_OWNED_STORE_CREATE_FAILED"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue"]); expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }], [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]); expect(recorded.creates).toEqual([[{ kind: "createTable", table: recorded.fixture.otherExpected.tables[0]! }]]); expect(recorded.inserts).toEqual([]); expect(providerEffects).toBe(0);
});
test("B3 mixed post-Catalogue inbound and read failures stop after B-only create", async () => {
  const fixture = recordingTwoStores(), inbound = { ...fixture.catalogue, constraints: [...fixture.catalogue.constraints, { ...recordingPrimaryKey(), oid: "90", relationOid: "91", referencedRelationOid: "10", name: "inbound", kind: "foreignKey" as const, columns: ["id"], referencedColumns: ["id"], backingIndexOid: "12", onDelete: "noAction", onUpdate: "noAction", match: "simple" }] }; let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("post proxy"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const [postRaw, postFailure, code] of [[inbound, undefined, "ORM_OWNED_STORE_OWNERSHIP_CONFLICT"], [undefined, new Error("post raw"), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"], [undefined, proxy, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const) { const local = recordingProvider(), recorded = recordingTwoStoreCapability("mixed", false, undefined, postRaw, postFailure); registerPostgresOwnedStoreCapability(local, recorded.capability); const input: OwnedStoreAdmissionRequestV1 = { stores: [{ definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }, { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` }] }; await admissionError(() => admitOwnedStoresV1(local, input), code); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue"]); expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }], [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]); expect(recorded.creates).toEqual([[{ kind: "createTable", table: recorded.fixture.otherExpected.tables[0]! }]]); expect(recorded.inserts).toEqual([]); expect(providerEffects).toBe(0); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});

test("B3 two-store all-missing create sorts tables and identity rows independently", async () => {
  const local = recordingProvider(), recorded = recordingTwoStoreCapability("allMissing"); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const input: OwnedStoreAdmissionRequestV1 = { stores: [
    { definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` },
    { definition: recorded.fixture.other, expected: recorded.fixture.otherExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` },
  ] };
  const receipt = await admitOwnedStoresV1(local, input); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "create", "catalogue", "insert", "finalRegistry"]); expect(recorded.scopes).toEqual([[{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }], [{ schema: "public", tablePrefix: "osnova_b_" }, { schema: "public", tablePrefix: "osnova_td_" }]]);
  expect(recorded.creates).toEqual([[{ kind: "createTable", table: recorded.fixture.otherExpected.tables[0]! }, { kind: "createTable", table: expected.tables[0]! }]]);
  expect(recorded.inserts).toEqual([[{ storeKey: definition.storeKey, contract: definition.contract, formatVersion: definition.formatVersion, ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }, { storeKey: recorded.fixture.other.storeKey, contract: recorded.fixture.other.contract, formatVersion: recorded.fixture.other.formatVersion, ownedSchema: recorded.fixture.other.ownedScope.schema, tablePrefix: recorded.fixture.other.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(recorded.fixture.other) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(recorded.fixture.other, recorded.fixture.otherExpected) as `sha256:${string}` }]]);
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(2); for (const lease of leases) lease.revoke(); expect(leases.every(lease => !lease.active)).toBe(true);
});

function recordingAbsentRegistryCapability(createRegistryFailure?: unknown, registryRereadRaw?: unknown, registryRereadFailure?: unknown) {
  const events: string[] = [], created: OwnedStoreCreateOperationV1[][] = [], inserted: OwnedStoreIdentityInsertV1[][] = []; const context = Object.freeze({ maxIdentifierLength: 63n });
  const presentRaw = recordingRegistrySnapshot(), absent = parseOwnedStoreRegistrySnapshotV1({ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "absent" } }, [definition], context);
  const emptyPresent = parseOwnedStoreRegistrySnapshotV1({ ...presentRaw, state: { ...presentRaw.state, rows: [] } }, [definition], context); const present = parseOwnedStoreRegistrySnapshotV1(presentRaw, [definition], context);
  const emptyCatalogue = parseOwnedStoreCatalogSnapshotV1({ ...recordingCatalogSnapshot(), relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], dependencies: [] }, context); const fullCatalogue = parseOwnedStoreCatalogSnapshotV1(recordingCatalogSnapshot(), context); let catalogueReads = 0, registryReads = 0;
  const secondary: SecondaryLockedOwnedStoreSessionV1 = Object.freeze({
    async inspectCatalog() { events.push("catalogue"); return catalogueReads++ === 0 ? emptyCatalogue : fullCatalogue; }, async createRegistryV1() { events.push("createRegistry"); if (createRegistryFailure !== undefined) throw createRegistryFailure; }, async applyCreateOperations(operations: readonly OwnedStoreCreateOperationV1[]) { events.push("create"); created.push([...operations]); }, async insertIdentities(rows: readonly OwnedStoreIdentityInsertV1[]) { events.push("insert"); inserted.push([...rows]); }, async inspectRegistry() { events.push(registryReads++ === 0 ? "registryReread" : "finalRegistry"); if (registryReads === 1 && registryRereadFailure !== undefined) throw registryRereadFailure; return registryReads === 1 ? registryRereadRaw === undefined ? emptyPresent : registryRereadRaw as ReturnType<typeof parseOwnedStoreRegistrySnapshotV1> : present; },
  });
  const locked: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ maxIdentifierLength: 63n, async inspectRegistry() { events.push("registry"); return absent; }, async lockSecondary() { events.push("lock"); return secondary; } });
  return { events, created, inserted, capability: { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("callback"); return work(locked); } } };
}

test("B3 Registry-absent create records the empty Registry reread before the missing-store create", async () => {
  const local = recordingProvider(), recorded = recordingAbsentRegistryCapability(); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const receipt = await admitOwnedStoresV1(local, request());
  expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "createRegistry", "registryReread", "create", "catalogue", "insert", "finalRegistry"]);
  expect(recorded.created).toEqual([[{ kind: "createTable", table: expected.tables[0]! }]]);
  expect(recorded.inserted).toEqual([[{ storeKey: definition.storeKey, contract: definition.contract, formatVersion: definition.formatVersion, ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }]]);
  const leases = publishOwnedStoreAdmissionV1(local, receipt); expect(leases).toHaveLength(1); const lease = leases[0]; if (!lease) throw new Error("missing absent-Registry lease"); lease.revoke(); expect(lease.active).toBe(false);
});
test("B3 created Registry reread must be exact present-empty before store creation", async () => {
  const base = recordingRegistrySnapshot(); const cases: readonly unknown[] = [{ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists: true, state: { kind: "absent" } }, base, { ...base, state: { ...base.state, rows: [], shape: { ...base.state.shape, columns: [] } } }];
  for (const reread of cases) { const local = recordingProvider(), recorded = recordingAbsentRegistryCapability(undefined, reread); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "createRegistry", "registryReread"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(providerEffects).toBe(0); }
});
test("B3 created Registry reread raw and proxy failures are operational lock failures", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("reread proxy"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const failureValue of [new Error("reread raw"), proxy]) { const local = recordingProvider(), recorded = recordingAbsentRegistryCapability(undefined, undefined, failureValue); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "createRegistry", "registryReread"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(providerEffects).toBe(0); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
test("B3 createRegistryV1 rejection maps safe, raw, and proxy errors to CREATE_FAILED before reread", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(new Error("proxy registry marker"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } });
  for (const thrown of [...safeAdmissionCodes.map(code => failure(code)), new Error("raw registry marker"), proxy]) { const local = recordingProvider(), recorded = recordingAbsentRegistryCapability(thrown); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_CREATE_FAILED"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "createRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(providerEffects).toBe(0); }
  expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});

function globalCreatePlanFixture(alphaExists = true) {
  const alpha = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "stage-alpha", formatVersion: 1, ownedScope: { schema: "alpha", tablePrefix: "osnova_a_" } }); const beta = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "stage-beta", formatVersion: 1, ownedScope: { schema: "beta", tablePrefix: "osnova_b_" } });
  const index = (name: string, columns: readonly string[]) => ({ name, columns, unique: false, method: "btree" as const }); const foreignKey = (name: string, schema: string, table: string) => ({ name, columns: ["parent_id"], target: { schema, table }, targetColumns: ["id"], onDelete: "cascade" as const, onUpdate: "noAction" as const });
  const alphaParent = { ...table("osnova_a_parent", [column("id", "integer")]), schema: "alpha" }; const alphaChild = { ...table("osnova_a_child", [column("id", "integer"), column("parent_id", "integer")], ["id"], { indexes: [index("a_idx", ["parent_id"]), index("Z_idx", ["parent_id"])], foreignKeys: [foreignKey("a_fk", "alpha", "osnova_a_parent"), foreignKey("Z_fk", "alpha", "osnova_a_parent")] }), schema: "alpha" };
  const betaParent = { ...table("osnova_b_parent", [column("id", "integer")]), schema: "beta" }; const betaChild = { ...table("osnova_b_child", [column("id", "integer"), column("parent_id", "integer")], ["id"], { indexes: [index("ix_b_child_parent", ["parent_id"])], foreignKeys: [foreignKey("fk_b_child_parent", "beta", "osnova_b_parent")] }), schema: "beta" };
  const alphaExpected = schema(alphaParent, alphaChild), betaExpected = schema(betaParent, betaChild); const scopes = [{ schema: "alpha", tablePrefix: "osnova_a_" }, { schema: "beta", tablePrefix: "osnova_b_" }];
  const registryRaw = recordingRegistrySnapshot(); const emptyRegistry = parseOwnedStoreRegistrySnapshotV1({ ...registryRaw, state: { ...registryRaw.state, rows: [] } }, [alpha, beta], Object.freeze({ maxIdentifierLength: 63n })); const emptyCatalogue = parseOwnedStoreCatalogSnapshotV1({ ...recordingCatalogSnapshot(), requestedScopes: scopes, existingSchemas: alphaExists ? ["alpha"] : [], relations: [], rowTypes: [], arrayTypes: [], columns: [], indexes: [], constraints: [], dependencies: [] }, Object.freeze({ maxIdentifierLength: 63n }));
  return { alpha, beta, alphaExpected, betaExpected, emptyRegistry, emptyCatalogue };
}

test("B3 create-plan observation/rejection preserves global schema-table-FK-index stages", async () => {
  for (const [alphaExists, schemas] of [[true, ["beta"]], [false, ["alpha", "beta"]]] as const) {
    const local = recordingProvider(), fixture = globalCreatePlanFixture(alphaExists), events: string[] = [], plans: OwnedStoreCreateOperationV1[][] = [], inserts: OwnedStoreIdentityInsertV1[][] = [];
    const secondary: SecondaryLockedOwnedStoreSessionV1 = Object.freeze({ async inspectCatalog() { events.push("catalogue"); return fixture.emptyCatalogue; }, async createRegistryV1() { events.push("createRegistry"); }, async applyCreateOperations(operations: readonly OwnedStoreCreateOperationV1[]) { events.push("create"); plans.push([...operations]); throw failure("ORM_OWNED_STORE_CREATE_FAILED"); }, async insertIdentities(rows: readonly OwnedStoreIdentityInsertV1[]) { events.push("insert"); inserts.push([...rows]); }, async inspectRegistry() { events.push("finalRegistry"); return fixture.emptyRegistry; } });
    const locked: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ maxIdentifierLength: 63n, async inspectRegistry() { events.push("registry"); return fixture.emptyRegistry; }, async lockSecondary() { events.push("lock"); return secondary; } });
    registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(_signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { events.push("callback"); return work(locked); } });
    const input: OwnedStoreAdmissionRequestV1 = { stores: [
      { definition: fixture.beta, expected: fixture.betaExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(fixture.beta) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(fixture.beta, fixture.betaExpected) as `sha256:${string}` },
      { definition: fixture.alpha, expected: fixture.alphaExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(fixture.alpha) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(fixture.alpha, fixture.alphaExpected) as `sha256:${string}` },
    ] };
    await admissionError(() => admitOwnedStoresV1(local, input), "ORM_OWNED_STORE_CREATE_FAILED"); expect(events).toEqual(["callback", "registry", "lock", "catalogue", "create"]); expect(inserts).toEqual([]); expect(plans).toHaveLength(1);
    const alphaChild = fixture.alphaExpected.tables.find(table => table.table === "osnova_a_child"), alphaParent = fixture.alphaExpected.tables.find(table => table.table === "osnova_a_parent"), betaChild = fixture.betaExpected.tables.find(table => table.table === "osnova_b_child"), betaParent = fixture.betaExpected.tables.find(table => table.table === "osnova_b_parent");
    if (!alphaChild || !alphaParent || !betaChild || !betaParent) throw new Error("missing staged table"); const alphaForeignKeys = alphaChild.foreignKeys, alphaIndexes = alphaChild.indexes;
    expect(plans[0]).toEqual([
      ...schemas.map(schema => ({ kind: "createSchema" as const, schema })), { kind: "createTable" as const, table: alphaChild }, { kind: "createTable" as const, table: alphaParent }, { kind: "createTable" as const, table: betaChild }, { kind: "createTable" as const, table: betaParent },
      { kind: "addForeignKey" as const, table: alphaChild, foreignKey: alphaForeignKeys[1]! }, { kind: "addForeignKey" as const, table: alphaChild, foreignKey: alphaForeignKeys[0]! }, { kind: "addForeignKey" as const, table: betaChild, foreignKey: betaChild.foreignKeys[0]! },
      { kind: "createIndex" as const, table: alphaChild, index: alphaIndexes[1]! }, { kind: "createIndex" as const, table: alphaChild, index: alphaIndexes[0]! }, { kind: "createIndex" as const, table: betaChild, index: betaChild.indexes[0]! },
    ]);
  }
});

type CallbackWork = (session: RegistryLockedOwnedStoreSessionV1) => Promise<unknown>;
type CallbackCapability = { withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T>; };
function adversarialCallbackCapability(run: (signal: AbortSignal | undefined, work: CallbackWork, valid: CallbackCapability) => Promise<unknown>) {
  const recorded = recordingCapability("reopen"); const state = { workCalls: 0 };
  return { recorded, capability: { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> {
    const counted: CallbackWork = session => { state.workCalls++; return work(session); };
    // Deliberately adversarial generic return: this models an untrusted capability implementation.
    return await run(signal, counted, recorded.capability) as T;
  } }, get workCalls() { return state.workCalls; } };
}

test("B3 callback authenticity rejects malformed capability completion patterns", async () => {
  const forged = Object.freeze({});
  const cases: readonly { readonly name: string; readonly run: (signal: AbortSignal | undefined, work: CallbackWork, valid: CallbackCapability) => Promise<unknown>; readonly events: readonly string[]; readonly workCalls: number; }[] = [
    { name: "zero callback", async run() { return forged; }, events: [], workCalls: 0 },
    { name: "one callback then forged completion", async run(signal, work, valid) { await valid.withOwnedStoreAdmission(signal, work); return forged; }, events: ["callback", "registry", "lock", "catalogue", "finalRegistry"], workCalls: 1 },
    { name: "sequential second callback", async run(signal, work, valid) { await valid.withOwnedStoreAdmission(signal, work); return valid.withOwnedStoreAdmission(signal, work); }, events: ["callback", "registry", "lock", "catalogue", "finalRegistry", "callback"], workCalls: 2 },
    { name: "swallowed second callback rejection", async run(signal, work, valid) { const first = await valid.withOwnedStoreAdmission(signal, work); try { await valid.withOwnedStoreAdmission(signal, work); } catch { /* adversarial swallow */ } return first; }, events: ["callback", "registry", "lock", "catalogue", "finalRegistry", "callback"], workCalls: 2 },
    { name: "failed first callback then retry", async run(signal, work, valid) { const failed: RegistryLockedOwnedStoreSessionV1 = Object.freeze({ maxIdentifierLength: 63n, async inspectRegistry() { throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }, async lockSecondary() { throw new Error("unexpected secondary lock"); } }); try { await work(failed); } catch { /* adversarial retry after a failed callback */ } return valid.withOwnedStoreAdmission(signal, work); }, events: ["callback"], workCalls: 2 },
    { name: "concurrent callbacks", async run(signal, work, valid) { await Promise.allSettled([valid.withOwnedStoreAdmission(signal, work), valid.withOwnedStoreAdmission(signal, work)]); return forged; }, events: ["callback", "registry", "callback", "lock", "catalogue", "finalRegistry"], workCalls: 2 },
  ];
  for (const item of cases) {
    const local = recordingProvider(), attack = adversarialCallbackCapability(item.run); registerPostgresOwnedStoreCapability(local, attack.capability);
    await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(attack.workCalls, item.name).toBe(item.workCalls); expect(attack.recorded.events, item.name).toEqual([...item.events]); expect(attack.recorded.created, item.name).toEqual([]); expect(attack.recorded.inserted, item.name).toEqual([]);
  }
});

test("B3 callback authenticity rejects cached markers from another admission attempt", async () => {
  for (const currentCallback of [false, true]) {
    const local = recordingProvider(), recorded = recordingCapability("reopen"); let cached: unknown; let attempts = 0, workCalls = 0;
    const capability = { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> {
      const counted = (session: RegistryLockedOwnedStoreSessionV1) => { workCalls++; return work(session); };
      attempts++;
      if (attempts === 1) { const first = await recorded.capability.withOwnedStoreAdmission(signal, counted); cached = first; return first; }
      if (currentCallback) await recorded.capability.withOwnedStoreAdmission(signal, counted);
      // Deliberately adversarial cross-attempt marker return, not a valid generic completion.
      return cached as T;
    } };
    registerPostgresOwnedStoreCapability(local, capability); const firstReceipt = await admitOwnedStoresV1(local, request()); const firstLease = publishOwnedStoreAdmissionV1(local, firstReceipt)[0]; if (!firstLease) throw new Error("missing cached-marker control lease"); firstLease.revoke();
    await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(attempts).toBe(2); expect(workCalls).toBe(currentCallback ? 2 : 1); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); expect(recorded.events).toEqual(currentCallback ? ["callback", "registry", "lock", "catalogue", "finalRegistry", "callback", "registry", "lock", "catalogue", "finalRegistry"] : ["callback", "registry", "lock", "catalogue", "finalRegistry"]);
  }
});

test("B3 authentic callback completion waits for capability resolution and does not publish its marker", async () => {
  const local = recordingProvider(), recorded = recordingCapability("reopen"); let marker: unknown; let release: (() => void) | undefined; const barrier = new Promise<void>(resolve => { release = resolve; }); let callbackReadyResolve: (() => void) | undefined; let callbackReadyReject: ((error: unknown) => void) | undefined; const callbackReady = new Promise<void>((resolve, reject) => { callbackReadyResolve = resolve; callbackReadyReject = reject; });
  registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { try { const value = await recorded.capability.withOwnedStoreAdmission(signal, work); marker = value; if (!callbackReadyResolve) throw new Error("missing callback-ready resolver"); callbackReadyResolve(); await barrier; return value; } catch (error) { callbackReadyReject?.(error); throw error; } } });
  let settled = false; const pending = admitOwnedStoresV1(local, request()).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  try { const readiness = await Promise.race([callbackReady.then(() => "ready" as const), pending.then(() => "settled" as const)]); if (readiness !== "ready") throw new Error("admission settled before callback marker"); expect(settled).toBe(false); await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(local, marker as ReturnType<typeof admitOwnedStoresV1> extends Promise<infer Receipt> ? Receipt : never)), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); } finally { if (!release) throw new Error("missing completion release"); release(); }
  const receipt = await pending; expect(Object.isFrozen(receipt)).toBe(true); const lease = publishOwnedStoreAdmissionV1(local, receipt)[0]; if (!lease) throw new Error("missing resolved lease"); lease.revoke(); expect(lease.active).toBe(false); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]);
});

test("B3 opaque receipts preserve base priority, single consumption, and nominal authenticity", async () => {
  const local = recordingProvider(), wrongBase = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, recorded.capability);
  const available = await admitOwnedStoresV1(local, request()); expect(Object.isFrozen(available)).toBe(true);
  await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(wrongBase, available)), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  const published = publishOwnedStoreAdmissionV1(local, available); expect(Object.isFrozen(published)).toBe(true); expect(published).toHaveLength(1); const publishedLease = published[0]; if (!publishedLease) throw new Error("missing published lease"); expect(Object.isFrozen(publishedLease)).toBe(true);
  await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(wrongBase, available)), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(local, available)), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); await admissionError(() => Promise.resolve().then(() => discardOwnedStoreAdmissionV1(available)), "ORM_OWNED_STORE_IDENTITY_MISMATCH");
  const discarded = await admitOwnedStoresV1(local, request()); discardOwnedStoreAdmissionV1(discarded); await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(wrongBase, discarded)), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(local, discarded)), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); await admissionError(() => Promise.resolve().then(() => discardOwnedStoreAdmissionV1(discarded)), "ORM_OWNED_STORE_IDENTITY_MISMATCH");
  const untrusted = await admitOwnedStoresV1(local, request()); const clone = { ...untrusted }; const forged = Object.freeze({});
  // Deliberately forged receipt-shaped values exercise nominal receipt provenance at the public boundary.
  for (const candidate of [forged as typeof untrusted, clone as typeof untrusted, publishedLease as unknown as typeof untrusted]) await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(local, candidate)), "ORM_OWNED_STORE_IDENTITY_MISMATCH");
  discardOwnedStoreAdmissionV1(untrusted); publishedLease.revoke(); publishedLease.revoke(); expect(publishedLease.active).toBe(false); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]);
});

test("B3 leases isolate by provider and by distinct nominally equal definition identity", async () => {
  const firstProvider = recordingProvider(), secondProvider = recordingProvider(), firstRecord = recordingCapability("reopen"), secondRecord = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(firstProvider, firstRecord.capability); registerPostgresOwnedStoreCapability(secondProvider, secondRecord.capability);
  const firstReceipt = await admitOwnedStoresV1(firstProvider, request()), secondReceipt = await admitOwnedStoresV1(secondProvider, request()); const firstLease = publishOwnedStoreAdmissionV1(firstProvider, firstReceipt)[0], secondLease = publishOwnedStoreAdmissionV1(secondProvider, secondReceipt)[0]; if (!firstLease || !secondLease) throw new Error("missing separate-provider lease"); firstLease.revoke(); firstLease.revoke(); expect(firstLease.active).toBe(false); expect(secondLease.active).toBe(true);
  const twinDefinition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnova_td_" } }); expect(twinDefinition).toEqual(definition); expect(twinDefinition).not.toBe(definition);
  const local = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, recorded.capability); const originalReceipt = await admitOwnedStoresV1(local, request()), twinReceipt = await admitOwnedStoresV1(local, typedRequest(expected, twinDefinition)); const originalLease = publishOwnedStoreAdmissionV1(local, originalReceipt)[0], twinLease = publishOwnedStoreAdmissionV1(local, twinReceipt)[0]; if (!originalLease || !twinLease) throw new Error("missing distinct-definition lease"); expect(Object.isFrozen(originalLease)).toBe(true); expect(Object.isFrozen(twinLease)).toBe(true); originalLease.revoke(); originalLease.revoke(); expect(originalLease.active).toBe(false); expect(twinLease.active).toBe(true); twinLease.revoke(); secondLease.revoke(); expect(twinLease.active).toBe(false); expect(secondLease.active).toBe(false); expect(firstRecord.created).toEqual([]); expect(secondRecord.inserted).toEqual([]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]);
});

test("B3 retry wrappers unwrap only through the registered acyclic depth budget", async () => {
  for (const depth of [0, 1, 15]) {
    const base = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(base, recorded.capability); let wrapped: DatabaseProvider = base; for (let edge = 0; edge < depth; edge++) wrapped = withRetry(wrapped, { maxRetries: 0 });
    const receipt = await admitOwnedStoresV1(wrapped, request()); const lease = publishOwnedStoreAdmissionV1(wrapped, receipt)[0]; if (!lease) throw new Error("missing wrapped lease"); lease.revoke();
    if (depth > 0) { const wrappedReceipt = await admitOwnedStoresV1(wrapped, request()), baseReceipt = await admitOwnedStoresV1(base, request()); const fromBase = publishOwnedStoreAdmissionV1(base, wrappedReceipt)[0], fromWrapper = publishOwnedStoreAdmissionV1(wrapped, baseReceipt)[0]; if (!fromBase || !fromWrapper) throw new Error("missing cross-route lease"); fromBase.revoke(); fromWrapper.revoke(); }
    expect(recorded.events).toEqual(Array.from({ length: depth > 0 ? 3 : 1 }, () => ["callback", "registry", "lock", "catalogue", "finalRegistry"]).flat());
  }
  for (const depth of [16, 17]) {
    const base = recordingProvider(), baseRecord = recordingCapability("reopen"), temptingRecord = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(base, baseRecord.capability); let wrapped: DatabaseProvider = base; for (let edge = 0; edge < depth; edge++) wrapped = withRetry(wrapped, { maxRetries: 0 }); registerPostgresOwnedStoreCapability(wrapped, temptingRecord.capability);
    await admissionError(() => admitOwnedStoresV1(wrapped, request()), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); expect(baseRecord.events).toEqual([]); expect(temptingRecord.events).toEqual([]);
  }
  const fake = recordingProvider(); await admissionError(() => admitOwnedStoresV1(fake, request()), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED");
  const base = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(base, recorded.capability); const genuine = await admitOwnedStoresV1(base, request()); let overflow: DatabaseProvider = base; for (let edge = 0; edge < 16; edge++) overflow = withRetry(overflow, { maxRetries: 0 });
  await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(overflow, Object.freeze({}) as typeof genuine)), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); await admissionError(() => Promise.resolve().then(() => publishOwnedStoreAdmissionV1(overflow, genuine)), "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); const lease = publishOwnedStoreAdmissionV1(base, genuine)[0]; if (!lease) throw new Error("missing unconsumed receipt lease"); lease.revoke();
});

function countBoundaryRequest(stores: number, tables: number): OwnedStoreAdmissionRequestV1 {
  const prepared = Array.from({ length: stores }, (_, storeIndex) => { const prefix = `osnova_c${storeIndex}_`; const definition = defineOrmOwnedStoreV1({ contract: "osnova.orm-owned-store/v1", storeKey: `count-${storeIndex}`, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: prefix } }); const expected = schema(...Array.from({ length: tables }, (_, tableIndex) => ({ ...table(`${prefix}t${tableIndex}`, [column("id", "integer")]), schema: "public" }))); return { definition, expected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(definition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(definition, expected) as `sha256:${string}` }; });
  return { stores: prepared };
}

test("B3 request cardinality accepts exact store/table limits and rejects the next values before callback", async () => {
  for (const [stores, tables] of [[1, 1], [2, 1], [128, 1], [1, 512]] as const) {
    const local = recordingProvider(); let callbacks = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { callbacks++; throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); } }); await admissionError(() => admitOwnedStoresV1(local, countBoundaryRequest(stores, tables)), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(callbacks).toBe(1);
  }
  for (const [stores, tables] of [[0, 1], [129, 1], [1, 0], [1, 513]] as const) {
    const local = recordingProvider(); let callbacks = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { callbacks++; throw failure("ORM_OWNED_STORE_LOCK_UNAVAILABLE"); } }); await admissionError(() => admitOwnedStoresV1(local, countBoundaryRequest(stores, tables)), "ORM_OWNED_STORE_IDENTITY_MISMATCH"); expect(callbacks).toBe(0);
  }
});

const safeAdmissionCodes = ["ORM_OWNED_STORE_PROVIDER_UNSUPPORTED", "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "ORM_OWNED_STORE_IDENTITY_MISSING", "ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_OWNERSHIP_CONFLICT", "ORM_OWNED_STORE_DRIFT", "ORM_OWNED_STORE_CREATE_FAILED"] as const satisfies readonly OrmOwnedStoreAdmissionError["code"][];
test("B3 server context reads once and distinguishes valid bounds from malformed values", async () => {
  for (const maximum of [63n, 64n]) { const local = recordingProvider(), recorded = recordingCapability("reopen", maximum); registerPostgresOwnedStoreCapability(local, recorded.capability); const receipt = await admitOwnedStoresV1(local, request()); expect(recorded.contextReads).toBe(1); const lease = publishOwnedStoreAdmissionV1(local, receipt)[0]; if (!lease) throw new Error("missing context lease"); lease.revoke(); }
  for (const [maximum, code] of [["63", "ORM_OWNED_STORE_DRIFT"], [null, "ORM_OWNED_STORE_DRIFT"], [62n, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"], [-1n, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"]] as const) { const local = recordingProvider(), recorded = recordingCapability("reopen", maximum); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), code); expect(recorded.contextReads).toBe(1); expect(recorded.events).toEqual(["callback"]); expect(recorded.created).toEqual([]); }
});

test("B3 operational error safe-codes preserve only at the pre-callback boundary", async () => {
  for (const code of safeAdmissionCodes) {
    const local = recordingProvider(); let callbacks = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { callbacks++; throw failure(code); } }); await admissionError(() => admitOwnedStoresV1(local, request()), code); expect(callbacks).toBe(1);
    const afterLocal = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(afterLocal, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { await recorded.capability.withOwnedStoreAdmission(signal, work); throw failure(code); } }); await admissionError(() => admitOwnedStoresV1(afterLocal, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]);
  }
});

test("B3 server getter and unsafe lookalikes redact to LOCK_UNAVAILABLE without hooks", async () => {
  for (const value of [...safeAdmissionCodes.map(code => () => { throw failure(code); }), () => { throw new Error("raw marker"); }, () => { throw new Proxy(failure("ORM_OWNED_STORE_DRIFT"), {}); }]) { const local = recordingProvider(), recorded = recordingCapability("reopen", value); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback"]); }
  const unsafe = [Object.assign(new Error("raw marker"), { code: "ORM_OWNED_STORE_DRIFT" }), Object.create(OrmOwnedStoreAdmissionError.prototype, { code: { get() { throw new Error("hook"); } }, message: { value: "ORM_OWNED_STORE_DRIFT" } }), new (class extends OrmOwnedStoreAdmissionError {})("ORM_OWNED_STORE_DRIFT", "ORM_OWNED_STORE_DRIFT")];
  for (const error of unsafe) { const local = recordingProvider(); let callbacks = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { callbacks++; throw error; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(callbacks).toBe(1); }
});

test("B3 hostile context and error descriptors are never invoked while redacting", async () => {
  for (const code of safeAdmissionCodes) {
    let hooks = 0; const error = Object.create(OrmOwnedStoreAdmissionError.prototype, { code: { enumerable: true, get() { hooks++; return code; } }, message: { enumerable: true, get() { hooks++; return code; } } }); const local = recordingProvider(); let callbacks = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { callbacks++; throw error; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(callbacks).toBe(1); expect(hooks).toBe(0);
  }
  let proxyHooks = 0; const proxy = new Proxy(failure("ORM_OWNED_STORE_DRIFT"), { get() { proxyHooks++; throw new Error("hook"); }, getPrototypeOf() { proxyHooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { proxyHooks++; throw new Error("hook"); }, ownKeys() { proxyHooks++; throw new Error("hook"); } }); const local = recordingProvider(); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { throw proxy; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(proxyHooks).toBe(0);
  let contextHooks = 0; const hostileContext = new Proxy({}, { get() { contextHooks++; throw new Error("hook"); }, getPrototypeOf() { contextHooks++; throw new Error("hook"); }, getOwnPropertyDescriptor() { contextHooks++; throw new Error("hook"); }, ownKeys() { contextHooks++; throw new Error("hook"); } }); const contextLocal = recordingProvider(), contextRecord = recordingCapability("reopen", hostileContext); registerPostgresOwnedStoreCapability(contextLocal, contextRecord.capability); await admissionError(() => admitOwnedStoresV1(contextLocal, request()), "ORM_OWNED_STORE_DRIFT"); expect(contextRecord.contextReads).toBe(1); expect(contextHooks).toBe(0); expect(contextRecord.events).toEqual(["callback"]); expect(contextRecord.created).toEqual([]); expect(contextRecord.inserted).toEqual([]);
});

test("B3 context malformed values and post-callback unsafe rejections remain phase-safe", async () => {
  for (const value of [63, () => undefined, Object(63n), {}]) { const local = recordingProvider(), recorded = recordingCapability("reopen", value); registerPostgresOwnedStoreCapability(local, recorded.capability); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_DRIFT"); expect(recorded.contextReads).toBe(1); expect(recorded.events).toEqual(["callback"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); }
  const unsafe = [Object.assign(new Error("raw marker"), { code: "ORM_OWNED_STORE_NOT_A_CODE" }), Object.assign(new Error("raw marker"), { code: "ORM_OWNED_STORE_DRIFT" }), new Proxy(new Error("raw marker"), {})];
  for (const error of unsafe) { const local = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { await recorded.capability.withOwnedStoreAdmission(signal, work); throw error; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect(recorded.created).toEqual([]); expect(recorded.inserted).toEqual([]); }
});

test("B3 unsafe exact-prototype own-data error pairs are redacted before callback", async () => {
  for (const [code, message] of [["ORM_OWNED_STORE_UNKNOWN", "ORM_OWNED_STORE_UNKNOWN"], ["ORM_OWNED_STORE_DRIFT", "different message"]] as const) {
    const error = Object.create(OrmOwnedStoreAdmissionError.prototype, { code: { value: code, enumerable: true }, message: { value: message, enumerable: true } }); const local = recordingProvider(); let workCalls = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { workCalls++; throw error; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(workCalls).toBe(1);
  }
});

test("B3 unsafe exact-prototype message accessor is redacted without invoking it", async () => {
  let hooks = 0; const error = Object.create(OrmOwnedStoreAdmissionError.prototype, { code: { value: "ORM_OWNED_STORE_DRIFT", enumerable: true }, message: { enumerable: true, get() { hooks++; return "ORM_OWNED_STORE_DRIFT"; } } }); const local = recordingProvider(); let workCalls = 0; registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission() { workCalls++; throw error; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(workCalls).toBe(1); expect(hooks).toBe(0);
});

test("B3 post-callback proxy error is redacted without invoking proxy traps", async () => {
  let get = 0, prototype = 0, descriptor = 0, keys = 0; const proxy = new Proxy(failure("ORM_OWNED_STORE_DRIFT"), { get() { get++; throw new Error("hook"); }, getPrototypeOf() { prototype++; throw new Error("hook"); }, getOwnPropertyDescriptor() { descriptor++; throw new Error("hook"); }, ownKeys() { keys++; throw new Error("hook"); } }); const local = recordingProvider(), recorded = recordingCapability("reopen"); registerPostgresOwnedStoreCapability(local, { async withOwnedStoreAdmission<T>(signal: AbortSignal | undefined, work: (session: RegistryLockedOwnedStoreSessionV1) => Promise<T>): Promise<T> { await recorded.capability.withOwnedStoreAdmission(signal, work); throw proxy; } }); await admissionError(() => admitOwnedStoresV1(local, request()), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorded.events).toEqual(["callback", "registry", "lock", "catalogue", "finalRegistry"]); expect({ get, prototype, descriptor, keys }).toEqual({ get: 0, prototype: 0, descriptor: 0, keys: 0 });
});
