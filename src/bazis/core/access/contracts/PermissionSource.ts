import type { PermissionDeclarations } from "../catalog/permissions";

/**
 * Permissions that appear while the application runs (ACCESS-001 §3.1): a
 * data manager's tables and their fields. A class of the declaring module,
 * named in `@Module({ permissionSources: { <prefix>: Class } })`; the catalog
 * creates it in a scope of its own for one reading, so it may take a
 * `DbContext`. It owns every key that starts with `<prefix>.`.
 *
 * ```ts
 * export class DataPermissionSource extends PermissionSource {
 *   constructor(private readonly db: DataDbContext) { super(); }
 *   async version() { return String((await this.db.meta.first()).version); }
 *   async load() { return Object.fromEntries((await this.db.tables.toList()).map((table) => [`data.${table.code}.read`, specOf(table)])); }
 * }
 * ```
 */
export abstract class PermissionSource {
  /**
   * The version of the source's data: a counter or a timestamp that changes in
   * one transaction with the data. Every instance of the application asks it
   * every `access.sourcePollSeconds` and reads the permissions again when it
   * differs. Nothing — `undefined`, `null`, an empty string — is a failed
   * reading: it would look like a version that never changes.
   */
  abstract version(): PermissionSourceVersion | Promise<PermissionSourceVersion>;

  /**
   * The permissions of the prefix, in the form of `definePermissions`. With
   * `keys` — only these: a key missing from the answer is a removed permission.
   */
  abstract load(keys?: readonly string[]): PermissionDeclarations | Promise<PermissionDeclarations>;
}

/** A counter (a number, a bigint) or any non-empty string: the catalog only tells whether it differs. */
export type PermissionSourceVersion = string | number | bigint;
