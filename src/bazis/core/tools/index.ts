/**
 * Tools that come with the framework (WORKFLOW-002 §7): HTTP requests, actions over
 * the application's entities and secrets, for processes and agents, closed by default.
 */
import "./generated/deps";

export { StandardToolsModule } from "./StandardTools.module";
export { toolsConfig, type ToolsSettings } from "./contracts/Tools.config";
export { HttpRequestTool } from "./http/HttpRequest.tool";
export { ConfigSecretStore, SecretStore, type SecretContext } from "./secrets/SecretStore";
export { ormEntityTools, type OrmEntityOperation, type OrmEntityToolsOptions } from "./orm/ormEntityTools";
