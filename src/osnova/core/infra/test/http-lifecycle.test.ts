import { describe, expect, test } from "bun:test";
import { defineConfig, secret } from "../../kernel";
import { llmConnect, openAiCompatibleAdapter, openSearchConnect, type OpenAiCompatibleFetch } from "../index";

function pendingBody() {
  let calls = 0;
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const fetcher: OpenAiCompatibleFetch = async (_input, init) => {
    calls++;
    signal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        signal?.addEventListener("abort", () => {
          cancelled = true;
          try { controller.error(signal!.reason); } catch { /* reader already cancelled */ }
        }, { once: true });
      },
      cancel() { cancelled = true; },
    }));
  };
  return { fetcher, calls: () => calls, cancelled: () => cancelled, signal: () => signal };
}

describe("HTTP infra client ownership", () => {
  test("OpenSearch disposal cancels a pending body and rejects new requests", async () => {
    const original = globalThis.fetch;
    const pending = pendingBody();
    globalThis.fetch = pending.fetcher as typeof fetch;
    const connector = openSearchConnect(defineConfig("lifecycle.search", { default: {
      url: "https://search.example.invalid", username: "test", password: secret("synthetic"),
    } }));
    const client = connector.create();
    try {
      const ping = client.ping();
      await Bun.sleep(0);
      await connector.dispose(client);
      expect(await ping).toBe(false);
      expect(pending.cancelled()).toBe(true);
      expect(await client.ping()).toBe(false);
      await expect(client.info()).rejects.toThrow("disposed");
      expect(pending.calls()).toBe(1);
    } finally { await connector.dispose(client); globalThis.fetch = original; }
  });
  function llm(pending: ReturnType<typeof pendingBody>) {
    return llmConnect(defineConfig("lifecycle.llm", { default: {
      provider: "test", model: "test", baseUrl: "https://llm.example.invalid", apiKey: secret("synthetic"),
    } }), openAiCompatibleAdapter({ fetch: pending.fetcher }), { timeoutMs: 0 });
  }
  test("LLM health passes cancellation through the response body", async () => {
    const pending = pendingBody(); const connector = llm(pending); const client = connector.create();
    const controller = new AbortController();
    try {
      const work = connector.healthCheck!(client, controller.signal);
      await Bun.sleep(0); controller.abort(new Error("caller cancelled"));
      expect(await work).toBe(false);
      expect(pending.signal()?.aborted).toBe(true);
      expect(pending.cancelled()).toBe(true);
    } finally { await connector.dispose(client); }
  });
  test("LLM disposal cancels a pending body even when request timeout is disabled", async () => {
    const pending = pendingBody(); const connector = llm(pending); const client = connector.create();
    try {
      const work = connector.healthCheck!(client);
      await Bun.sleep(0); await connector.dispose(client);
      expect(await work).toBe(false);
      expect(pending.cancelled()).toBe(true);
      expect(await connector.healthCheck!(client)).toBe(false);
      expect(pending.calls()).toBe(1);
    } finally { await connector.dispose(client); }
  });
});
