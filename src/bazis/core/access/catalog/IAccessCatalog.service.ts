import type { Grant } from "../contracts/types";
import type { DeclaredRole, OwnedPermission, OwnedReferenceKind } from "./AccessCatalog";
import type { PermissionSourceState } from "./PermissionSources";

/**
 * What the application's modules declared about access: permissions, reference
 * kinds and default roles (ACCESS-001 §3, §6, §8), checked when the application
 * is built, and the permissions of the sources (§3.1), read while it runs.
 */
export abstract class IAccessCatalog {
  /** The declared permissions and the ones the sources give now. */
  abstract permissions(): readonly OwnedPermission[];
  abstract permission(key: string): OwnedPermission | undefined;
  /** The permission or an error: asking for an undeclared one is a bug of the caller. */
  abstract require(key: string): OwnedPermission;
  /**
   * The permission for a check. A key of a source that the source does not
   * give now is `undefined` — nobody has it; before answering so the catalog
   * compares the source's version (`verify` — even when the key is there: a
   * grant named an attribute the catalog does not know). A key that is neither
   * declared nor of a source is an error, like in {@link require}.
   */
  abstract find(key: string, options?: { readonly verify?: boolean }): Promise<OwnedPermission | undefined>;
  /**
   * Why the grant cannot be used for the permission now, or `undefined`: the
   * checks a request runs (ACCESS-001 §4.2). A rights system calls it when it
   * saves a rule and answers 422, instead of learning it from a warning in the
   * log of a request.
   */
  abstract grantProblem(permission: string, grant: Grant): Promise<string | undefined>;
  /**
   * The data of the source of this prefix changed: read its permissions again
   * now, all of them or only `keys`. Call it after the transaction is
   * committed; other instances learn it from the source's version.
   */
  abstract changed(prefix: string, keys?: readonly string[]): Promise<void>;
  /** The sources and what is known about them now. */
  abstract sources(): readonly PermissionSourceState[];
  abstract referenceKinds(): readonly OwnedReferenceKind[];
  abstract referenceKind(kind: string): OwnedReferenceKind | undefined;
  abstract roles(): readonly DeclaredRole[];
  abstract role(name: string): DeclaredRole | undefined;
}
