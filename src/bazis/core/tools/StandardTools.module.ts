import { AccessModule } from "../access";
import { Module, singleton } from "../di";
import { toolsConfig } from "./contracts/Tools.config";
import { HttpRequestTool } from "./http/HttpRequest.tool";
import { OrmEntityReferences, OrmFieldReferences } from "./orm/OrmEntity.references";
import { ConfigSecretStore, SecretStore } from "./secrets/SecretStore";

/**
 * Tools that come with the framework (WORKFLOW-002 §7): not needed until an
 * application imports it. Here are `http.request`, closed until `tools.http.allow`
 * lists a host, the values of `$secrets` and the reference kinds of `ormEntityTools`.
 * The application replaces the secrets by registering its `SecretStore`.
 */
@Module({
  imports: [AccessModule],
  config: [toolsConfig],
  references: { "orm.entity": OrmEntityReferences, "orm.field": OrmFieldReferences },
  tools: [HttpRequestTool],
  providers: [singleton(SecretStore, ConfigSecretStore)],
  exports: [SecretStore],
})
export class StandardToolsModule {}
