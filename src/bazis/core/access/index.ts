/**
 * Access as a layer of the framework (ACCESS-001): modules declare
 * permissions, the application's rights system answers with grants, the
 * framework checks objects and filters lists by them.
 */
import "./catalog/moduleFields";
import "./generated/deps";
import type { accessPermissions } from "./Access.module";
import type { PermissionsOf } from "./catalog/permissions";

/**
 * The permissions the application declares, by key: what `can`, `access.can`,
 * `access.filter` and `defineRoles` accept. Nobody writes it by hand: `bazis codegen`
 * fills it from `permissions` of the application's modules
 * (`src/generated/bazis/permissions.ts`), a framework pack from its own.
 */
export interface BazisPermissions extends PermissionsOf<typeof accessPermissions> {}

/**
 * The prefixes of the application's permission sources (ACCESS-001 §3.1): any
 * key under one of them is accepted by `can`, `access.can` and `access.filter`.
 * Nobody writes it by hand: `bazis codegen` fills it from `permissionSources`
 * of the application's modules.
 */
export interface BazisPermissionSources {}

export { AccessModule } from "./Access.module";
export { definePermissions, type AnyPermissionKey, type AttributeSpec, type OwnPermissionKey, type PermissionDeclarations, type PermissionKey, type PermissionsOf, type PermissionSpec, type ScopeSource, type SourcePermissionKey } from "./catalog/permissions";
export type { PermissionSourceState } from "./catalog/PermissionSources";
export { IAccessCatalog } from "./catalog/IAccessCatalog.service";
export type { DeclaredRole, OwnedPermission, OwnedReferenceKind } from "./catalog/AccessCatalog";
export { IAccess } from "./check/IAccess.service";
export { SubjectAccess, maskFields, type FieldAccess } from "./check/Access";
export { accessConfig } from "./check/accessConfig";
export { can } from "./check/can";
export { grantsToWhere, type AccessFilter, type ColumnCondition } from "./check/filter";
export { AccessPolicy, type ScopePrincipals } from "./contracts/AccessPolicy";
export { AttributeLookup, type LookupColumn } from "./contracts/AttributeLookup";
export { PermissionSource } from "./contracts/PermissionSource";
export { References, type ReferenceContext, type ReferenceItem, type ReferencePage } from "./contracts/References";
export { AccessFilterTooLargeError, AccessSetupError } from "./contracts/errors";
export type {
  AccessObject,
  AccessSubject,
  AccessValue,
  CompareTest,
  Condition,
  Grant,
  GrantFields,
  Grants,
  LocalizedText,
  Scope,
  ValueTest,
} from "./contracts/types";
export { defineRoles, type RoleDeclarations, type RoleGrant } from "./roles/roles";
export { RolesAccessPolicy, type RoleSubject } from "./roles/RolesAccessPolicy";
