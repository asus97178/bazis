import { expect, test } from "bun:test";
import type { HostedService } from "@/core/di";
import { defineConfig, secret } from "@/core/kernel";
import { isStrictSchemaPrerequisiteLifecycle } from "@/core/orm/strictSchemaHostedIdentity";
import { bindConnectorLifecycle } from "../connectorIdentity";
import { llmConnect, llmProfile, llmRouter, type LlmProviderAdapter } from "../index";

// 0.111.1: llmRouter was not marked as the framework LLM connector, so an
// application with llmRouter and ormBazis ensureCreated did not start:
// "infra:llm (phase -100) is not a framework connector".
const config = defineConfig("llm", { default: { provider: "test", model: "m", baseUrl: "https://llm.internal", apiKey: secret("k") } });
const adapter: LlmProviderAdapter = { create: () => ({ complete: () => { throw new Error("not called"); } }) };

const startsBeforeApplication = (connector: Parameters<typeof bindConnectorLifecycle>[0]) => {
  const lifecycle = { phase: -100, start: async () => {}, stop: async () => {} } as HostedService;
  bindConnectorLifecycle(connector, lifecycle);
  return isStrictSchemaPrerequisiteLifecycle(lifecycle);
};

test("llmConnect and llmRouter are both framework LLM connectors", () => {
  expect(startsBeforeApplication(llmConnect(config, adapter))).toBe(true);
  expect(startsBeforeApplication(llmRouter({ fast: llmProfile(config, adapter) }, { defaultProfile: "fast" }))).toBe(true);
});
