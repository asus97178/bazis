import { Module, SERVICE_PROVIDER, singleton } from "../di";
import { AccessCatalog } from "./catalog/AccessCatalog";
import { definePermissions } from "./catalog/permissions";
import { Access } from "./check/Access";
import { accessConfig } from "./check/accessConfig";
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
 * `@Module({ roles })`, and the catalog over HTTP. Dependencies are explicit:
 * the framework's classes are not covered by the application's codegen.
 */
@Module({
  config: [accessConfig],
  permissions: accessPermissions,
  providers: [
    singleton(AccessCatalog, AccessCatalog, [SERVICE_PROVIDER] as const),
    singleton(RolesAccessPolicy, RolesAccessPolicy, [AccessCatalog, accessConfig.token] as const),
    singleton(Access, Access, [AccessCatalog, RolesAccessPolicy, accessConfig.token] as const),
  ],
  controllers: [AccessCatalogController],
  exports: [AccessCatalog, Access, RolesAccessPolicy],
})
export class AccessModule {}
