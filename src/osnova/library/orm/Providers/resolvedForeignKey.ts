import type { ColumnType, EntityModel } from "../Metadata/types";
import type { ForeignKeyConstraint } from "./types";

/** Internal model-backed DDL metadata. Legacy caller-supplied constraints keep
 * their existing columnType and schema.table string contract. */
interface ResolvedForeignKey {
  readonly target: EntityModel;
  readonly columnTypes: ReadonlyMap<string, ColumnType | "uuid">;
}
const resolved = new WeakMap<ForeignKeyConstraint, ResolvedForeignKey>();
export function bindResolvedForeignKey(constraint: ForeignKeyConstraint, metadata: ResolvedForeignKey): void {
  resolved.set(constraint, metadata);
}
export function resolvedForeignKey(constraint: ForeignKeyConstraint): ResolvedForeignKey | undefined {
  return resolved.get(constraint);
}
