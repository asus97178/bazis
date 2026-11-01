import { expect, test } from "bun:test";
import { Global, Module, singleton, singletonValue } from "@/core/di";
import { DATABASE_PROVIDER } from "@/core/orm";
import { postgres } from "@/library/orm";
import { createTestContainer } from "@/core/testing";
import { DefaultWorkflowInputValidator, WorkflowInputValidator, WorkflowModule } from "@/core/workflow";

export class AppValidator extends DefaultWorkflowInputValidator {}

// The stores need a provider to be wired; nothing here connects to it.
@Global()
@Module({ providers: [singletonValue(DATABASE_PROVIDER, postgres({ url: "postgres://127.0.0.1:1/none" }))], exports: [DATABASE_PROVIDER] })
class TestDatabase {}

test("the module's default input validator stands until the application registers its own, in any of its modules", async () => {
  @Module({ imports: [TestDatabase, WorkflowModule] }) class PlainApp {}
  expect((await createTestContainer(PlainApp)).createScope().resolve(WorkflowInputValidator)).toBeInstanceOf(DefaultWorkflowInputValidator);

  @Module({ imports: [WorkflowModule], providers: [singleton(WorkflowInputValidator, AppValidator)], exports: [] }) class CmsWorkflowModule {}
  @Module({ imports: [TestDatabase, CmsWorkflowModule] }) class AppModule {}
  expect((await createTestContainer(AppModule)).createScope().resolve(WorkflowInputValidator)).toBeInstanceOf(AppValidator);
});
