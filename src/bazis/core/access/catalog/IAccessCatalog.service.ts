import type { DeclaredRole, OwnedPermission, OwnedReferenceKind } from "./AccessCatalog";

/**
 * What the application's modules declared about access: permissions, reference
 * kinds and default roles (ACCESS-001 §3, §6, §8). Checked when the application
 * is built.
 */
export abstract class IAccessCatalog {
  abstract permissions(): readonly OwnedPermission[];
  abstract permission(key: string): OwnedPermission | undefined;
  /** The permission or an error: asking for an undeclared one is a bug of the caller. */
  abstract require(key: string): OwnedPermission;
  abstract referenceKinds(): readonly OwnedReferenceKind[];
  abstract referenceKind(kind: string): OwnedReferenceKind | undefined;
  abstract roles(): readonly DeclaredRole[];
  abstract role(name: string): DeclaredRole | undefined;
}
