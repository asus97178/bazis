import type { Row } from "./types";
import type { IntrospectedColumn, IntrospectedIndex, IntrospectedForeignKey } from "../Schema/introspection";
import { parseRenderedCheck } from "../Schema/CheckExpression";

export function canonicalPostgresColumn(type: string, defaultExpression: string | null, identity: string): Pick<IntrospectedColumn, "physicalType" | "default" | "generation" | "unsupported"> {
  const physicalType = canonicalPostgresType(type);
  const defaultValue = canonicalPostgresDefault(defaultExpression, physicalType);
  const generation = identity === "d" ? "identityByDefault" as const : defaultValue.kind === "uuidV4" ? "uuidDefault" as const : "none" as const;
  return { physicalType, default: defaultValue.value, generation, unsupported: physicalType === "unknown" || defaultValue.unsupported || (identity !== "" && identity !== "d") };
}

export function canonicalPostgresType(type: string): "integer" | "real" | "text" | "boolean" | "datetime" | "json" | "uuid" | "unknown" {
  switch (type.trim().toLowerCase()) {
    case "smallint": case "integer": case "bigint": return "integer";
    case "real": case "double precision": case "numeric": return "real";
    case "text": case "character varying": case "character": return "text";
    case "boolean": return "boolean";
    case "timestamp with time zone": return "datetime";
    case "json": case "jsonb": return "json";
    case "uuid": return "uuid";
    default: return "unknown";
  }
}

/** Exact admission accepts only the physical spellings rendered by PostgresDialect. */
export function exactPostgresType(type: string, canonical: IntrospectedColumn["physicalType"]): IntrospectedColumn["physicalType"] {
  const raw = type.trim().toLowerCase();
  switch (raw) {
    case "bigint": case "double precision": case "text": case "boolean": case "timestamp with time zone": case "jsonb": case "uuid": return canonical;
    default: return `${canonical ?? "unknown"}:${raw}`;
  }
}

export function canonicalPostgresDefault(value: string | null, physicalType: string): { readonly value: IntrospectedColumn["default"]; readonly kind: "none" | "uuidV4"; readonly unsupported: boolean } {
  if (value === null) return { value: { kind: "none" }, kind: "none", unsupported: false };
  const raw = normalizePostgresDefault(value);
  if (/^null$/i.test(raw)) return { value: { kind: "null" }, kind: "none", unsupported: false };
  if (/^current_timestamp$/i.test(raw) || /^now\(\)$/i.test(raw)) return { value: { kind: "currentTimestamp" }, kind: "none", unsupported: false };
  if (/^gen_random_uuid\(\)$/i.test(raw)) return { value: { kind: "uuidV4" }, kind: "uuidV4", unsupported: false };
  if (/^(true|false)$/i.test(raw)) return { value: { kind: "boolean", value: /^true$/i.test(raw) }, kind: "none", unsupported: false };
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return { value: { kind: "number", value: numeric }, kind: "none", unsupported: false };
  }
  const string = raw.match(/^'((?:''|[^'])*)'$/);
  if (string) {
    const decoded = string[1]!.replaceAll("''", "'");
    if (physicalType === "datetime") {
      const temporal = canonicalTimestamp(decoded);
      return temporal === undefined ? { value: { kind: "none" }, kind: "none", unsupported: true } : { value: { kind: "string", value: temporal }, kind: "none", unsupported: false };
    }
    if (physicalType === "json") {
      try { const json = JSON.parse(decoded); if (json === null) return { value: { kind: "null" }, kind: "none", unsupported: false }; if (typeof json === "boolean") return { value: { kind: "boolean", value: json }, kind: "none", unsupported: false }; if (typeof json === "number" && Number.isFinite(json)) return { value: { kind: "number", value: json }, kind: "none", unsupported: false }; if (typeof json === "string") return { value: { kind: "string", value: json }, kind: "none", unsupported: false }; } catch { /* fail closed below */ }
      return { value: { kind: "none" }, kind: "none", unsupported: true };
    }
    return { value: { kind: "string", value: decoded }, kind: "none", unsupported: false };
  }
  return { value: { kind: "none" }, kind: "none", unsupported: true };
}
function canonicalTimestamp(value: string): string | undefined {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}(?::?\d{2})?|Z)$/u);
  if (!match) return undefined;
  let offset = match[4]!;
  if (offset !== "Z" && !offset.includes(":")) offset = offset.length === 3 ? `${offset}:00` : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const iso = `${match[1]}T${match[2]}${match[3] ? `.${match[3]}` : ""}${offset}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString().replace(/\.000Z$/u, "Z");
}

function normalizePostgresDefault(value: string): string {
  let current = value.trim();
  for (;;) {
    const next = stripPostgresOuter(stripPostgresCasts(current));
    if (next === current) return next;
    current = next;
  }
}
function stripPostgresCasts(value: string): string { return value.replace(/::(?:[A-Za-z_][A-Za-z0-9_]*)(?:\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\[\])?$/u, "").trim(); }
function stripPostgresOuter(value: string): string { while (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim(); return value; }

export function collectPostgresIndexes(rows: readonly Row[], exact = false): IntrospectedIndex[] {
  const byName = new Map<string, { unique: boolean; columns: string[]; method: "btree" | undefined; backingConstraint: boolean; unsupported: boolean; predicate?: string }>();
  for (const row of rows) {
    const name = String(row.index_name); let index = byName.get(name);
    if (!index) { index = { unique: row.is_unique === true, columns: [], method: String(row.method) === "btree" ? "btree" : undefined, backingConstraint: row.backing_constraint === true, unsupported: row.is_expression === true || row.is_valid !== true || row.is_ready !== true }; if (row.has_predicate === true) index.predicate = "unsupported"; byName.set(name, index); }
    if (row.column_name == null || (exact && row.is_include === true)) index.unsupported = true; else index.columns.push(String(row.column_name));
  }
  return [...byName.entries()].map(([name, value]) => ({ name, unique: value.unique, columns: value.columns, method: value.method, backingConstraint: value.backingConstraint, predicate: value.predicate, unsupported: value.unsupported }));
}

export function collectPostgresForeignKeys(rows: readonly Row[], exact = false): IntrospectedForeignKey[] {
  const byName = new Map<string, { columns: string[]; targetColumns: string[]; targetSchema: string; targetTable: string; onDelete: string; onUpdate: string; deferrable: boolean; unsupported: boolean }>();
  for (const row of rows) {
    const name = String(row.constraint_name); let foreignKey = byName.get(name);
    if (!foreignKey) { const onDelete = postgresAction(String(row.delete_code)); const onUpdate = postgresAction(String(row.update_code)); foreignKey = { columns: [], targetColumns: [], targetSchema: String(row.target_schema), targetTable: String(row.target_table), onDelete: onDelete.value, onUpdate: onUpdate.value, deferrable: row.deferrable === true, unsupported: onDelete.unsupported || onUpdate.unsupported || String(row.match_code) !== "s" || (exact && row.validated !== true) }; byName.set(name, foreignKey); }
    foreignKey.columns.push(String(row.column_name)); foreignKey.targetColumns.push(String(row.target_column));
  }
  return [...byName.entries()].map(([name, value]) => ({ name, ...value, targetSchema: value.targetSchema === "public" ? null : value.targetSchema }));
}

function postgresAction(code: string): { readonly value: string; readonly unsupported: boolean } { switch (code) { case "a": return { value: "noAction", unsupported: false }; case "r": return { value: "restrict", unsupported: false }; case "c": return { value: "cascade", unsupported: false }; case "n": return { value: "setNull", unsupported: false }; default: return { value: "unknown", unsupported: true }; } }

export function canonicalPostgresCheck(name: string, definition: string): { readonly name: string; readonly expression: unknown; readonly unsupported: boolean } {
  const body = definition.trim().match(/^CHECK\s*\((.*)\)$/isu)?.[1]?.replace(/::(?:[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)/gu, "");
  const expression = body === undefined ? undefined : parseRenderedCheck(body);
  return { name, expression: expression ?? { kind: "unsupported" }, unsupported: expression === undefined };
}

