import { describe, expect, test } from "bun:test";
import { getGeneratedClassDeps } from "@/core/di/module/autoDeps";
import { createContainer, DI, ServiceCollection, ServiceValidationError, singleton } from "@/core/di";
import { setClassDeps } from "@/core/di/internal/classDeps";
import { resolveGeneratedBindings } from "@/core/http/Binding/autoBindings";
import { findListModelByName } from "@/core/http/Binding/listModelRegistry";
import { findRequestModelByName } from "@/core/http/Binding/requestModelRegistry";
import { getGeneratedOpenApiMetadata, registerGeneratedOpenApiSchemaModel } from "@/core/http/OpenApi/generatedOpenApiRegistry";
import { loadOsnvGeneratedAgentMetadata, registerOsnvGeneratedTargetDescriptor, type OsnvGeneratedTargetDescriptor } from "@/core/generatedRuntime";
import type { AgentMetadataIndex } from "@/core/agent";
import {
  createGeneratedProviderAttachmentChannel,
  getGeneratedProviderAttachment,
} from "@/core/di/module/generatedProviderAttachments";

function descriptor(
  id: string,
  dependency: new () => object,
  controller: new () => object,
  request: new () => object,
  list: new () => object,
  schemaModel: abstract new (...args: never[]) => object,
  schemaName: string,
  agentMetadata?: AgentMetadataIndex,
): OsnvGeneratedTargetDescriptor {
  return {
    id,
    classDeps: [[dependency, ["generated-runtime-transaction-dependency"]]],
    bindings: [[controller, {
      save: [{ source: "body", model: request.name }],
      list: [{ source: "list", model: list.name }],
    }]],
    requestModels: [request],
    requestShapes: [],
    listModels: [list],
    openApi: {
      schemas: { [schemaName]: { type: "object" } },
      operations: { [controller.name]: { save: { response: { $ref: `#/components/schemas/${schemaName}` } } } },
    },
    openApiSchemaModels: [[schemaModel, schemaName]],
    agentMetadata,
  };
}

describe("generated target runtime transaction", () => {
  test("late committed generated class deps normalize a pre-bootstrap class provider", async () => {
    class LateGeneratedDependency { public readonly value = "ready"; }
    class LateGeneratedService {
      public constructor(public readonly dependency: LateGeneratedDependency) {}
    }
    // These shortcuts intentionally run before the target descriptor commits.
    const moduleRef = { providers: [singleton(LateGeneratedDependency), singleton(LateGeneratedService)] };
    await registerOsnvGeneratedTargetDescriptor({
      id: "late-generated-provider-normalization",
      classDeps: [[LateGeneratedService, ["LateGeneratedDependency"]]],
      bindings: [], requestModels: [], requestShapes: [], listModels: [],
      openApi: { schemas: {}, operations: {} }, openApiSchemaModels: [],
    });

    const container = createContainer(moduleRef, { validateOnBuild: true });
    expect(container.resolve(LateGeneratedService).dependency.value).toBe("ready");
  });

  test("direct ServiceCollection builds use late generated deps without overriding explicit or class-bound deps", async () => {
    class LateDirectDependency { public readonly value = "generated"; }
    class LateDirectService {
      public constructor(public readonly dependency: LateDirectDependency) {}
    }
    class ExplicitDependency {}
    class ExplicitService {
      public constructor(_dependency: ExplicitDependency) {}
    }
    class ClassBoundDependency { public readonly value = "class-bound"; }
    class GeneratedPriorityDependency {}
    class ClassBoundService {
      public constructor(public readonly dependency: ClassBoundDependency) {}
    }

    // Provider definitions are created before the descriptor commits.
    const direct = singleton(LateDirectService);
    const explicitEmpty = DI.singleton(DI.classProvider(ExplicitService, ExplicitService, []));
    setClassDeps(ClassBoundService, [ClassBoundDependency]);
    const classBound = singleton(ClassBoundService);
    await registerOsnvGeneratedTargetDescriptor({
      id: "late-direct-service-collection-normalization",
      classDeps: [
        [LateDirectService, ["LateDirectDependency"]],
        [ExplicitService, ["ExplicitDependency"]],
        [ClassBoundService, ["GeneratedPriorityDependency"]],
      ],
      bindings: [], requestModels: [], requestShapes: [], listModels: [],
      openApi: { schemas: {}, operations: {} }, openApiSchemaModels: [],
    });

    const directServices = new ServiceCollection();
    directServices.add(singleton(LateDirectDependency));
    directServices.add(direct);
    const directProvider = directServices.buildServiceProvider({ validateOnBuild: true });
    expect(directProvider.resolve(LateDirectService).dependency.value).toBe("generated");

    const explicitServices = new ServiceCollection();
    explicitServices.add(singleton(ExplicitDependency));
    explicitServices.add(explicitEmpty);
    expect(() => explicitServices.buildServiceProvider({ validateOnBuild: true })).toThrow(ServiceValidationError);

    const classBoundServices = new ServiceCollection();
    classBoundServices.add(singleton(ClassBoundDependency));
    classBoundServices.add(classBound);
    expect(classBoundServices.buildServiceProvider({ validateOnBuild: true }).resolve(ClassBoundService).dependency.value).toBe("class-bound");
  });

  test("rolls back every owner after a mid-commit failure and permits retry", async () => {
    class RollbackController {}
    class RollbackDependency {}
    class RollbackRequest {}
    class RollbackList {}
    class RollbackSchema {}
    registerGeneratedOpenApiSchemaModel(RollbackSchema, "BeforeRollback");
    const failed = descriptor("rollback-transaction", RollbackDependency, RollbackController, RollbackRequest, RollbackList, RollbackSchema, "AfterRollback");

    await expect(registerOsnvGeneratedTargetDescriptor(failed)).rejects.toThrow("already bound to schema BeforeRollback");
    expect(getGeneratedClassDeps(RollbackDependency)).toBeUndefined();
    expect(resolveGeneratedBindings(RollbackController, "save")).toBeUndefined();
    expect(findRequestModelByName("RollbackRequest")).toBeUndefined();
    expect(findListModelByName("RollbackList")).toBeUndefined();
    expect(getGeneratedOpenApiMetadata([RollbackController]).schemas).not.toHaveProperty("AfterRollback");

    await registerOsnvGeneratedTargetDescriptor(descriptor(
      "rollback-transaction",
      RollbackDependency,
      RollbackController,
      RollbackRequest,
      RollbackList,
      RollbackSchema,
      "BeforeRollback",
    ));
    expect(resolveGeneratedBindings(RollbackController, "save")?.[0]).toMatchObject({ source: "body", model: RollbackRequest });
  });

  test("coalesces concurrent registration of one target", async () => {
    class ConcurrentController {}
    class ConcurrentDependency {}
    class ConcurrentRequest {}
    class ConcurrentList {}
    class ConcurrentSchema {}
    const value = descriptor("concurrent-transaction", ConcurrentDependency, ConcurrentController, ConcurrentRequest, ConcurrentList, ConcurrentSchema, "ConcurrentSchema");

    await Promise.all([registerOsnvGeneratedTargetDescriptor(value), registerOsnvGeneratedTargetDescriptor(value)]);
    expect(getGeneratedOpenApiMetadata([ConcurrentController]).schemas).toEqual({ ConcurrentSchema: { type: "object" } });
    expect(resolveGeneratedBindings(ConcurrentController, "save")?.[0]).toMatchObject({ source: "body", model: ConcurrentRequest });
  });

  test("keeps same-name request and list models local to their controller target", async () => {
    class ProductionController {}
    class DemoController {}
    class ProductionDependency {}
    class DemoDependency {}
    const ProductionRequest = class SameRequest {};
    const DemoRequest = class SameRequest {};
    const ProductionList = class SameList {};
    const DemoList = class SameList {};
    class ProductionSchema {}
    class DemoSchema {}

    await registerOsnvGeneratedTargetDescriptor(descriptor("production-isolation", ProductionDependency, ProductionController, ProductionRequest, ProductionList, ProductionSchema, "ProductionOnly"));
    await registerOsnvGeneratedTargetDescriptor(descriptor("demo-isolation", DemoDependency, DemoController, DemoRequest, DemoList, DemoSchema, "DemoOnly"));

    expect(resolveGeneratedBindings(ProductionController, "save")?.[0]).toMatchObject({ source: "body", model: ProductionRequest });
    expect(resolveGeneratedBindings(DemoController, "save")?.[0]).toMatchObject({ source: "body", model: DemoRequest });
    expect(resolveGeneratedBindings(ProductionController, "list")?.[0]).toMatchObject({ source: "list", model: ProductionList });
    expect(resolveGeneratedBindings(DemoController, "list")?.[0]).toMatchObject({ source: "list", model: DemoList });
  });

  test("selects OpenAPI metadata only for the current controller target", async () => {
    class ProductionOpenApiController {}
    class DemoOpenApiController {}
    class ProductionOpenApiDependency {}
    class DemoOpenApiDependency {}
    class ProductionRequest {}
    class DemoRequest {}
    class ProductionList {}
    class DemoList {}
    class ProductionSchema {}
    class DemoSchema {}

    await registerOsnvGeneratedTargetDescriptor(descriptor("production-openapi", ProductionOpenApiDependency, ProductionOpenApiController, ProductionRequest, ProductionList, ProductionSchema, "ProductionOpenApiOnly"));
    await registerOsnvGeneratedTargetDescriptor(descriptor("demo-openapi", DemoOpenApiDependency, DemoOpenApiController, DemoRequest, DemoList, DemoSchema, "DemoOpenApiOnly"));

    expect(getGeneratedOpenApiMetadata([ProductionOpenApiController]).schemas).toHaveProperty("ProductionOpenApiOnly");
    expect(getGeneratedOpenApiMetadata([ProductionOpenApiController]).schemas).not.toHaveProperty("DemoOpenApiOnly");
    expect(getGeneratedOpenApiMetadata([DemoOpenApiController]).schemas).toHaveProperty("DemoOpenApiOnly");
    expect(getGeneratedOpenApiMetadata([DemoOpenApiController]).schemas).not.toHaveProperty("ProductionOpenApiOnly");
  });

  test("selects target-local generated Agent metadata by actual constructor", async () => {
    class DemoAgent {}
    class ProductionAgent {}
    class DemoController {}
    class ProductionController {}
    class Dependency {}
    class Request {}
    class List {}
    class DemoSchema {}
    class ProductionSchema {}
    const demoMetadata: AgentMetadataIndex = Object.freeze({
      agents: new Map([[DemoAgent, { name: "demo-agent", instructions: [], constraints: [], sections: [], tools: [], tasks: [] }]]),
      tools: new Map(),
      prompts: new Map(),
    });
    const productionMetadata: AgentMetadataIndex = Object.freeze({
      agents: new Map([[ProductionAgent, { name: "production-agent", instructions: [], constraints: [], sections: [], tools: [], tasks: [] }]]),
      tools: new Map(),
      prompts: new Map(),
    });
    await registerOsnvGeneratedTargetDescriptor(descriptor("agent-demo", Dependency, DemoController, Request, List, DemoSchema, "AgentDemoSchema", demoMetadata));
    await registerOsnvGeneratedTargetDescriptor(descriptor("agent-production", Dependency, ProductionController, Request, List, ProductionSchema, "AgentProductionSchema", productionMetadata));

    expect((await loadOsnvGeneratedAgentMetadata([DemoAgent]))?.agents.get(DemoAgent)?.name).toBe("demo-agent");
    expect((await loadOsnvGeneratedAgentMetadata([ProductionAgent]))?.agents.get(ProductionAgent)?.name).toBe("production-agent");
  });

  test("rolls back generated exact-class attachments and rejects divergent target payloads", async () => {
    class AttachmentTarget {}
    class AttachmentController {}
    class AttachmentDependency {}
    class AttachmentRequest {}
    class AttachmentList {}
    class AttachmentSchema {}
    class DivergenceSchema {}
    const channel = createGeneratedProviderAttachmentChannel<number>({
      description: "generated-runtime.transaction.test",
      normalize: (_target, value) => {
        if (typeof value !== "number") throw new TypeError("attachment value");
        return value;
      },
    });
    const failed = {
      ...descriptor("attachment-rollback", AttachmentDependency, AttachmentController, AttachmentRequest, AttachmentList, AttachmentSchema, "AttachmentSchema"),
      providerAttachments: [{ channel, target: AttachmentTarget, value: 1 }],
    };
    registerGeneratedOpenApiSchemaModel(AttachmentSchema, "AlreadyBoundAttachmentSchema");
    await expect(registerOsnvGeneratedTargetDescriptor(failed)).rejects.toThrow("already bound to schema");
    expect(getGeneratedProviderAttachment(channel, AttachmentTarget)).toBeUndefined();

    await registerOsnvGeneratedTargetDescriptor({
      ...failed,
      openApiSchemaModels: [[AttachmentSchema, "AlreadyBoundAttachmentSchema"]],
    });
    expect(getGeneratedProviderAttachment(channel, AttachmentTarget)).toBe(1);
    await expect(registerOsnvGeneratedTargetDescriptor({
      ...descriptor("attachment-divergence", AttachmentDependency, AttachmentController, AttachmentRequest, AttachmentList, DivergenceSchema, "AttachmentDivergenceSchema"),
      providerAttachments: [{ channel, target: AttachmentTarget, value: 2 }],
    })).rejects.toThrow("diverges");
    expect(getGeneratedProviderAttachment(channel, AttachmentTarget)).toBe(1);
  });

  test("normalizer and duplicate attachment failures happen before target registry mutation", async () => {
    class Target {}
    class Controller {}
    class Dependency {}
    class Request {}
    class List {}
    class Schema {}
    const channel = createGeneratedProviderAttachmentChannel<number>({
      description: "generated-runtime.preflight.test",
      normalize: (_target, value) => {
        if (typeof value !== "number") throw new TypeError("expected attachment number");
        return value;
      },
    });
    const base = descriptor("attachment-normalizer-retry", Dependency, Controller, Request, List, Schema, "AttachmentNormalizerSchema");
    await expect(registerOsnvGeneratedTargetDescriptor({
      ...base,
      providerAttachments: [{ channel, target: Target, value: "invalid" }],
    })).rejects.toThrow("expected attachment number");
    expect(getGeneratedClassDeps(Dependency)).toBeUndefined();
    expect(resolveGeneratedBindings(Controller, "save")).toBeUndefined();
    expect(getGeneratedProviderAttachment(channel, Target)).toBeUndefined();

    await registerOsnvGeneratedTargetDescriptor({
      ...base,
      providerAttachments: [{ channel, target: Target, value: 1 }],
    });
    expect(getGeneratedClassDeps(Dependency)).toMatchObject([{ name: "generated-runtime-transaction-dependency" }]);
    expect(getGeneratedProviderAttachment(channel, Target)).toBe(1);

    class DuplicateTarget {}
    class DuplicateController {}
    class DuplicateDependency {}
    class DuplicateRequest {}
    class DuplicateList {}
    class DuplicateSchema {}
    await expect(registerOsnvGeneratedTargetDescriptor({
      ...descriptor("attachment-duplicate-preflight", DuplicateDependency, DuplicateController, DuplicateRequest, DuplicateList, DuplicateSchema, "AttachmentDuplicateSchema"),
      providerAttachments: [
        { channel, target: DuplicateTarget, value: 1 },
        { channel, target: DuplicateTarget, value: 1 },
      ],
    })).rejects.toThrow("duplicated");
    expect(getGeneratedClassDeps(DuplicateDependency)).toBeUndefined();
    expect(getGeneratedProviderAttachment(channel, DuplicateTarget)).toBeUndefined();
  });

  test("failed later target publication restores only its state and retains another committed attachment", async () => {
    class ChannelTargetA {}
    class ChannelTargetB {}
    class ControllerA {}
    class ControllerB {}
    class DependencyA {}
    class DependencyB {}
    class RequestA {}
    class RequestB {}
    class ListA {}
    class ListB {}
    class SchemaA {}
    class SchemaB {}
    const channel = createGeneratedProviderAttachmentChannel<string>({
      description: "generated-runtime.cross-target.test",
      normalize: (_target, value) => {
        if (typeof value !== "string") throw new TypeError("expected attachment text");
        return value;
      },
    });
    await registerOsnvGeneratedTargetDescriptor({
      ...descriptor("attachment-target-a", DependencyA, ControllerA, RequestA, ListA, SchemaA, "AttachmentTargetASchema"),
      providerAttachments: [{ channel, target: ChannelTargetA, value: "a" }],
    });
    registerGeneratedOpenApiSchemaModel(SchemaB, "AlreadyBoundTargetB");
    await expect(registerOsnvGeneratedTargetDescriptor({
      ...descriptor("attachment-target-b", DependencyB, ControllerB, RequestB, ListB, SchemaB, "AttachmentTargetBSchema"),
      providerAttachments: [{ channel, target: ChannelTargetB, value: "b" }],
    })).rejects.toThrow("already bound");
    expect(getGeneratedProviderAttachment(channel, ChannelTargetA)).toBe("a");
    expect(getGeneratedProviderAttachment(channel, ChannelTargetB)).toBeUndefined();
    expect(getGeneratedClassDeps(DependencyB)).toBeUndefined();
  });
});
