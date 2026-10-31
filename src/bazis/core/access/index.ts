/**
 * Access as a layer of the framework (ACCESS-001): modules declare
 * permissions, the application's rights system answers with grants, the
 * framework checks objects and filters lists by them.
 */
import "./catalog/moduleFields";

export { AccessModule } from "./Access.module";
export { definePermissions, type AttributeSpec, type PermissionDeclarations, type PermissionSpec, type ScopeSource } from "./catalog/permissions";
export { AccessCatalog, type DeclaredRole, type OwnedPermission, type OwnedReferenceKind } from "./catalog/AccessCatalog";
export { Access, SubjectAccess, maskFields, type FieldAccess } from "./check/Access";
export { accessConfig } from "./check/accessConfig";
export { can } from "./check/can";
export { grantsToWhere, type AccessFilter, type ColumnCondition } from "./check/filter";
export { AccessPolicy, type ScopePrincipals } from "./contracts/AccessPolicy";
export { AttributeLookup, type LookupColumn } from "./contracts/AttributeLookup";
export { References, type ReferenceContext, type ReferenceItem, type ReferencePage } from "./contracts/References";
export { AccessFilterTooLargeError, AccessSetupError } from "./contracts/errors";
export type {
  AccessObject,
  AccessSubject,
  AccessValue,
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
