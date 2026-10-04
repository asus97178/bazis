import { ormHostedPlanValidator } from "../../../orm/OrmHostedPlan.validator";
import { describe, expect, test } from "bun:test";
import { createContainer, HOSTED_SERVICE, Module, singletonValue, type HostedService } from "@/core/di";
import { Configuration, defineConfig, LifecycleCoordinator, secret, type AppConfig } from "@/core/kernel";
import { Infra, InfraLifecycle, llmConnect, type InfraConnector, type LlmProviderAdapter } from "@/core/infra";
import { Column, DbContext, Entity, Key, DATABASE_PROVIDER, ormOsnovaConnect } from "@/core/orm";
import { agentSessionCheckpointProtection } from "@/core/agent/session/protector";
import type { AgentSessionCheckpointProtectionConfigV1 } from "../contracts";

const table = `osnova_test003_hosting_${crypto.randomUUID().replaceAll("-", "")}`;
const llmConfig = defineConfig("test003-hosting-llm", {
  default: { provider: "test003", model: "test003", baseUrl: "https://probe.invalid", apiKey: secret("unused") },
});
const rawProtectorConfig = defineConfig("test003-hosting-protector", {
  default: { activeKeyId: "active", activeKey: secret("test003-only") },
});
const protectorConfig: AppConfig<AgentSessionCheckpointProtectionConfigV1> = {
  ensureValid(environment) { rawProtectorConfig.ensureValid(environment); },
  has(key) { return key === "activeKeyId" || key === "readableKeyIds" || key === "keys"; },
  get(key) {
    const activeKeyId = rawProtectorConfig.get("activeKeyId");
    const values: AgentSessionCheckpointProtectionConfigV1 = {
      activeKeyId,
      readableKeyIds: [activeKeyId],
      keys: { [activeKeyId]: rawProtectorConfig.get("activeKey") },
    };
    return values[key];
  },
};

@Entity({ table }) class ProbeEntity { @Key() @Column({ type: "integer" }) id = 0; }
class ProbeContext extends DbContext {}

function resolver(services: readonly HostedService[]) {
  return { resolveAll: <T>(token: unknown): readonly T[] => token === HOSTED_SERVICE ? services as unknown as readonly T[] : [] };
}
function exactSchema(events: string[]): HostedService {
  return Object.freeze({
    planValidator: ormHostedPlanValidator,
    phase: -105,
    __osnovaSchemaAdmission: Object.freeze({ unit: ["public.test003_hosting"], tables: ["public.test003_hosting"], foreignKeys: [] }),
    start() { events.push("orm:start"); }, stop() { events.push("orm:stop"); },
  }) as HostedService;
}
function validDb(events: string[]): HostedService {
  return Object.freeze({ phase: -110, __osnovaOrmProviderReady: true, start() { events.push("db:start"); }, stop() { events.push("db:stop"); } }) as HostedService;
}
function phaseZero(events: string[], failure = false): HostedService {
  return Object.freeze({ phase: 0, start() { events.push("consumer:start"); if (failure) throw new Error("consumer failure"); }, stop() { events.push("consumer:stop"); } }) as HostedService;
}
function llm(events: string[]) {
  const adapter: LlmProviderAdapter = {
    create: () => ({ complete: () => { throw new Error("LLM must not run in lifecycle tests"); } }) as never,
    connect: () => { events.push("llm:connect"); },
    dispose: () => { events.push("llm:dispose"); },
  };
  return llmConnect(llmConfig, adapter);
}
function protector() { return agentSessionCheckpointProtection(protectorConfig); }
function infra<T>(name: string, connector: InfraConnector<T>): HostedService { return new InfraLifecycle(name, connector, connector.create()); }
async function rejectedBeforeStart(negative: HostedService, events: string[]): Promise<void> {
  await expect(new LifecycleCoordinator(resolver([validDb(events), exactSchema(events), negative, phaseZero(events)])).start())
    .rejects.toMatchObject({ code: "ORM_SCHEMA_HOSTED_PHASE_CONFLICT" });
  expect(events).toEqual([]);
}

type FingerprintedField = "token" | "config" | "phase" | "create" | "connect" | "dispose" | "healthCheck" | "providers" | "exports";
const fields: readonly FingerprintedField[] = ["token", "config", "phase", "create", "connect", "dispose", "healthCheck", "providers", "exports"];
function drift(connector: Record<string, unknown>, field: FingerprintedField): void {
  const replacement: Record<FingerprintedField, unknown> = {
    token: {}, config: {}, phase: -100,
    create: () => ({}), connect: () => undefined, dispose: () => undefined, healthCheck: () => true,
    providers: [], exports: [],
  };
  connector[field] = replacement[field];
}

describe("TEST-003 strict-schema private identity", () => {
  test("starts canonical LLM and protector after DB/exact ORM, then reverses disposal", async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator(resolver([
      validDb(events), exactSchema(events), infra("llm", llm(events)), infra("protector", protector()), phaseZero(events),
    ]));
    await coordinator.start();
    expect(events).toEqual(["db:start", "orm:start", "llm:connect", "consumer:start"]);
    await coordinator.stopServices();
    expect(events).toEqual(["db:start", "orm:start", "llm:connect", "consumer:start", "consumer:stop", "llm:dispose", "orm:stop", "db:stop"]);
  });

  test("rolls back canonical prerequisites exactly once after a later phase-0 failure", async () => {
    const events: string[] = [];
    const coordinator = new LifecycleCoordinator(resolver([
      validDb(events), exactSchema(events), infra("llm", llm(events)), infra("protector", protector()), phaseZero(events, true),
    ]));
    await expect(coordinator.start()).rejects.toThrow("consumer failure");
    expect(events).toEqual(["db:start", "orm:start", "llm:connect", "consumer:start", "llm:dispose", "orm:stop", "db:stop"]);
    expect(events.filter((item) => item === "llm:dispose")).toHaveLength(1);
    expect(events).not.toContain("consumer:stop");
  });

  test("rolls back a failed canonical LLM connection exactly once without starting its consumer", async () => {
    const events: string[] = [];
    const failingAdapter: LlmProviderAdapter = {
      create: () => ({ complete: () => { throw new Error("LLM must not run"); } }) as never,
      connect: () => { events.push("llm:connect"); throw new Error("controlled LLM connection failure"); },
      dispose: () => { events.push("llm:dispose"); },
    };
    const coordinator = new LifecycleCoordinator(resolver([
      validDb(events), exactSchema(events), infra("llm", llmConnect(llmConfig, failingAdapter)), phaseZero(events),
    ]));
    await expect(coordinator.start()).rejects.toThrow("controlled LLM connection failure");
    expect(events).toEqual(["db:start", "orm:start", "llm:connect", "llm:dispose", "orm:stop", "db:stop"]);
    expect(events.filter((item) => item === "llm:dispose")).toHaveLength(1);
    expect(events).not.toContain("consumer:start");
  });

  for (const field of fields) {
    test(`rejects ${field} fingerprint drift before lifecycle binding`, async () => {
      const events: string[] = [];
      const connector = llm(events) as unknown as Record<string, unknown> & InfraConnector<unknown>;
      drift(connector, field);
      await rejectedBeforeStart(infra(`before-${field}`, connector), events);
    });
    test(`rejects ${field} fingerprint drift after lifecycle binding`, async () => {
      const events: string[] = [];
      const connector = llm(events) as unknown as Record<string, unknown> & InfraConnector<unknown>;
      const bound = infra(`after-${field}`, connector);
      drift(connector, field);
      await rejectedBeforeStart(bound, events);
    });
  }

  test("rejects generic, copies, descriptor/symbol and inheritance spoofs before effects", async () => {
    const genericEvents: string[] = [];
    const generic = infra("generic", { token: {} as never, phase: -100, create: () => ({}), connect: () => { genericEvents.push("generic:connect"); }, dispose: () => undefined });
    await rejectedBeforeStart(generic, genericEvents);

    const spreadEvents: string[] = [];
    const source = llm(spreadEvents);
    await rejectedBeforeStart(infra("spread", { ...source }), spreadEvents);

    const descriptorEvents: string[] = [];
    const descriptorSource = llm(descriptorEvents);
    const descriptorCopy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(descriptorSource)) as InfraConnector<unknown>;
    Object.defineProperty(descriptorCopy, Symbol("osnova:strict-schema"), { value: true, enumerable: false });
    await rejectedBeforeStart(infra("descriptor", descriptorCopy), descriptorEvents);

    const inheritedEvents: string[] = [];
    const inherited = Object.create(llm(inheritedEvents)) as InfraConnector<unknown>;
    await rejectedBeforeStart(infra("inherited", inherited), inheritedEvents);
  });

  test("rejects connector-as-hosted and wrong lifecycle phase before effects", async () => {
    const castEvents: string[] = [];
    const connectorAsHosted = llm(castEvents) as unknown as HostedService & { phase: number; start(): void; stop(): void };
    connectorAsHosted.phase = -100;
    connectorAsHosted.start = () => { castEvents.push("cast:start"); };
    connectorAsHosted.stop = () => undefined;
    await rejectedBeforeStart(connectorAsHosted, castEvents);

    const phaseEvents: string[] = [];
    const connector = llm(phaseEvents);
    const wrongPhase = infra("wrong-phase", connector) as HostedService & { phase: number };
    wrongPhase.phase = -99;
    await rejectedBeforeStart(wrongPhase, phaseEvents);
  });
});

function disposableDbConfig(url: string) {
  const target = new URL(url);
  if (target.protocol !== "postgres:" || target.hostname !== "127.0.0.1" || target.pathname !== "/osnova_session_test" || decodeURIComponent(target.username) !== "postgres" || target.port.length === 0) {
    throw new Error("OSNOVA_PG_URL must be the approved disposable PG17 target.");
  }
  return defineConfig("test003-hosting-db", { default: {
    host: target.hostname, port: Number(target.port), database: target.pathname.slice(1), username: decodeURIComponent(target.username), password: secret(decodeURIComponent(target.password)),
  } });
}

const suppliedPgUrl = Bun.env.OSNOVA_PG_URL;
if (!suppliedPgUrl) {
  test.skip("physical strict-schema composition requires explicit OSNOVA_PG_URL disposable target", () => {});
} else {
  test("physical: actual container admits canonical Infra + strict ORM and disposes in reverse", async () => {
    const events: string[] = [];
    const dbConfig = disposableDbConfig(suppliedPgUrl);
    const adapter: LlmProviderAdapter = { create: () => ({ complete: () => { throw new Error("must not invoke provider"); } }) as never, connect: () => { events.push("llm:connect"); }, dispose: () => { events.push("llm:dispose"); } };
    let activeEvents = events;
    class PhysicalConsumer implements HostedService { readonly phase = 0; start() { activeEvents.push("consumer:start"); } stop() { activeEvents.push("consumer:stop"); } }
    @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] }) class ConfigModule {}
    @Infra({ db: ormOsnovaConnect(dbConfig), llm: llmConnect(llmConfig, adapter), protector: agentSessionCheckpointProtection(protectorConfig) }) class AppInfra {}
    @Module({ imports: [ConfigModule, AppInfra], ormOsnova: { context: ProbeContext, entities: [ProbeEntity], ensureCreated: true }, background: [PhysicalConsumer] }) class Root {}
    const container = createContainer(Root);
    const coordinator = new LifecycleCoordinator(container);
    let started = false;
    let providerForCleanup: { execute(sql: string, values: readonly unknown[]): Promise<unknown> } | undefined;
    try {
      await coordinator.start(); started = true;
      expect(events.indexOf("llm:connect")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("consumer:start")).toBeGreaterThan(events.indexOf("llm:connect"));
      expect(container.resolveAll(HOSTED_SERVICE).filter((service) => service.phase === -100)).toHaveLength(2);
      const resolvedProvider = container.resolve(DATABASE_PROVIDER) as { execute(sql: string, values: readonly unknown[]): Promise<unknown>; introspect(): Promise<{ tables: ReadonlyMap<string, unknown> }> };
      providerForCleanup = resolvedProvider;
      expect((await resolvedProvider.introspect()).tables.has(table)).toBe(true);
    } finally {
      try { if (providerForCleanup) await providerForCleanup.execute(`DROP TABLE IF EXISTS "${table}"`, []); }
      finally {
        try { if (started) await coordinator.stopServices(); }
        finally { await container.dispose(); }
      }
    }
    expect(events.indexOf("consumer:stop")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("consumer:stop")).toBeLessThan(events.indexOf("llm:dispose"));
  });
}
