/** Entity state in the tracker (as in EF Core). */
export enum EntityState {
  /** Not tracked. */
  Detached = "Detached",
  /** Loaded/attached, no changes. */
  Unchanged = "Unchanged",
  /** New, will be inserted. */
  Added = "Added",
  /** Changed, will be updated. */
  Modified = "Modified",
  /** Will be deleted. */
  Deleted = "Deleted",
}
