import { createHash } from "node:crypto";
import type { CheckAst, CheckScalar } from "./CheckExpression";
import type { OrmOwnedStoreDefinitionV1 } from "./OrmOwnedStore";
import type { ExpectedTable, OrmExpectedSchema } from "./ExpectedSchema";
import { OrmOwnedStoreAdmissionError } from "../errors";
type CanonicalValue = null | boolean | number | bigint | string | readonly CanonicalValue[] | {
  readonly [key: string]: CanonicalValue;
};
const encoder = new TextEncoder();
const MAX_DEPTH = 64;
const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_NODES = 1_000_000;
const MAX_CHECK_NODES = 4096;
/** Private canonicalization shared by the future registry/catalog admission. */
export function canonicalOwnedStoreScopePreimageV1(definition: OrmOwnedStoreDefinitionV1): Buffer {
  return safe(() => withDomain("bazis.orm-owned-store/scope-hash/v1\0", record({
    contract: definition.contract, storeKey: definition.storeKey, formatVersion: BigInt(definition.formatVersion), ownedSchema: definition.ownedScope.schema, tablePrefix: definition.ownedScope.tablePrefix
  })));
}
export function canonicalOwnedStoreScopeHashV1(definition: OrmOwnedStoreDefinitionV1): string {
  return digest(canonicalOwnedStoreScopePreimageV1(definition));
}
export function canonicalOwnedStoreModelPreimageV1(definition: Pick<OrmOwnedStoreDefinitionV1, "contract" | "formatVersion">, schema: OrmExpectedSchema): Buffer {
  return safe(() => {
    if (definition.contract !== "bazis.orm-owned-store/v1" || typeof definition.formatVersion !== "number" || !Number.isSafeInteger(definition.formatVersion) || definition.formatVersion <= 0 || !schema || !Array.isArray(schema.tables))
      throw ownedError();
    const tables = [...schema.tables].sort((a, b) => comparePair(a.schema, a.table, b.schema, b.table)).map(canonicalTable);
    return withDomain("bazis.orm-owned-store/model-hash/v1\0", record({ contract: definition.contract, formatVersion: BigInt(definition.formatVersion), tables }));
  });
}
export function canonicalOwnedStoreModelHashV1(definition: Pick<OrmOwnedStoreDefinitionV1, "contract" | "formatVersion">, schema: OrmExpectedSchema): string {
  return digest(canonicalOwnedStoreModelPreimageV1(definition, schema));
}
export function canonicalOwnedStoreRegistryLockPreimageV1(): Buffer {
  return Buffer.from("bazis.orm-owned-store/registry-lock/v1\0", "ascii");
}
export function canonicalOwnedStoreStoreLockPreimageV1(definition: OrmOwnedStoreDefinitionV1): Buffer {
  return safe(() => withDomain("bazis.orm-owned-store/store-lock/v1\0", record({
    schema: identifier(definition.ownedScope.schema), tablePrefix: identifier(definition.ownedScope.tablePrefix), storeKey: storeKey(definition.storeKey), formatVersion: BigInt(definition.formatVersion)
  })));
}
export function canonicalOwnedStoreScopeLockPreimageV1(scope: {
  readonly schema: string;
  readonly tablePrefix: string;
}): Buffer {
  return safe(() => withDomain("bazis.orm-owned-store/scope-lock/v1\0", record({ schema: identifier(scope.schema), tablePrefix: identifier(scope.tablePrefix) })));
}
export function ownedStoreAdvisoryLockV1(preimage: Uint8Array): bigint {
  return createHash("sha256").update(preimage).digest().readBigInt64BE(0);
}
function canonicalTable(table: ExpectedTable): CanonicalValue {
  if (!table || !Array.isArray(table.columns) || !table.primaryKey || !Array.isArray(table.indexes) || !Array.isArray(table.foreignKeys) || !Array.isArray(table.checks))
    throw ownedError();
  return record({
    schema: identifier(table.schema), table: identifier(table.table), columns: table.columns.map((column) => {
      if (!column || typeof column.nullable !== "boolean")
        throw ownedError();
      return record({
        column: identifier(column.column), physicalType: identifier(column.physicalType), nullable: column.nullable, default: canonicalDefault(column.default), generation: generation(column.generation)
      });
    }), primaryKey: record({ name: identifier(table.primaryKey.name), columns: identifiers(table.primaryKey.columns) }), indexes: [...table.indexes].sort((a, b) => compareText(a.name, b.name)).map((index) => {
      if (!index || typeof index.unique !== "boolean" || index.method !== "btree")
        throw ownedError();
      return record({
        name: identifier(index.name), columns: identifiers(index.columns), unique: index.unique, method: index.method
      });
    }), foreignKeys: [...table.foreignKeys].sort((a, b) => compareText(a.name, b.name)).map((foreignKey) => {
      if (!foreignKey || !foreignKey.target || typeof foreignKey.onDelete !== "string" || typeof foreignKey.onUpdate !== "string")
        throw ownedError();
      return record({
        name: identifier(foreignKey.name), columns: identifiers(foreignKey.columns), targetSchema: identifier(foreignKey.target.schema), targetTable: identifier(foreignKey.target.table), targetColumns: identifiers(foreignKey.targetColumns), onDelete: foreignKey.onDelete, onUpdate: foreignKey.onUpdate
      });
    }), checks: [...table.checks].sort((a, b) => compareText(a.name, b.name)).map((check) => record({ name: identifier(check.name), expression: canonicalCheck(check.expression as CheckAst) }))
  });
}
function canonicalDefault(value: {
  readonly kind: string;
  readonly value?: boolean | number | string;
}): CanonicalValue {
  if (!value || typeof value !== "object")
    throw ownedError();
  if (value.kind === "boolean" && typeof value.value === "boolean")
    return record({ kind: value.kind, value: value.value });
  if (value.kind === "number" && typeof value.value === "number" && Number.isFinite(value.value))
    return record({ kind: value.kind, value: value.value });
  if (value.kind === "string" && typeof value.value === "string")
    return record({ kind: value.kind, value: value.value });
  if (value.kind === "none" || value.kind === "null" || value.kind === "currentTimestamp" || value.kind === "uuidV4")
    return record({ kind: value.kind });
  throw ownedError();
}
function canonicalCheck(ast: CheckAst): CanonicalValue {
  let count = 0;
  const visit = (node: CheckAst, depth: number): CanonicalValue => {
    if (++count > MAX_CHECK_NODES || depth > MAX_DEPTH)
      throw new Error("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    if (!node || typeof node !== "object" || typeof node.kind !== "string")
      throw ownedError();
    switch (node.kind) {
      case "compare": {
        if (!["=", "<>", ">", ">=", "<", "<="].includes(node.op) || typeof node.left !== "string")
          throw ownedError();
        const right = node.right;
        if (typeof right === "string" && right.startsWith("\0"))
          return record({
            kind: node.kind, op: node.op, left: identifier(node.left), right: record({ kind: "column", column: identifier(right.slice(1)) })
          });
        if (!scalar(right))
          throw ownedError();
        return record({
          kind: node.kind, op: node.op, left: identifier(node.left), right: record({ kind: "scalar", value: right })
        });
      }
      case "in":
        if (!Array.isArray(node.values) || !node.values.every(scalar))
          throw ownedError();
        return record({ kind: node.kind, left: identifier(node.left), values: [...node.values] });
      case "null":
        if (typeof node.not !== "boolean")
          throw ownedError();
        return record({ kind: node.kind, left: identifier(node.left), not: node.not });
      case "and":
      case "or": return record({ kind: node.kind, left: visit(node.left, depth + 1), right: visit(node.right, depth + 1) });
      case "not": return record({ kind: node.kind, inner: visit(node.inner, depth + 1) });
      default: throw ownedError();
    }
  };
  return visit(ast, 1);
}
function record(value: {
  readonly [key: string]: CanonicalValue;
}): {
  readonly [key: string]: CanonicalValue;
} {
  return value;
}
function withDomain(domain: string, root: CanonicalValue): Buffer {
  const state = { nodes: 0, bytes: Buffer.byteLength(domain, "ascii") };
  const output = Buffer.concat([Buffer.from(domain, "ascii"), encode(root, 1, state)]);
  return output;
}
function encode(value: CanonicalValue, depth: number, state: {
  nodes: number;
  bytes: number;
}, fieldName = false): Buffer {
  if (!fieldName && ++state.nodes > MAX_MODEL_NODES)
    throw ownedError();
  if (value === null)
    return charged(Buffer.from([0]), state);
  if (value === false)
    return charged(Buffer.from([1]), state);
  if (value === true)
    return charged(Buffer.from([2]), state);
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffffffffffffffffn)
      throw ownedError();
    const bytes = Buffer.alloc(9);
    bytes[0] = 3;
    bytes.writeBigUInt64BE(value, 1);
    return charged(bytes, state);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw ownedError();
    const bytes = Buffer.alloc(9);
    bytes[0] = 4;
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value, 1);
    return charged(bytes, state);
  }
  if (typeof value === "string") {
    if (!wellFormed(value))
      throw ownedError();
    const length = Buffer.byteLength(value, "utf8");
    if (length > 0xffffffff)
      throw ownedError();
    charge(5 + length, state);
    const size = Buffer.alloc(5);
    size[0] = 5;
    size.writeUInt32BE(length, 1);
    return Buffer.concat([size, Buffer.from(encoder.encode(value))]);
  }
  if (Array.isArray(value)) {
    if (value.length > 0xffffffff)
      throw ownedError();
    charge(5, state);
    const head = Buffer.alloc(5);
    head[0] = 6;
    head.writeUInt32BE(value.length, 1);
    return Buffer.concat([head, ...value.map((entry) => encode(entry, depth + 1, state))]);
  }
  const fields = Object.entries(value);
  if (fields.length > 0xffffffff)
    throw ownedError();
  charge(5, state);
  const head = Buffer.alloc(5);
  head[0] = 7;
  head.writeUInt32BE(fields.length, 1);
  return Buffer.concat([
    head, ...fields.flatMap(([name, entry]) => [encode(name, depth + 1, state, true), encode(entry, depth + 1, state)])
  ]);
}
function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function comparePair(leftSchema: string, leftTable: string, rightSchema: string, rightTable: string): number {
  return compareText(leftSchema, rightSchema) || compareText(leftTable, rightTable);
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return false;
      index++;
    }
    else if (unit >= 0xdc00 && unit <= 0xdfff)
      return false;
  }
  return true;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !wellFormed(value) || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 63 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw ownedError();
  return value;
}
function storeKey(value: unknown): string {
  if (typeof value !== "string" || !wellFormed(value) || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw ownedError();
  return value;
}
function identifiers(value: unknown): readonly string[] {
  if (!Array.isArray(value))
    throw ownedError();
  return value.map(identifier);
}
function generation(value: unknown): string {
  if (value !== "none" && value !== "identityByDefault" && value !== "uuidDefault")
    throw ownedError();
  return value;
}
function scalar(value: unknown): value is CheckScalar {
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && wellFormed(value));
}
function charge(amount: number, state: {
  bytes: number;
}): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || state.bytes > MAX_MODEL_BYTES - amount)
    throw ownedError();
  state.bytes += amount;
}
function charged(value: Buffer, state: {
  bytes: number;
}): Buffer {
  charge(value.length, state);
  return value;
}
function ownedError(): OrmOwnedStoreAdmissionError {
  return new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_IDENTITY_MISMATCH");
}
function safe<T>(work: () => T): T {
  try {
    return work();
  }
  catch (error) {
    if (error instanceof OrmOwnedStoreAdmissionError)
      throw error;
    throw ownedError();
  }
}
