import { expect, test } from "bun:test";
import { readOpenAiTextStream } from "../connectors/openaiTextStream";

test("fragmented tool calls are assembled completely before execution can start", async () => {
  const packet = (delta: unknown, finish_reason: string | null = null) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  const text: string[] = [];
  const body = packet({ content: "Reading" })
    + packet({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "agents_getAll", arguments: '{"pa' } }] })
    + packet({ tool_calls: [{ index: 0, function: { arguments: 'ge":1}' } }] })
    + packet({}, "tool_calls") + "data: [DONE]\n\n";
  const result = await readOpenAiTextStream(new Response(body), new AbortController().signal, 10000, delta => text.push(delta), true);
  expect(result).toMatchObject({ choices: [{ finish_reason: "tool_calls", message: { content: "Reading",
    tool_calls: [{ id: "call-1", type: "function", function: { name: "agents_getAll", arguments: '{"page":1}' } }] } }] });
  expect(text).toEqual(["Reading"]);
});

test("partial or inconsistent streamed calls never produce a tool request", async () => {
  const signal = new AbortController().signal;
  const delta = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{}"}}]}}]}\n\n';
  await expect(readOpenAiTextStream(new Response(delta), signal, 10000, () => {}, true)).rejects.toThrow();
  const invalid = delta + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  await expect(readOpenAiTextStream(new Response(invalid), signal, 10000, () => {}, true)).rejects.toThrow();
});
import { agentMessage, agentModelRequest, agentOutputContract, agentToolContract, type AgentModelProviderContext } from "../../agent";
import { OpenAiCompatibleModelProvider } from "../connectors/openaiCompatible";

const request = () => agentModelRequest({ invocationId: "stream", messages: [agentMessage("user", "Hello")] });
const context = (onTextDelta: (text: string) => void, signal = new AbortController().signal): AgentModelProviderContext =>
  ({ invocationId: "stream", agentName: "main", metadata: {}, signal, onTextDelta });
const event = (content: string, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\r\n\r\n`;
const end = event("", "stop") + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\ndata: [DONE]\r\n\r\n';
function fixture(options: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  let stream!: ReadableStreamDefaultController<Uint8Array>, cancelled = false, body: any;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const provider = new OpenAiCompatibleModelProvider({ provider: "fixture", baseUrl: "https://unused.invalid", model: "fixture", apiKey: "test", timeoutMs: options.timeoutMs }, {
    maxResponseBytes: options.maxResponseBytes,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return response; },
  });
  return { provider, stream, body: () => body, cancelled: () => cancelled,
    write: (text: string) => stream.enqueue(new TextEncoder().encode(text)) };
}

test("streams text before completion, decodes fragmented UTF-8/CRLF and preserves usage", async () => {
  const f = fixture(), deltas: string[] = [];
  let seen!: () => void;
  const first = new Promise<void>(resolve => { seen = resolve; });
  const result = f.provider.complete(request(), context(text => { deltas.push(text); seen(); }));
  for (const byte of new TextEncoder().encode(': keepalive\r\n\r\n' + event("Привет 🐈"))) f.stream.enqueue(new Uint8Array([byte]));
  await first;
  expect(deltas).toEqual(["Привет 🐈"]);
  expect(f.body()).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  f.write(event("!") + end);
  const response = await result;
  expect(response.message?.content).toEqual([{ kind: "text", text: "Привет 🐈!" }]);
  expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  expect(f.cancelled()).toBe(true); // [DONE] releases a server that keeps the body open.
  f.provider.dispose();
});

test("SSE handles CR-only framing at EOF", async () => {
  const f = fixture();
  const result = f.provider.complete(request(), context(() => {}));
  f.write((event("Text") + end).replaceAll("\r\n", "\r")); f.stream.close();
  expect((await result).finishReason).toBe("stop");
});

test("abort stops a pending body read and preserves only the already emitted text", async () => {
  const f = fixture(), abort = new AbortController(), text: string[] = [];
  let seen!: () => void;
  const first = new Promise<void>(resolve => { seen = resolve; });
  const result = f.provider.complete(request(), context(value => { text.push(value); seen(); }, abort.signal)).catch(error => error);
  f.write(event("Part")); await first; abort.abort(new Error("controlled abort"));
  expect(await result).toBeInstanceOf(Error);
  expect(f.cancelled()).toBe(true);
  expect(text).toEqual(["Part"]);
});

test("stream body deadline remains active after headers", async () => {
  const f = fixture({ timeoutMs: 25 });
  const result = f.provider.complete(request(), context(() => {})).catch(error => error);
  f.write(event("Part"));
  expect(String(await result)).toContain("timed out");
  expect(f.cancelled()).toBe(true);
});

for (const [name, data] of [
  ["truncated body", event("Part")],
  ["missing DONE", event("Part") + event("", "stop")],
  ["missing finish reason", event("Part") + "data: [DONE]\n\n"],
  ["invalid JSON", "data: invalid-secret-body\n\n"],
  ["provider error", 'data: {"error":{"message":"secret-body"}}\n\n'],
  ["unsolicited tool call", 'data: {"choices":[{"index":0,"delta":{"tool_calls":[]}}]}\n\n'],
] as const) test(`rejects ${name} without returning a successful answer`, async () => {
  const f = fixture();
  const result = f.provider.complete(request(), context(() => {})).catch(error => error);
  f.write(data); f.stream.close();
  const error = await result;
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("secret-body");
});

test("limits wire bytes and cancels on observer failure", async () => {
  const limited = fixture({ maxResponseBytes: 64 });
  const result = limited.provider.complete(request(), context(() => {})).catch(error => error);
  limited.write(event("x".repeat(100)));
  expect(String(await result)).toContain("maxResponseBytes"); expect(limited.cancelled()).toBe(true);
  const observer = fixture();
  const failed = observer.provider.complete(request(), context(() => { throw new Error("Observer stopped"); })).catch(error => error);
  observer.write(event("Part"));
  expect(String(await failed)).toContain("Observer stopped"); expect(observer.cancelled()).toBe(true);
});

test("structured and tool requests keep the existing complete-response contract", async () => {
  const bodies: any[] = [], deltas: string[] = [];
  const provider = new OpenAiCompatibleModelProvider({ provider: "fixture", baseUrl: "https://unused.invalid", model: "fixture", apiKey: "test" }, {
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Done" } }] });
    },
  });
  for (const extra of [
    { output: agentOutputContract({ mode: "json" }) },
    { tools: [agentToolContract({ name: "read", description: "Read", sideEffect: "read" })] },
  ]) await provider.complete(agentModelRequest({ ...request(), ...extra }), context(text => deltas.push(text)));
  expect(bodies[0].stream).toBeUndefined();
  expect(bodies[1].stream).toBe(true);
  expect(deltas).toEqual([]);
  // A compatible endpoint may ignore stream; its complete JSON still works.
  expect((await provider.complete(request(), context(text => deltas.push(text)))).finishReason).toBe("stop");
});
