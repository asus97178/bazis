import { describe, expect, test } from "bun:test";
import {
  AgentSemanticError,
  agentClassSchema,
  agentData,
  agentFile,
  agentImage,
  agentInvocation,
  agentJsonSchema,
  agentMessage,
  agentModelCapabilities,
  agentModelRequest,
  agentModelResponse,
  agentOutputContract,
  agentText,
  agentToolCall,
  agentToolCallPart,
  agentToolContract,
  agentToolResult,
  agentToolResultPart,
  normalizeJsonValue,
} from "../index";

describe("agent semantic content", () => {
  test("creates immutable provider-neutral messages", () => {
    const message = agentMessage("user", [
      agentText("Hello"),
      agentData({ sku: "A-1", tags: ["new"] }, { name: "product" }),
      agentImage("https://cdn.example/image.png", { mediaType: "image/png", detail: "high" }),
      agentFile("file://requirements.md", { mediaType: "text/markdown", name: "requirements" }),
    ], {
      id: "msg-1",
      createdAtUnixMs: 100,
      metadata: { tenant: "acme" },
    });

    expect(message.role).toBe("user");
    expect(message.content).toHaveLength(4);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
    expect(Object.isFrozen(message.metadata)).toBe(true);
    expect(message.content[1]).toMatchObject({ kind: "data", name: "product" });
  });

  test("keeps message text intact but rejects blank text", () => {
    expect(agentMessage("user", "  keep spacing  ").content[0]).toEqual({
      kind: "text",
      text: "  keep spacing  ",
    });
    expect(() => agentMessage("user", "   ")).toThrow(AgentSemanticError);
  });

  test("validates JSON-safe data at boundaries", () => {
    expect(normalizeJsonValue({ ok: true, list: [1, null, "x"] })).toEqual({ ok: true, list: [1, null, "x"] });
    expect(() => normalizeJsonValue({ bad: undefined })).toThrow(/must not be undefined/);
    expect(() => normalizeJsonValue(Number.NaN)).toThrow(/finite JSON number/);
    expect(() => normalizeJsonValue(new Date())).toThrow(/plain JSON object/);
  });

  test("rejects prototype-polluting JSON keys", () => {
    const malicious = JSON.parse('{"__proto__":{"isAdmin":true}}') as unknown;
    expect(() => agentToolCall({ id: "call-1", name: "unsafe", input: malicious })).toThrow(/__proto__/);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  test("tool-role messages must be tied to a tool call", () => {
    const result = agentToolResult({ callId: "call-1", name: "catalog.search", output: { count: 1 } });
    const message = agentMessage("tool", agentToolResultPart(result), { toolCallId: "call-1" });
    expect(message.toolCallId).toBe("call-1");
    expect(() => agentMessage("tool", "done")).toThrow(/toolCallId/);
    expect(() => agentMessage("assistant", "done", { toolCallId: "call-1" })).toThrow(/only tool messages/);
  });
});

describe("agent semantic tool contracts", () => {
  test("creates tool calls and tool results with immutable JSON payloads", () => {
    const call = agentToolCall({
      id: "call-1",
      name: "catalog.search",
      input: { query: "keyboard", limit: 5 },
    });
    const result = agentToolResult({
      callId: call.id,
      name: call.name,
      output: { items: [{ id: "p1" }] },
      durationMs: 12,
    });

    expect(call.input).toEqual({ query: "keyboard", limit: 5 });
    expect(result.status).toBe("success");
    expect(Object.isFrozen(call.input)).toBe(true);
    expect(Object.isFrozen(result.output as object)).toBe(true);
  });

  test("requires errors for failed or denied tool results", () => {
    expect(() => agentToolResult({ callId: "call-1", name: "catalog.delete", status: "error" })).toThrow(/require error/);
    expect(() =>
      agentToolResult({
        callId: "call-1",
        name: "catalog.delete",
        status: "denied",
        output: { ok: false },
        error: { message: "Denied by policy." },
      }),
    ).toThrow(/cannot include output/);

    const denied = agentToolResult({
      callId: "call-1",
      name: "catalog.delete",
      status: "denied",
      error: { code: "POLICY", message: "Denied by policy.", details: { approval: "required" } },
    });
    expect(denied.error?.code).toBe("POLICY");
  });

  test("applies secure approval defaults to tool contracts", () => {
    const read = agentToolContract({ name: "catalog.search", description: "Find products.", sideEffect: "read" });
    const write = agentToolContract({ name: "catalog.reindex", description: "Rebuild index.", sideEffect: "write" });

    expect(read.approval).toBe("policy");
    expect(write.approval).toBe("required");
    expect(() =>
      agentToolContract({
        name: "catalog.delete",
        description: "Delete product.",
        sideEffect: "external",
        approval: "never",
      }),
    ).toThrow(/approval/);
  });
});

describe("agent semantic invocation and model exchange", () => {
  test("builds invocation, output contract and model request", () => {
    const inputSchema = agentClassSchema("ProductSearchInput");
    const outputSchema = agentJsonSchema("ProductSummary", {
      type: "object",
      properties: { title: { type: "string" } },
    });
    const output = agentOutputContract({ mode: "json", schema: outputSchema });
    const tool = agentToolContract({
      name: "catalog.search",
      description: "Find products.",
      input: inputSchema,
      sideEffect: "read",
    });
    const message = agentMessage("user", "Find a product");
    const invocation = agentInvocation({
      id: "inv-1",
      agentName: "product-designer",
      input: { query: "keyboard" },
      messages: [message],
      output,
    });
    const request = agentModelRequest({
      invocationId: invocation.id,
      messages: invocation.messages,
      tools: [tool],
      output,
      capabilities: agentModelCapabilities({ toolCalling: true, structuredOutput: true, maxContextTokens: 8192 }),
      modelProfile: "reasoning",
      model: "policy/default",
      temperature: 0.2,
    });

    expect(request.invocationId).toBe("inv-1");
    expect(request.modelProfile).toBe("reasoning");
    expect(request.tools[0]?.approval).toBe("policy");
    expect(request.output?.schema?.kind).toBe("json-schema");
    expect(request.capabilities?.toolCalling).toBe(true);
  });

  test("model requests need messages", () => {
    expect(() => agentModelRequest({ invocationId: "inv-1", messages: [] })).toThrow(/messages must not be empty/);
  });

  test("keeps assistant tool calls and all matching results in one adjacent protocol block", () => {
    const firstCall = agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } });
    const secondCall = agentToolCall({ id: "call-2", name: "catalog.search", input: { query: "mouse" } });
    const assistant = agentMessage("assistant", [agentToolCallPart(firstCall), agentToolCallPart(secondCall)]);
    const secondResult = agentMessage(
      "tool",
      agentToolResultPart(agentToolResult({ callId: secondCall.id, name: secondCall.name, output: { count: 1 } })),
      { toolCallId: secondCall.id },
    );
    const firstResult = agentMessage(
      "tool",
      agentToolResultPart(agentToolResult({ callId: firstCall.id, name: firstCall.name, output: { count: 1 } })),
      { toolCallId: firstCall.id },
    );

    expect(() => agentModelRequest({
      invocationId: "inv-1",
      messages: [agentMessage("user", "Find products"), assistant, secondResult, firstResult, agentMessage("user", "Continue")],
    })).not.toThrow();

    expect(() => agentModelRequest({
      invocationId: "inv-1",
      messages: [assistant, agentMessage("user", "interleaved"), secondResult, firstResult],
    })).toThrow(/immediately after/);

    const wrongName = agentMessage(
      "tool",
      agentToolResultPart(agentToolResult({ callId: firstCall.id, name: "catalog.other", output: null })),
      { toolCallId: firstCall.id },
    );
    expect(() => agentModelRequest({
      invocationId: "inv-1",
      messages: [assistant, wrongName, secondResult],
    })).toThrow(/instead of/);
  });

  test("model responses enforce finish reason invariants and usage validation", () => {
    const call = agentToolCall({ id: "call-1", name: "catalog.search", input: { query: "keyboard" } });
    const toolResponse = agentModelResponse({
      invocationId: "inv-1",
      finishReason: "tool-calls",
      toolCalls: [call],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, latencyMs: 25, cost: { amount: 0.001, currency: "USD" } },
    });
    expect(toolResponse.toolCalls[0]?.name).toBe("catalog.search");
    expect(toolResponse.usage?.cost?.currency).toBe("USD");

    const finalResponse = agentModelResponse({
      invocationId: "inv-1",
      finishReason: "stop",
      message: agentMessage("assistant", "Done"),
    });
    expect(finalResponse.message?.content[0]).toEqual({ kind: "text", text: "Done" });

    expect(() => agentModelResponse({ invocationId: "inv-1", finishReason: "tool-calls" })).toThrow(/requires at least one tool call/);
    expect(() =>
      agentModelResponse({
        invocationId: "inv-1",
        finishReason: "stop",
        usage: { inputTokens: -1 },
      }),
    ).toThrow(/requires a message/);
  });

  test("artifact output requires an artifact type", () => {
    expect(() => agentOutputContract({ mode: "artifact" })).toThrow(/artifactType/);
    expect(agentOutputContract({ mode: "artifact", artifactType: "ArchitectureDecision" }).artifactType).toBe("ArchitectureDecision");
  });

  test("rejects invalid semantic discriminants and snapshots nested response messages", () => {
    expect(() => agentMessage("admin" as never, "x")).toThrow(/role/);
    expect(() => agentToolContract({ name: "x", description: "x", approval: "bypass" as never })).toThrow(/approval/);
    const raw = { role: "assistant" as const, content: [{ kind: "text" as const, text: "original" }], metadata: {} };
    const response = agentModelResponse({ invocationId: "inv", finishReason: "stop", message: raw });
    raw.content[0]!.text = "changed";
    expect(response.message?.content[0]).toEqual({ kind: "text", text: "original" });
  });

  test("snapshots nested schema, output and capability contracts", () => {
    const schema = { kind: "json-schema" as const, name: "payload", schema: { type: "object", properties: { x: { type: "string" } } }, strict: true };
    const output = { mode: "json" as const, schema };
    const capabilities = { toolCalling: true, streaming: false, structuredOutput: true, jsonMode: true, multimodalInput: false, imageOutput: false };
    const request = agentModelRequest({ invocationId: "inv", messages: [agentMessage("user", "x")], tools: [agentToolContract({ name: "x", description: "x", input: schema, output: schema })], output, capabilities });
    (schema.schema.properties as { x: { type: string } }).x.type = "number";
    (capabilities as { toolCalling: boolean }).toolCalling = false;
    expect(request.output?.schema?.kind).toBe("json-schema");
    if (request.output?.schema?.kind !== "json-schema") throw new Error("expected JSON schema output");
    expect((request.output.schema.schema as { properties: { x: { type: string } } }).properties.x.type).toBe("string");
    expect(request.capabilities?.toolCalling).toBe(true);
    expect(Object.isFrozen(request.output?.schema)).toBe(true);
  });
});
