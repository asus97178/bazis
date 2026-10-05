import { registerGeneratedBindings } from "../../http/Binding/autoBindings";
import { describe, expect, test } from "bun:test";
import {
  Agent,
  AgentRegistry,
  type AgentToolAuditHookProjectionV1,
  type AgentToolAuditPhase,
  type AgentToolBeforeEffectEventV1,
  type AgentToolEnforcementDecisionV1,
  type AgentToolEnforcementHookV1,
  type AgentToolHookContextV1,
  type AgentToolHookKindV1,
  type AgentToolHookRefV1,
  type AgentToolHookRegistrationBaseV1,
  type AgentToolHookRegistrationV1,
  type AgentToolCallProjectionV1,
  type AgentToolDescriptorProjectionV1,
  type AgentToolObserverEventV1,
  type AgentToolObserverHookV1,
  type AgentToolRequiredHookRefV1,
  type AgentToolSettlementEventV1,
  type AgentToolSettlementHookV1,
  type AgentToolSettlementResultV1,
  type AgentToolTerminalProjectionV1,
  Cacheable,
  Controller,
  Get,
  Module,
  Ok,
  Task,
  Tool,
  agentOutput,
  cachedScoped,
  createContainer,
  createToken,
  http,
  memory,
  orm,
  runApp,
  scoped,
  type OsnvModuleRef,
} from "osnv";
import { di } from "osnv";
import type {
  AgentToolAuditHookProjectionV1 as GroupedAgentToolAuditHookProjectionV1,
  AgentToolAuditPhase as GroupedAgentToolAuditPhase,
  AgentToolBeforeEffectEventV1 as GroupedAgentToolBeforeEffectEventV1,
  AgentToolEnforcementDecisionV1 as GroupedAgentToolEnforcementDecisionV1,
  AgentToolEnforcementHookV1 as GroupedAgentToolEnforcementHookV1,
  AgentToolHookContextV1 as GroupedAgentToolHookContextV1,
  AgentToolHookKindV1 as GroupedAgentToolHookKindV1,
  AgentToolHookRefV1 as GroupedAgentToolHookRefV1,
  AgentToolHookRegistrationBaseV1 as GroupedAgentToolHookRegistrationBaseV1,
  AgentToolHookRegistrationV1 as GroupedAgentToolHookRegistrationV1,
  AgentToolCallProjectionV1 as GroupedAgentToolCallProjectionV1,
  AgentToolDescriptorProjectionV1 as GroupedAgentToolDescriptorProjectionV1,
  AgentToolObserverEventV1 as GroupedAgentToolObserverEventV1,
  AgentToolObserverHookV1 as GroupedAgentToolObserverHookV1,
  AgentToolRequiredHookRefV1 as GroupedAgentToolRequiredHookRefV1,
  AgentToolSettlementEventV1 as GroupedAgentToolSettlementEventV1,
  AgentToolSettlementHookV1 as GroupedAgentToolSettlementHookV1,
  AgentToolSettlementResultV1 as GroupedAgentToolSettlementResultV1,
  AgentToolTerminalProjectionV1 as GroupedAgentToolTerminalProjectionV1,
} from "osnv/core/agent";

interface DxCounter {
  value(id: number): string;
}

const DxCounter = createToken<DxCounter>("DxCounter");
let counterCalls = 0;

class DxCounterService implements DxCounter {
  @Cacheable({ seconds: 60, key: (...args: readonly unknown[]) => `dx:${String(args[0])}` })
  value(id: number): string {
    counterCalls += 1;
    return `value:${id}`;
  }
}

@Controller("dx")
class DxController {
  static inject = [DxCounter] as const;

  constructor(private readonly counter: DxCounter) {}

  @Get(":id(int)")
  byId(id: number) {
    return Ok({ value: this.counter.value(id) });
  }
}
registerGeneratedBindings(DxController, {
  byId: [{ source: "route", name: "id", type: "number", optional: false }],
}, new Map([]));

@Tool({
  name: "dx.lookup",
  description: "Read DX smoke data.",
  sideEffect: "read",
})
class DxLookupTool {}

class DxTaskInput {
  query = "";
}

class DxTaskOutput {
  answer = "";
}

class DxEnforcementHook implements AgentToolEnforcementHookV1 {
  enforce(
    _event: AgentToolBeforeEffectEventV1,
    _context: AgentToolHookContextV1,
  ): AgentToolEnforcementDecisionV1 {
    return { decision: "allow" };
  }
}

class DxSettlementHook implements AgentToolSettlementHookV1 {
  settle(
    _event: AgentToolSettlementEventV1,
    _context: AgentToolHookContextV1,
  ): AgentToolSettlementResultV1 {
    return { status: "recorded" };
  }
}

class DxObserverHook implements AgentToolObserverHookV1 {
  observe(_event: AgentToolObserverEventV1, _context: AgentToolHookContextV1): void {}
}

@Agent({
  name: "dx-agent",
  role: "DX smoke agent",
  tools: [DxLookupTool],
})
class DxAgent {
  @Task({
    name: "answer",
    input: DxTaskInput,
    output: DxTaskOutput,
  })
  answer(_input: DxTaskInput): DxTaskOutput {
    return agentOutput();
  }
}

@Module({
  imports: [memory()],
  providers: [cachedScoped(DxCounter, DxCounterService), scoped(DxLookupTool)],
  controllers: [DxController],
  agents: [DxAgent],
  tools: [DxLookupTool],
  agentToolHooks: [
    {
      kind: "enforcement",
      id: "dx.platform-policy",
      version: 1,
      order: 10,
      timeoutMs: 1_000,
      handler: DxEnforcementHook,
    },
    {
      kind: "settlement",
      id: "dx.platform-settlement",
      version: 1,
      order: 20,
      timeoutMs: 1_000,
      handler: DxSettlementHook,
    },
    {
      kind: "observer",
      id: "dx.observer",
      version: 1,
      order: 30,
      timeoutMs: 1_000,
      handler: DxObserverHook,
    },
  ] satisfies readonly AgentToolHookRegistrationV1[],
})
class DxFeatureModule {}

const dxRequiredPlatformHooks = [
  {
    owner: DxFeatureModule,
    kind: "enforcement",
    id: "dx.platform-policy",
    version: 1,
  },
  {
    owner: DxFeatureModule,
    kind: "settlement",
    id: "dx.platform-settlement",
    version: 1,
  },
] satisfies readonly AgentToolRequiredHookRefV1[];

const dxAuditPhases: readonly AgentToolAuditPhase[] = [
  "attempt", "enforcement", "result", "settlement", "observer",
];

const dxAuditHook: AgentToolAuditHookProjectionV1 = {
  kind: "enforcement",
  id: "dx.platform-policy",
  version: 1,
  tier: "platform",
  order: 10,
  outcome: "allowed",
};

type PublicHookContractsAreGroupedContracts = [
  AgentToolAuditHookProjectionV1 extends GroupedAgentToolAuditHookProjectionV1 ? true : false,
  AgentToolAuditPhase extends GroupedAgentToolAuditPhase ? true : false,
  AgentToolBeforeEffectEventV1 extends GroupedAgentToolBeforeEffectEventV1 ? true : false,
  AgentToolEnforcementDecisionV1 extends GroupedAgentToolEnforcementDecisionV1 ? true : false,
  AgentToolEnforcementHookV1 extends GroupedAgentToolEnforcementHookV1 ? true : false,
  AgentToolHookContextV1 extends GroupedAgentToolHookContextV1 ? true : false,
  AgentToolHookKindV1 extends GroupedAgentToolHookKindV1 ? true : false,
  AgentToolHookRefV1 extends GroupedAgentToolHookRefV1 ? true : false,
  AgentToolHookRegistrationBaseV1 extends GroupedAgentToolHookRegistrationBaseV1 ? true : false,
  AgentToolHookRegistrationV1 extends GroupedAgentToolHookRegistrationV1 ? true : false,
  AgentToolCallProjectionV1 extends GroupedAgentToolCallProjectionV1 ? true : false,
  AgentToolDescriptorProjectionV1 extends GroupedAgentToolDescriptorProjectionV1 ? true : false,
  AgentToolObserverEventV1 extends GroupedAgentToolObserverEventV1 ? true : false,
  AgentToolObserverHookV1 extends GroupedAgentToolObserverHookV1 ? true : false,
  AgentToolRequiredHookRefV1 extends GroupedAgentToolRequiredHookRefV1 ? true : false,
  AgentToolSettlementEventV1 extends GroupedAgentToolSettlementEventV1 ? true : false,
  AgentToolSettlementHookV1 extends GroupedAgentToolSettlementHookV1 ? true : false,
  AgentToolSettlementResultV1 extends GroupedAgentToolSettlementResultV1 ? true : false,
  AgentToolTerminalProjectionV1 extends GroupedAgentToolTerminalProjectionV1 ? true : false,
];

const publicHookContractsAreGroupedContracts: PublicHookContractsAreGroupedContracts = [
  true, true, true, true, true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true,
];

@Module({
  imports: [
    DxFeatureModule,
    http.httpModule({
      imports: [DxFeatureModule],
      port: 0,
      prefix: "api",
    }),
  ],
})
class DxAppModule {}

describe("public osnv DX smoke", () => {
  test("flat and grouped Agent Tool Hook v1 contracts compile through public barrels", () => {
    expect(dxRequiredPlatformHooks).toHaveLength(2);
    expect(dxAuditPhases).toEqual(["attempt", "enforcement", "result", "settlement", "observer"]);
    expect(dxAuditHook.tier).toBe("platform");
    expect(publicHookContractsAreGroupedContracts).toHaveLength(19);
  });

  test("namespaced ORM public barrel exposes strict contracts and safe diagnostics", () => {
    const descriptor: orm.SafeSchemaDescriptor = { kind: "absent" };
    expect(descriptor.kind).toBe("absent");
  });

  test("flat and namespaced public imports cover golden-path app pieces", async () => {
    counterCalls = 0;
    const container = createContainer(DxAppModule as OsnvModuleRef, { validateOnBuild: true });
    const server = container.resolveAll(di.HOSTED_SERVICE).find((service) => service instanceof http.HttpServer);

    expect(server).toBeInstanceOf(http.HttpServer);
    await server!.start();
    try {
      const base = `http://localhost:${server!.port}`;
      const first = await fetch(`${base}/api/dx/7`);
      const second = await fetch(`${base}/api/dx/7`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toEqual({ value: "value:7" });
      expect(await second.json()).toEqual({ value: "value:7" });
      expect(counterCalls).toBe(1);

      const registry = AgentRegistry.fromModules([DxFeatureModule]);
      expect(registry.requireAgent("dx-agent").tasks[0]?.metadata.name).toBe("answer");
      expect(registry.getTool("dx.lookup")?.metadata.sideEffect).toBe("read");
    } finally {
      await server!.stop();
    }
  });

  test("runApp is available from the public barrel and validates module configs", () => {
    const brokenConfig = {
      ensureValid() {
        throw new Error("dx config invalid");
      },
    };

    @Module({ config: brokenConfig })
    class BrokenAppModule {}

    expect(() => runApp(BrokenAppModule)).toThrow("dx config invalid");
  });
});

test("HTTP manual binding API is removed", () => {
  for (const name of ["Bind", "Param", "Query", "Body", "Header", "Req", "Res", "Ctx", "FromServices", "List", "FromRoute", "FromQuery", "FromBody", "FromHeader"]) {
    expect(name in http).toBe(false);
  }
});
