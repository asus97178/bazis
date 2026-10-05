import { describe, expect, test } from "bun:test";
import { DI, Module, ModuleOwnedProviderConflictError, ServiceCollection, createContainer, scoped, singleton, transient } from "@/core/di";
import { AgentRegistry, AgentSetupError, AgentToolExecutor, Tool } from "../index";
import { getAgentModuleContributionsV1 } from "../moduleContributions-v1";

let toolConstructed = 0;
let toolExecuted = 0;

@Tool({ name: "agent.contribution.tool", description: "Test Tool", sideEffect: "read" })
class ContributionTool {
  public constructor() { toolConstructed += 1; }
  public execute(): object { toolExecuted += 1; return {}; }
}

class EnforcementHook { public enforce(): { readonly decision: "allow" } { return { decision: "allow" }; } }
class SettlementHook { public settle(): { readonly status: "recorded" } { return { status: "recorded" }; } }
class ObserverHook { public observe(): void {} }
class MissingHookMethod {}
let boundaryHookConstructed = 0;
class BoundaryHook {
  public constructor() { boundaryHookConstructed += 1; }
  public enforce(): { readonly decision: "allow" } { return { decision: "allow" }; }
}

function resetToolCounters(): void { toolConstructed = 0; toolExecuted = 0; }

function toolModule(providers: readonly unknown[] | undefined, name = "ToolOwnerModule") {
  @Module({ tools: [ContributionTool], ...(providers === undefined ? {} : { providers: providers as never }) })
  class ToolOwnerModule {}
  Object.defineProperty(ToolOwnerModule, "name", { value: name });
  return ToolOwnerModule;
}

function hookRegistration(
  kind: "enforcement" | "settlement" | "observer" = "enforcement",
  overrides: Record<string, unknown> = {},
) {
  if (kind === "enforcement") return { kind, id: "operator.control", version: 1, handler: EnforcementHook, ...overrides } as const;
  if (kind === "settlement") return { kind, id: "operator.control", version: 1, handler: SettlementHook, ...overrides } as const;
  return { kind, id: "operator.control", version: 1, handler: ObserverHook, ...overrides } as const;
}

describe("Agent module contributions v1", () => {
  test("registers a Tool once, exposes its catalog without activation, and preserves scoped identity", async () => {
    resetToolCounters();
    const owner = toolModule(undefined);
    const container = createContainer(owner);
    const catalog = AgentRegistry.fromContainer(container);
    expect(catalog.listTools().map(tool => tool.metadata.name)).toEqual(["agent.contribution.tool"]);
    expect(AgentRegistry.fromContainer(container)).toBe(catalog);
    expect(Object.isFrozen(catalog.listTools())).toBe(true);
    expect(toolConstructed).toBe(0);
    const first = container.createScope(), second = container.createScope();
    try {
      const contribution = getAgentModuleContributionsV1(container).tools[0]!;
      const instance = contribution.activation.activate(first);
      expect(instance).toBe(first.resolve(ContributionTool));
      expect(instance).not.toBe(second.resolve(ContributionTool));
      expect(toolConstructed).toBe(2);
      expect(toolExecuted).toBe(0);
    } finally { await first.dispose(); await second.dispose(); await container.dispose(); }
  });

  test("isolates catalogs between containers and ignores an undecorated DI-only capability", async () => {
    const left = createContainer(toolModule(undefined));
    const right = createContainer({ providers: [scoped(ContributionTool)], exports: [] });
    try {
      expect(AgentRegistry.fromContainer(left).listTools()).toHaveLength(1);
      expect(AgentRegistry.fromContainer(right).listTools()).toHaveLength(0);
      expect(() => AgentRegistry.fromContainer(new ServiceCollection().buildServiceProvider())).toThrow(AgentSetupError);
    } finally { await left.dispose(); await right.dispose(); }
  });

  test("rejects duplicate Tool names, repeated classes, and multiple owners before activation", () => {
    @Tool({ name: "agent.contribution.tool", description: "Conflicting name" }) class ConflictingTool {}
    for (const build of [
      () => createContainer({ tools: [ContributionTool, ContributionTool] }),
      () => createContainer({ tools: [ContributionTool, ConflictingTool] }),
      () => createContainer({ imports: [toolModule(undefined, "FirstOwner"), toolModule(undefined, "SecondOwner")] }),
    ]) {
      resetToolCounters();
      expect(build).toThrow(AgentSetupError);
      expect(toolConstructed).toBe(0);
    }
  });

  test("rejects a foreign ordinary registration in either import order", () => {
    const owner = toolModule(undefined);
    @Module({ providers: [scoped(ContributionTool)] }) class ForeignModule {}
    for (const imports of [[owner, ForeignModule], [ForeignModule, owner]]) {
      resetToolCounters();
      expect(() => createContainer({ imports })).toThrow(ModuleOwnedProviderConflictError);
      expect(toolConstructed).toBe(0);
    }
  });

  test("attaches an exact same-owner ordinary unkeyed scoped Tool provider", () => {
    const owner = toolModule([scoped(ContributionTool)]);
    const container = createContainer(owner);
    const contributions = getAgentModuleContributionsV1(container);
    expect(contributions.tools).toHaveLength(1);
    expect(contributions.tools[0]?.payload.target).toBe(ContributionTool);
    expect(contributions.tools[0]?.payload.owner).toBe(owner);
  });

  test("rejects invalid Tool ownership/lifetime before Tool constructor or business invocation", () => {
    const cases: ReadonlyArray<readonly [string, () => unknown]> = [
      ["duplicate", () => createContainer(toolModule([scoped(ContributionTool), scoped(ContributionTool)]))],
      ["keyed-only", () => createContainer(toolModule([DI.keyedScoped("tool", DI.classProvider(ContributionTool, ContributionTool))]))],
      ["factory", () => createContainer(toolModule([DI.scoped(DI.factoryProvider(ContributionTool, [], () => new ContributionTool()))]))],
      ["singleton", () => createContainer(toolModule([singleton(ContributionTool)]))],
      ["transient", () => createContainer(toolModule([transient(ContributionTool)]))],
    ];
    for (const [name, build] of cases) {
      resetToolCounters();
      expect(build).toThrow(AgentSetupError);
      expect(toolConstructed, name).toBe(0);
      expect(toolExecuted, name).toBe(0);
    }
  });

  test("rejects missing or invalid @Tool metadata before activation", () => {
    class PlainTool { public execute(): object { return {}; } }
    @Module({ tools: [PlainTool], providers: [scoped(PlainTool)] }) class MissingMetadataModule {}
    expect(() => createContainer(MissingMetadataModule)).toThrow(AgentSetupError);
    expect(() => {
      @Tool({ name: " ", description: "Invalid Tool" })
      class InvalidMetadataTool {}
      return InvalidMetadataTool;
    }).toThrow(AgentSetupError);
  });

  test("creates private owner-scoped hook handlers without a duplicate public provider", async () => {
    @Module({ agentToolHooks: [hookRegistration()] }) class HookOwnerModule {}
    const container = createContainer(HookOwnerModule);
    const hooks = getAgentModuleContributionsV1(container).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.payload.owner).toBe(HookOwnerModule);
    expect(container.has(EnforcementHook)).toBe(false);
    const scope = container.createScope();
    expect(await hooks[0]!.activation.activateAsync(scope)).toBeInstanceOf(EnforcementHook);
    await scope.dispose();
  });

  test("rejects duplicate public registration of a private hook handler", () => {
    @Module({ agentToolHooks: [hookRegistration()], providers: [scoped(EnforcementHook)] }) class DuplicateProviderModule {}
    expect(() => createContainer(DuplicateProviderModule)).toThrow();
  });

  test("rejects duplicate identity and incompatible active versions", () => {
    @Module({ agentToolHooks: [hookRegistration(), hookRegistration()] }) class DuplicateIdentityModule {}
    expect(() => createContainer(DuplicateIdentityModule)).toThrow(AgentSetupError);
    @Module({ agentToolHooks: [hookRegistration("enforcement"), hookRegistration("enforcement", { version: 2 })] }) class IncompatibleVersionModule {}
    expect(() => createContainer(IncompatibleVersionModule)).toThrow(AgentSetupError);
  });

  test("rejects invalid hook descriptor bounds and handler method", () => {
    const invalid: readonly Record<string, unknown>[] = [
      { id: "" }, { id: "кириллица" }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 },
      { order: Number.MAX_SAFE_INTEGER + 1 }, { timeoutMs: 0 }, { timeoutMs: -1 },
      { handler: MissingHookMethod },
    ];
    for (const overrides of invalid) {
      @Module({ agentToolHooks: [hookRegistration("enforcement", overrides)] }) class InvalidHookModule {}
      expect(() => createContainer(InvalidHookModule)).toThrow(AgentSetupError);
    }
  });

  test("accepts exact printable-ASCII hook id bounds and rejects invalid ids before handler activation", () => {
    for (const id of [" ", " ".repeat(128)]) {
      @Module({ agentToolHooks: [hookRegistration("enforcement", { id, handler: BoundaryHook })] }) class ValidHookIdModule {}
      expect(() => createContainer(ValidHookIdModule)).not.toThrow();
    }

    for (const id of ["", "a".repeat(129), "кириллица", "line\nbreak", "\x7f"]) {
      boundaryHookConstructed = 0;
      @Module({ agentToolHooks: [hookRegistration("enforcement", { id, handler: BoundaryHook })] }) class InvalidHookIdModule {}
      expect(() => createContainer(InvalidHookIdModule)).toThrow(AgentSetupError);
      expect(boundaryHookConstructed, JSON.stringify(id)).toBe(0);
    }
  });

  test("rejects an unknown hook kind", () => {
    @Module({ agentToolHooks: [hookRegistration("enforcement", { kind: "unknown", handler: ObserverHook })] }) class UnknownKindModule {}
    expect(() => createContainer(UnknownKindModule)).toThrow(AgentSetupError);
  });

  test("pins platform hooks to exact owner identity and exact kind/id/version", () => {
    @Module({ agentToolHooks: [hookRegistration()] }) class PlatformOwner {}
    @Module({}) class LookalikeOwner {}
    @Module({ imports: [PlatformOwner, LookalikeOwner] }) class AppModule {}
    const container = createContainer(AppModule);
    const registry = AgentRegistry.fromModules([AppModule]);
    const base = { auditSink: () => undefined };
    expect(() => new AgentToolExecutor(container, registry, { ...base, requiredPlatformHooks: [{ owner: PlatformOwner, kind: "enforcement", id: "operator.control", version: 1 }] })).not.toThrow();
    for (const ref of [
      { owner: PlatformOwner, kind: "settlement", id: "operator.control", version: 1 },
      { owner: PlatformOwner, kind: "enforcement", id: "operator.control", version: 2 },
      { owner: LookalikeOwner, kind: "settlement", id: "operator.control", version: 1 },
      { owner: PlatformOwner, kind: "enforcement", id: "missing", version: 1 },
    ] as const) {
      expect(() => new AgentToolExecutor(container, registry, { ...base, requiredPlatformHooks: [ref] })).toThrow(AgentSetupError);
    }
    const duplicate = { owner: PlatformOwner, kind: "enforcement" as const, id: "operator.control", version: 1 };
    expect(() => new AgentToolExecutor(container, registry, { ...base, requiredPlatformHooks: [duplicate, duplicate] })).toThrow(AgentSetupError);
  });

  test("validates required platform hook id bounds before duplicate or owner matching", () => {
    for (const id of [" ", " ".repeat(128)]) {
      @Module({ agentToolHooks: [hookRegistration("enforcement", { id })] }) class PlatformOwner {}
      const container = createContainer(PlatformOwner);
      const registry = AgentRegistry.fromModules([PlatformOwner]);
      expect(() => new AgentToolExecutor(container, registry, {
        auditSink: () => undefined,
        requiredPlatformHooks: [{ owner: PlatformOwner, kind: "enforcement", id, version: 1 }],
      })).not.toThrow();
    }

    @Module({ agentToolHooks: [hookRegistration()] }) class PlatformOwner {}
    const container = createContainer(PlatformOwner);
    const registry = AgentRegistry.fromModules([PlatformOwner]);
    for (const id of ["", "a".repeat(129), "кириллица", "line\nbreak", "\x7f"]) {
      expect(() => new AgentToolExecutor(container, registry, {
        auditSink: () => undefined,
        requiredPlatformHooks: [{ owner: PlatformOwner, kind: "enforcement", id, version: 1 }],
      })).toThrow("1 to 128 printable ASCII");
    }

    const invalidReferences: ReadonlyArray<readonly [unknown, string]> = [
      [{ owner: null, kind: "enforcement", id: "operator.control", version: 1 }, "owner must be an OsnvModuleRef"],
      [{ owner: PlatformOwner, kind: "unknown", id: "operator.control", version: 1 }, "entry kind is invalid"],
      [{ owner: PlatformOwner, kind: "enforcement", id: "operator.control", version: 0 }, "version must be a positive safe integer"],
    ];
    for (const [reference, diagnostic] of invalidReferences) {
      expect(() => new AgentToolExecutor(container, registry, {
        auditSink: () => undefined,
        requiredPlatformHooks: [reference] as never,
      })).toThrow(diagnostic);
    }
  });

  test("rejects platform refs on plain ServiceProvider", () => {
    const services = new ServiceCollection().buildServiceProvider();
    expect(() => new AgentToolExecutor(services, {} as AgentRegistry, {
      requiredPlatformHooks: [{ owner: class PlainOwner {}, kind: "enforcement", id: "operator.control", version: 1 }],
    })).toThrow(AgentSetupError);
    expect(() => new AgentToolExecutor(services, {} as AgentRegistry)).not.toThrow();
  });
});
