import { expect, test } from "bun:test";
import { agentMessage, agentModelRequest, agentModelResponse, type AgentModelProviderContext } from "../../agent";
import { defineConfig, secret } from "../../kernel";
import { llmProfile, llmRouter } from "../connectors/llmRouter";

const config = defineConfig("stream-test", { default: {
  provider: "fixture", model: "fixture", baseUrl: "https://unused.invalid", apiKey: secret("fixture"),
} });
for (const partial of [true, false]) test(`router ${partial ? "refuses" : "allows"} fallback ${partial ? "after" : "before"} visible text`, async () => {
  let calls = 0, first!: AgentModelProviderContext;
  const text: string[] = [];
  const connector = llmRouter({
    primary: llmProfile(config, { create: () => ({ complete(_request, context) {
      first = context;
      if (partial) context.onTextDelta?.("First");
      throw new Error("Controlled failure");
    } }) }, { fallback: "secondary" }),
    secondary: llmProfile(config, { create: () => ({ complete(request, context) {
      calls++; context.onTextDelta?.("Second");
      return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", "Second") });
    } }) }),
  }, { defaultProfile: "primary" });
  const provider = connector.create();
  try {
    const result = await Promise.resolve(provider.complete(agentModelRequest({ invocationId: "stream", messages: [agentMessage("user", "Hi")] }), {
      invocationId: "stream", agentName: "main", metadata: {}, signal: new AbortController().signal, onTextDelta: value => text.push(value),
    })).catch(error => error);
    expect(result instanceof Error).toBe(partial); expect(calls).toBe(partial ? 0 : 1);
    first.onTextDelta?.("Late first response");
    expect(text).toEqual(partial ? ["First"] : ["Second"]);
  } finally { await connector.dispose(provider); }
});
