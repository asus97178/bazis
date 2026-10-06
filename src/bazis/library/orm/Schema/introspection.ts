/**
 * Snapshot of the actual database schema obtained by introspection. The source
 * of the "current" state for the additive auto-migration (the target is the
 * model from the decorators).
 */

export interface IntrospectedColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly isPrimaryKey: boolean;
  /** Strict providers report canonical physical details; absent is fail-closed for exact verification. */
  readonly physicalType?: string;
  readonly default?: CanonicalDefault;
  readonly generation?: GenerationStrategy;
  /** Catalog form could not be decoded into the closed strict-v1 domain. */
  readonly unsupported?: boolean;
}

export interface IntrospectedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly method?: "btree";
  readonly backingConstraint?: boolean;
  readonly predicate?: string;
  readonly unsupported?: boolean;
}

export type CanonicalDefault = { readonly kind: "none" | "null" | "currentTimestamp" | "uuidV4" } | { readonly kind: "boolean"; readonly value: boolean } | { readonly kind: "number"; readonly value: number } | { readonly kind: "string"; readonly value: string };
export type GenerationStrategy = "none" | "identityByDefault" | "uuidDefault";
export interface IntrospectedPrimaryKey { readonly name: string; readonly columns: readonly string[] }
export interface IntrospectedForeignKey { readonly name: string; readonly columns: readonly string[]; readonly targetSchema: string | null; readonly targetTable: string; readonly targetColumns: readonly string[]; readonly onDelete: string; readonly onUpdate: string; readonly deferrable?: boolean; readonly unsupported?: boolean }
export interface IntrospectedCheck { readonly name: string; readonly expression: unknown; readonly unsupported?: boolean }

export interface IntrospectedTable {
  readonly name: string;
  /** Columns by name. */
  readonly columns: ReadonlyMap<string, IntrospectedColumn>;
  readonly indexes: readonly IntrospectedIndex[];
  readonly primaryKey?: IntrospectedPrimaryKey;
  readonly foreignKeys?: readonly IntrospectedForeignKey[];
  readonly checks?: readonly IntrospectedCheck[];
  /** The provider observed an unsupported table-level catalog shape. */
  readonly unsupported?: boolean;
}

export interface IntrospectedSchema {
  /** Tables by name. */
  readonly tables: ReadonlyMap<string, IntrospectedTable>;
  /** Normalized physical schemas observed by the provider for this admission unit. */
  readonly schemas?: ReadonlySet<string>;
}
