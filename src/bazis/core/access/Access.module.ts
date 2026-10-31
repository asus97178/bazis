import { DI, Module, SERVICE_PROVIDER } from "../di";
import { AccessCatalog } from "./catalog/AccessCatalog";
import { accessCatalogOf } from "./catalog/moduleFields";
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
 * `@Module({ roles })`, and the catalog over HTTP.
 */
@Module({
  config: [accessConfig],
  permissions: accessPermissions,
  providers: [
    DI.singleton(DI.factoryProviderWithResolver(AccessCatalog, [], (resolver) => accessCatalogOf(resolver.resolve(SERVICE_PROVIDER)))),
    DI.singleton(DI.factoryProviderWithResolver(RolesAccessPolicy, [], (resolver) => new RolesAccessPolicy(resolver.resolve(AccessCatalog), resolver.resolve(accessConfig.token)))),
    DI.scoped(DI.factoryProviderWithResolver(Access, [], (resolver) => new Access(resolver, resolver.resolve(AccessCatalog), resolver.resolve(accessConfig.token)))),
  ],
  controllers: [DI.bindDeps(AccessCatalogController, AccessCatalog)],
  exports: [AccessCatalog, Access, RolesAccessPolicy],
})
export class AccessModule {}
