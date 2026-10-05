import { expect, test } from "bun:test";
import { Configuration, Osnv, defineConfig, memorySource, secret, type AppConfig, type EnvironmentName } from "../../../kernel";
import { infraModule } from "../../../infra";
import { AGENT_SESSION_CHECKPOINT_PROTECTOR, agentSessionCheckpointProtection } from "../protector";
import type { AgentSessionCheckpointProtectionConfigV1 } from "../contracts";

test("derived checkpoint config and protector use the current kernel snapshot", async () => {
  const raw = defineConfig("isolated_protector", {
    default: { activeKeyId: "test-key", activeKey: secret("test-secret") },
    production: { activeKeyId: "prod-key", activeKey: secret("prod-secret") },
  });
  function resolve(environment: EnvironmentName = "test", source = Configuration.empty()): AppConfig<AgentSessionCheckpointProtectionConfigV1> {
    const view = raw.resolve(environment, source);
    const id = view.get("activeKeyId");
    const values = Object.freeze({ activeKeyId: id, readableKeyIds: Object.freeze([id]), keys: Object.freeze({ [id]: view.get("activeKey") }) });
    return Object.freeze({
      ensureValid: view.ensureValid,
      has: (key: keyof typeof values) => key in values,
      get: <K extends keyof typeof values>(key: K): typeof values[K] => values[key],
    });
  }
  const declaration = Object.freeze({
    resolve,
    ensureValid(environment?: EnvironmentName) { resolve(environment); },
    has: (key: keyof AgentSessionCheckpointProtectionConfigV1) => resolve().has(key),
    get: <K extends keyof AgentSessionCheckpointProtectionConfigV1>(key: K): AgentSessionCheckpointProtectionConfigV1[K] => resolve().get(key),
  });
  const root = infraModule({ protector: agentSessionCheckpointProtection(declaration) });
  const build = (environment: EnvironmentName) => Osnv.createBuilder(root).useEnvironment(environment)
    .useStartupReport(false).useSignals([]).addConfigSource(memorySource({})).build();
  const [production, testing] = await Promise.all([build("production"), build("test")]);
  try {
    const request = { sessionId: "11111111-1111-4111-8111-111111111111", checkpointRevision: 1, bindingHash: "b".repeat(64), canonicalCheckpointJson: '{"messages":[]}' };
    const prod = production.container.resolve(AGENT_SESSION_CHECKPOINT_PROTECTOR);
    const tst = testing.container.resolve(AGENT_SESSION_CHECKPOINT_PROTECTOR);
    const [a, b] = await Promise.all([prod.seal(request), tst.seal(request)]);
    expect(a.keyId).toBe("prod-key");
    expect(b.keyId).toBe("test-key");
    await expect(tst.open({ expectedSessionId: request.sessionId, expectedCheckpointRevision: 1, expectedBindingHash: request.bindingHash, sealed: a })).rejects.toThrow();
  } finally { await Promise.all([production.stop(), testing.stop()]); }
});
