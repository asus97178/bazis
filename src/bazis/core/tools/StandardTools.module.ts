import { AccessModule } from "../access";
import { Module, singleton } from "../di";
import { OrmEntityReferences, OrmFieldReferences } from "./orm/OrmEntity.references";

/**
 * Tools that come with the framework (WORKFLOW-002 §7): not needed until an
 * application imports it. For now it owns the reference kinds of `ormEntityTools`.
 */
@Module({
  imports: [AccessModule],
  references: { "orm.entity": OrmEntityReferences, "orm.field": OrmFieldReferences },
  providers: [singleton(OrmEntityReferences), singleton(OrmFieldReferences)],
})
export class StandardToolsModule {}
