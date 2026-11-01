import type { AccessValue } from "./types";

/**
 * Turns a condition on an attribute that is not a column of the listed rows
 * into a condition on a column (ACCESS-001 §3): `folder in [Sales]` →
 * `processKey in [keys of the folder's processes]`. A class of the declaring
 * module, registered in its `providers`; it is resolved in the request scope.
 */
export abstract class AttributeLookup {
  /** The column and its values equivalent to "the attribute is one of `values`" (`null` — the attribute is empty). */
  abstract toColumn(values: readonly AccessValue[]): Promise<LookupColumn> | LookupColumn;
}

export interface LookupColumn {
  readonly column: string;
  readonly in: readonly AccessValue[];
}
