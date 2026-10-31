import { Module, SERVICE_PROVIDER, singleton } from "../di";
import { AccessCatalog } from "./catalog/AccessCatalog";
import { IAccessCatalog } from "./catalog/IAccessCatalog.service";
import { definePermissions } from "./catalog/permissions";
import { Access } from "./check/Access";
import { accessConfig } from "./check/accessConfig";
import { IAccess } from "./check/IAccess.service";
import { AccessPolicy } from "./contracts/AccessPolicy";
import { AccessCatalogController } from "./http/AccessCatalog.controller";
import { RolesAccessPolicy } from "./roles/RolesAccessPolicy";

const accessPermissions = definePermissions({
  "access.catalog.read": {
    title: { en: "See the permissions catalog", ru: "Видеть каталог прав" },
  },
});

/**
 * Access as a layer of the framework (ACCESS-001, [passport](MODULE.md)):
 * the catalog of the modules' permissions, checks and list filters by the
 * grants of the application's `AccessPolicy`, the default rights system by
 * `@Module({ roles })`, and the catalog over HTTP. An application replaces the
 * rights system by registering its own `AccessPolicy`. Dependencies are
 * explicit: the framework's classes are not covered by the application's codegen.
 */
@Module({
  config: [accessConfig],
  permissions: accessPermissions,
  providers: [
    singleton(IAccessCatalog, AccessCatalog, [SERVICE_PROVIDER] as const),
    singleton(AccessPolicy, RolesAccessPolicy, [IAccessCatalog, accessConfig.token] as const),
    singleton(IAccess, Access, [IAccessCatalog, accessConfig.token] as const),
  ],
  controllers: [AccessCatalogController],
  exports: [IAccessCatalog, IAccess, AccessPolicy],
})
export class AccessModule {}
