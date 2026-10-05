import { expect, test } from "bun:test";
import { defineOrmOwnedStoreV1 } from "osnv/library/orm";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreModelPreimageV1, canonicalOwnedStoreRegistryLockPreimageV1, canonicalOwnedStoreScopeHashV1, canonicalOwnedStoreScopeLockPreimageV1, canonicalOwnedStoreScopePreimageV1, canonicalOwnedStoreStoreLockPreimageV1, ownedStoreAdvisoryLockV1 } from "../Schema/OwnedStoreCanonical";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";
import { createHash } from "node:crypto";

const definition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnv_td_" } });
const schema: OrmExpectedSchema = { tables: [{ schema: "public", table: "osnv_td_sample", columns: [{ property: "id", column: "id", physicalType: "bigint", nullable: false, default: { kind: "none" }, generation: "none" }, { property: "isActive", column: "is_active", physicalType: "boolean", nullable: false, default: { kind: "boolean", value: true }, generation: "none" }], primaryKey: { name: "pk_sample", columns: ["id"] }, indexes: [], foreignKeys: [], checks: [{ name: "ck_sample_active", expression: { kind: "compare", op: "=", left: "is_active", right: true } }] }] };

test("owned-store canonical goldens use the frozen TLV domains", () => {
  expect(canonicalOwnedStoreScopePreimageV1(definition).toString("hex")).toBe("6f736e762e6f726d2d6f776e65642d73746f72652f73636f70652d686173682f76310007000000050500000008636f6e747261637405000000176f736e762e6f726d2d6f776e65642d73746f72652f7631050000000873746f72654b657905000000086669787475726573050000000d666f726d617456657273696f6e030000000000000001050000000b6f776e6564536368656d6105000000067075626c6963050000000b7461626c6550726566697805000000086f736e765f74645f");
  expect(canonicalOwnedStoreRegistryLockPreimageV1().toString("hex")).toBe("6f736e762e6f726d2d6f776e65642d73746f72652f72656769737472792d6c6f636b2f763100");
  expect(canonicalOwnedStoreStoreLockPreimageV1(definition).toString("hex")).toBe("6f736e762e6f726d2d6f776e65642d73746f72652f73746f72652d6c6f636b2f76310007000000040500000006736368656d6105000000067075626c6963050000000b7461626c6550726566697805000000086f736e765f74645f050000000873746f72654b657905000000086669787475726573050000000d666f726d617456657273696f6e030000000000000001");
  expect(canonicalOwnedStoreScopeLockPreimageV1(definition.ownedScope).toString("hex")).toBe("6f736e762e6f726d2d6f776e65642d73746f72652f73636f70652d6c6f636b2f76310007000000020500000006736368656d6105000000067075626c6963050000000b7461626c6550726566697805000000086f736e765f74645f");
  expect(createHash("sha256").update(canonicalOwnedStoreScopePreimageV1(definition)).digest("hex")).toBe("cffa4897a6f0af4029b6ca0f40f118ef0cfe6c958e80601257fae2041310ee14");
  expect(canonicalOwnedStoreScopeHashV1(definition)).toBe("sha256:cffa4897a6f0af4029b6ca0f40f118ef0cfe6c958e80601257fae2041310ee14");
  expect(canonicalOwnedStoreRegistryLockPreimageV1().length).toBe(38);
  expect(ownedStoreAdvisoryLockV1(canonicalOwnedStoreRegistryLockPreimageV1())).toBe(4925981505368540443n);
  expect(canonicalOwnedStoreStoreLockPreimageV1(definition).length).toBe(144);
  expect(ownedStoreAdvisoryLockV1(canonicalOwnedStoreStoreLockPreimageV1(definition))).toBe(-8131040898855573054n);
  expect(canonicalOwnedStoreScopeLockPreimageV1(definition.ownedScope).length).toBe(91);
  expect(ownedStoreAdvisoryLockV1(canonicalOwnedStoreScopeLockPreimageV1(definition.ownedScope))).toBe(-3763692634803491468n);
  expect(canonicalOwnedStoreModelPreimageV1(definition, schema).length).toBe(746);
  expect(canonicalOwnedStoreModelPreimageV1(definition, schema).toString("hex")).toBe("6f736e762e6f726d2d6f776e65642d73746f72652f6d6f64656c2d686173682f76310007000000030500000008636f6e747261637405000000176f736e762e6f726d2d6f776e65642d73746f72652f7631050000000d666f726d617456657273696f6e03000000000000000105000000067461626c6573060000000107000000070500000006736368656d6105000000067075626c696305000000057461626c65050000000e6f736e765f74645f73616d706c650500000007636f6c756d6e73060000000207000000050500000006636f6c756d6e05000000026964050000000c706879736963616c547970650500000006626967696e7405000000086e756c6c61626c6501050000000764656661756c74070000000105000000046b696e6405000000046e6f6e65050000000a67656e65726174696f6e05000000046e6f6e6507000000050500000006636f6c756d6e050000000969735f616374697665050000000c706879736963616c547970650500000007626f6f6c65616e05000000086e756c6c61626c6501050000000764656661756c74070000000205000000046b696e640500000007626f6f6c65616e050000000576616c756502050000000a67656e65726174696f6e05000000046e6f6e65050000000a7072696d6172794b6579070000000205000000046e616d650500000009706b5f73616d706c650500000007636f6c756d6e730600000001050000000269640500000007696e64657865730600000000050000000b666f726569676e4b65797306000000000500000006636865636b730600000001070000000205000000046e616d650500000010636b5f73616d706c655f616374697665050000000a65787072657373696f6e070000000405000000046b696e640500000007636f6d7061726505000000026f7005000000013d05000000046c656674050000000969735f61637469766505000000057269676874070000000205000000046b696e6405000000067363616c6172050000000576616c756502");
  expect(createHash("sha256").update(canonicalOwnedStoreModelPreimageV1(definition, schema)).digest("hex")).toBe("e3f15e2e06679aba4914ddc4555b24ce5217cbaf8e68b8f988ce6bef24eb0811");
  expect(canonicalOwnedStoreModelHashV1(definition, schema)).toBe("sha256:e3f15e2e06679aba4914ddc4555b24ce5217cbaf8e68b8f988ce6bef24eb0811");
});

test("canonical model preserves physical order and rejects non-finite values", () => {
  const reversed: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [...schema.tables[0]!.columns].reverse() }] };
  expect(canonicalOwnedStoreModelHashV1(definition, reversed)).not.toBe(canonicalOwnedStoreModelHashV1(definition, schema));
  const bad: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: { kind: "number", value: Number.NaN } }, ...schema.tables[0]!.columns.slice(1)] }] };
  expect(() => canonicalOwnedStoreModelHashV1(definition, bad)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("canonical model rejects closed-domain violations with safe owned-store errors", () => {
  const invalids: readonly OrmExpectedSchema[] = [
    { tables: [{ ...schema.tables[0]!, table: "" }] },
    { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, column: "a".repeat(64) }, ...schema.tables[0]!.columns.slice(1)] }] },
    { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: { kind: "unknown" } as never }, ...schema.tables[0]!.columns.slice(1)] }] },
    { tables: [{ ...schema.tables[0]!, checks: [{ name: "x", expression: { kind: "unknown" } }] }] },
    { tables: [{ ...schema.tables[0]!, checks: [{ name: "x", expression: { kind: "compare", op: "=", left: "a\n", right: true } }] }] },
  ];
  for (const invalid of invalids) {
    expect(() => canonicalOwnedStoreModelHashV1(definition, invalid)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  }
});

test("model literals retain controls while column sentinels remain references", () => {
  const literal: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck_sample_active", expression: { kind: "in", left: "is_active", values: ["\0\n\t"] } }] }] };
  const reference: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck_sample_active", expression: { kind: "compare", op: "=", left: "is_active", right: "\0id" } }] }] };
  expect(canonicalOwnedStoreModelHashV1(definition, literal)).not.toBe(canonicalOwnedStoreModelHashV1(definition, reference));
  const lone: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "x", expression: { kind: "compare", op: "=", left: "is_active", right: "\ud800" } }] }] };
  expect(() => canonicalOwnedStoreModelHashV1(definition, lone)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("canonical model covers every closed default and CHECK variant", () => {
  const defaults = [
    { kind: "none" }, { kind: "null" }, { kind: "currentTimestamp" }, { kind: "uuidV4" },
    { kind: "boolean", value: false }, { kind: "number", value: -0 }, { kind: "string", value: "text\n\0" },
  ] as const;
  for (const value of defaults) {
    const candidate: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: value }, ...schema.tables[0]!.columns.slice(1)] }] };
    expect(canonicalOwnedStoreModelHashV1(definition, candidate)).toStartWith("sha256:");
  }
  const asts = [
    { kind: "compare", op: "=", left: "is_active", right: "\0id" },
    { kind: "in", left: "is_active", values: [true, false] },
    { kind: "null", left: "is_active", not: true },
    { kind: "and", left: { kind: "null", left: "is_active", not: false }, right: { kind: "not", inner: { kind: "null", left: "is_active", not: true } } },
    { kind: "or", left: { kind: "null", left: "is_active", not: false }, right: { kind: "null", left: "id", not: true } },
  ] as const;
  for (const expression of asts) {
    const candidate: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression }] }] };
    expect(canonicalOwnedStoreModelHashV1(definition, candidate)).toStartWith("sha256:");
  }
});

test("store lock preserves the descriptor 128-byte storeKey domain", () => {
  for (const key of ["a".repeat(64), "a".repeat(128), "я".repeat(64)]) {
    const current = defineOrmOwnedStoreV1({ ...definition, storeKey: key });
    expect(canonicalOwnedStoreStoreLockPreimageV1(current).length).toBe(136 + Buffer.byteLength(key, "utf8"));
  }
  const invalid = { ...definition, storeKey: "a".repeat(129) };
  expect(() => canonicalOwnedStoreStoreLockPreimageV1(invalid)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("CHECK depth is AST-local: depth 64 passes and 65 fails", () => {
  const nested = (count: number): unknown => {
    let node: unknown = { kind: "null", left: "id", not: false };
    for (let index = 0; index < count; index++) node = { kind: "not", inner: node };
    return node;
  };
  const at64: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: nested(63) }] }] };
  const at65: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: nested(64) }] }] };
  expect(canonicalOwnedStoreModelHashV1(definition, at64)).toStartWith("sha256:");
  expect(() => canonicalOwnedStoreModelHashV1(definition, at65)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("canonical byte budget admits exactly four MiB and rejects one additional byte", () => {
  const withLiteral = (literal: string): OrmExpectedSchema => ({ tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: { kind: "string", value: literal } }, ...schema.tables[0]!.columns.slice(1)] }] });
  let low = 0; let high = 4 * 1024 * 1024;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    try { canonicalOwnedStoreModelPreimageV1(definition, withLiteral("x".repeat(middle))); low = middle; } catch { high = middle - 1; }
  }
  expect(canonicalOwnedStoreModelPreimageV1(definition, withLiteral("x".repeat(low))).length).toBe(4 * 1024 * 1024);
  expect(() => canonicalOwnedStoreModelPreimageV1(definition, withLiteral("x".repeat(low + 1)))).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("CHECK node budget accepts 4096 nodes and rejects 4097", () => {
  const leaf = (): any => ({ kind: "null", left: "id", not: false });
  const full = (leaves: number): any => leaves === 1 ? leaf() : { kind: "and", left: full(leaves / 2), right: full(leaves / 2) };
  const at4096 = { kind: "not", inner: full(2048) }; // 4095 + one
  const at4097 = { kind: "not", inner: at4096 };
  const candidate = (expression: unknown): OrmExpectedSchema => ({ tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression }] }] });
  expect(canonicalOwnedStoreModelHashV1(definition, candidate(at4096))).toStartWith("sha256:");
  expect(() => canonicalOwnedStoreModelHashV1(definition, candidate(at4097))).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("canonical model value-node budget is exactly one million excluding field names", () => {
  const candidate = (count: number): OrmExpectedSchema => ({ tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: { kind: "in", left: "is_active", values: Array<null>(count).fill(null) } }] }] });
  // This closed fixture has 36 fixed value nodes; field-name TLVs are excluded.
  expect(canonicalOwnedStoreModelHashV1(definition, candidate(999_964))).toStartWith("sha256:");
  expect(() => canonicalOwnedStoreModelHashV1(definition, candidate(999_965))).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("set-like collections sort by UTF-8 while semantic lists retain order", () => {
  const indexed = {
    ...schema.tables[0]!,
    indexes: [{ name: "я", columns: ["id"], unique: false, method: "btree" as const }, { name: "é", columns: ["is_active"], unique: true, method: "btree" as const }],
    foreignKeys: [{ name: "я", columns: ["id"], target: { schema: "public", table: "osnv_td_sample" }, targetColumns: ["id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" }, { name: "é", columns: ["is_active"], target: { schema: "public", table: "osnv_td_sample" }, targetColumns: ["is_active"], onDelete: "NO ACTION", onUpdate: "NO ACTION" }],
    checks: [{ name: "я", expression: { kind: "in", left: "is_active", values: [true, false] } }, { name: "é", expression: { kind: "in", left: "is_active", values: [false, true] } }],
  };
  const ordered: OrmExpectedSchema = { tables: [indexed, { ...schema.tables[0]!, table: "ё" }] };
  const permuted: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, table: "ё" }, { ...indexed, indexes: [...indexed.indexes].reverse(), foreignKeys: [...indexed.foreignKeys].reverse(), checks: [...indexed.checks].reverse() }] };
  expect(canonicalOwnedStoreModelHashV1(definition, ordered)).toBe(canonicalOwnedStoreModelHashV1(definition, permuted));
  const columnsChanged: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [...schema.tables[0]!.columns].reverse() }] };
  const pkChanged: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, primaryKey: { name: "pk_sample", columns: ["is_active", "id"] } }] };
  const inChanged: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: { kind: "in", left: "is_active", values: [false, true] } }] }] };
  expect(canonicalOwnedStoreModelHashV1(definition, columnsChanged)).not.toBe(canonicalOwnedStoreModelHashV1(definition, schema));
  expect(canonicalOwnedStoreModelHashV1(definition, pkChanged)).not.toBe(canonicalOwnedStoreModelHashV1(definition, schema));
  expect(canonicalOwnedStoreModelHashV1(definition, inChanged)).not.toBe(canonicalOwnedStoreModelHashV1(definition, schema));
});

test("minus zero canonicalizes to plus zero and model data remains literal", () => {
  const negative: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: { kind: "number", value: -0 } }, ...schema.tables[0]!.columns.slice(1)] }] };
  const positive: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, columns: [{ ...schema.tables[0]!.columns[0]!, default: { kind: "number", value: 0 } }, ...schema.tables[0]!.columns.slice(1)] }] };
  expect(canonicalOwnedStoreModelHashV1(definition, negative)).toBe(canonicalOwnedStoreModelHashV1(definition, positive));
  const c1: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: { kind: "in", left: "is_active", values: ["\0\n\t\u0085"] } }] }] };
  expect(canonicalOwnedStoreModelHashV1(definition, c1)).toStartWith("sha256:");
});

test("AND and OR preserve the order of distinct operand subtrees", () => {
  const left = { kind: "null", left: "id", not: false } as const;
  const right = { kind: "null", left: "is_active", not: true } as const;
  for (const kind of ["and", "or"] as const) {
    const first: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: { kind, left, right } }] }] };
    const second: OrmExpectedSchema = { tables: [{ ...schema.tables[0]!, checks: [{ name: "ck", expression: { kind, left: right, right: left } }] }] };
    expect(canonicalOwnedStoreModelHashV1(definition, first)).not.toBe(canonicalOwnedStoreModelHashV1(definition, second));
  }
});
