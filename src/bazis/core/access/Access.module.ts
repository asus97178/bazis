import { Module, singleton } from "../di";
import { AccessCatalog } from "./catalog/AccessCatalog";
import { IAccessCatalog } from "./catalog/IAccessCatalog.service";
import { definePermissions } from "./catalog/permissions";
import { PermissionSourceLoader } from "./catalog/PermissionSourceLoader";
import { PermissionSources } from "./catalog/PermissionSources";
import { Access } from "./check/Access";
import { accessConfig } from "./check/accessConfig";
import { IAccess } from "./check/IAccess.service";
import { AccessPolicy } from "./contracts/AccessPolicy";
import { AccessCatalogController } from "./http/AccessCatalog.controller";
import { RolesAccessPolicy } from "./roles/RolesAccessPolicy";

export const accessPermissions = definePermissions({
  "access.catalog.read": {
    title: { en: "See the permissions catalog", ru: "Видеть каталог прав" },
  },
});

/**
 * Access as a layer of the framework (ACCESS-001, [passport](MODULE.md)):
 * the catalog of the modules' permissions, checks and list filters by the
 * grants of the application's `AccessPolicy`, the default rights system by
 * `@Module({ roles })`, and the catalog over HTTP. An application replaces the
 * rights system by registering its own `AccessPolicy`. Permissions that appear
 * while the application runs come from `@Module({ permissionSources })`.
 */
@Module({
  config: [accessConfig],
  permissions: accessPermissions,
  providers: [
    singleton(PermissionSources),
    singleton(IAccessCatalog, AccessCatalog),
    singleton(AccessPolicy, RolesAccessPolicy),
    singleton(IAccess, Access),
  ],
  controllers: [AccessCatalogController],
  background: [PermissionSourceLoader],
  exports: [IAccessCatalog, IAccess, AccessPolicy],
})
export class AccessModule {}
