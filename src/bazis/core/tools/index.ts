/**
 * Tools that come with the framework (WORKFLOW-002 §7): actions over the
 * application's entities for processes and agents, closed by default.
 */
import "./generated/deps";

export { StandardToolsModule } from "./StandardTools.module";
export { ormEntityTools, type OrmEntityOperation, type OrmEntityToolsOptions } from "./orm/ormEntityTools";
