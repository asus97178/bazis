import type { SafeSchemaDescriptor, SchemaDifference, SchemaDifferenceCode, SchemaVerificationResult } from "./ExactSchemaVerifier";

const descriptions: Record<SchemaDifferenceCode, string> = {
  "table.missing": "table is missing",
  "column.missing": "column is missing",
  "column.unexpected": "column exists in the database but is absent from the ORM model",
  "column.type": "column type differs",
  "column.nullability": "column NOT NULL constraint differs",
  "column.default": "column default differs",
  "column.generation": "column generation strategy differs",
  "primaryKey.missing": "primary key is missing",
  "primaryKey.unexpected": "primary key is not declared in the ORM model",
  "primaryKey.name": "primary key name differs",
  "primaryKey.columns": "primary key columns or their order differ",
  "index.missing": "index is missing",
  "index.unexpected": "index is not declared in the ORM model",
  "index.name": "index name differs",
  "index.columns": "index columns or their order differ",
  "index.uniqueness": "index uniqueness differs",
  "index.method": "index method differs",
  "index.unsupportedShape": "index shape is unsupported by exact schema admission",
  "foreignKey.missing": "foreign key is missing",
  "foreignKey.unexpected": "foreign key is not declared in the ORM model",
  "foreignKey.name": "foreign key name differs",
  "foreignKey.columns": "foreign key columns or their order differ",
  "foreignKey.target": "foreign key target differs",
  "foreignKey.actions": "foreign key referential actions differ",
  "foreignKey.deferrable": "foreign key deferrability differs",
  "foreignKey.match": "foreign key match type differs",
  "check.missing": "CHECK constraint is missing",
  "check.unexpected": "CHECK constraint is not declared in the ORM model",
  "check.name": "CHECK constraint name differs",
  "check.expression": "CHECK constraint expression differs",
  "catalog.unsupported": "catalog shape is unsupported by exact schema admission",
};

/** Formats only the verifier's safe descriptors; never SQL, rows or literal defaults. */
export function formatSchemaDifferences(verification: SchemaVerificationResult): string {
  return verification.differences.map(formatDifference).join("\n");
}

function formatDifference(difference: SchemaDifference): string {
  const table = `${JSON.stringify(difference.schema)}.${JSON.stringify(difference.table)}`;
  const object = difference.objectName === undefined ? "" : `, object ${JSON.stringify(difference.objectName)}`;
  return `- Table ${table}${object}: ${descriptions[difference.code]} (${difference.code}); `
    + `expected (ORM): ${formatDescriptor(difference.expected, difference.code)}; actual (database): ${formatDescriptor(difference.actual, difference.code)}.`;
}

function formatDescriptor(descriptor: SafeSchemaDescriptor | undefined, code: SchemaDifferenceCode): string {
  if (!descriptor) return "unspecified";
  // These kinds intentionally expose fingerprints, even if a caller supplies a value.
  if (descriptor.kind === "canonicalDefault" || descriptor.kind === "canonicalExpression") {
    return descriptor.hash ? `${descriptor.kind} fingerprint ${JSON.stringify(descriptor.hash)}` : `${descriptor.kind} (value hidden)`;
  }
  if (code === "column.nullability" && descriptor.kind === "present") {
    if (descriptor.value === "true") return "NOT NULL";
    if (descriptor.value === "false") return "NULL allowed";
  }
  if (descriptor.values) return JSON.stringify(descriptor.values);
  if (descriptor.value !== undefined) return JSON.stringify(descriptor.value);
  return descriptor.kind;
}
