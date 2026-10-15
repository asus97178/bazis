import { expect, test } from "bun:test";
import { Bazis, defineConfig, secret } from "@/core/kernel";
import { Infra, InfraError, llmConnect, openAiCompatibleAdapter, type LlmConnectorOptions } from "@/core/infra";

// 0.100.5: the LLM start check does not run in the test environment, where a
// test replaces the model. On 0.100.4 every test that started an application
// with llmConnect called the real provider and failed without network or key.

async function start(environment: "test" | "development", options?: LlmConnectorOptions) {
  const requests: string[] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { requests.push(new URL(request.url).pathname); return new Response("{}", { status: 401 }); } });
  const config = defineConfig("llm", { default: { provider: "openai", model: "m", baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: secret("dev") } });
  @Infra({ llm: llmConnect(config, openAiCompatibleAdapter(), options) })
  class AppInfra {}
  const kernel = await Bazis.createBuilder(AppInfra).useEnvironment(environment).useStartupReport(false).build();
  try {
    const error = await kernel.start().then(() => undefined, (caught: unknown) => caught);
    if (error === undefined) await kernel.stop();
    return { error, requests };
  } finally {
    provider.stop(true);
  }
}

test("in the test environment the provider is not called at start", async () => {
  const { error, requests } = await start("test");
  expect(error).toBeUndefined();
  expect(requests).toEqual([]);
});

test("in development the provider is checked, and checkOnStart: true checks in tests too", async () => {
  for (const run of [await start("development"), await start("test", { checkOnStart: true })]) {
    expect(run.error).toBeInstanceOf(InfraError);
    expect((run.error as Error).message).toContain("is not available");
    expect(run.requests).toEqual(["/v1/models"]);
  }
});
