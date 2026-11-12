import { describe, expect, test } from "bun:test";
import { createContainer, Module } from "@/core/di";
import {
  AgentRuntime,
  Tool,
  agentMessage,
  agentModelResponse,
  agentToolCall,
  type AgentModelProvider,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentRunEvent,
  type AgentToolApprovalPolicy,
  type AgentToolExecutionContext,
  type JsonObject,
} from "../index";
import { withToolExecution } from "./toolExecution.fixture";

type Reply = (request: AgentModelRequest) => AgentModelResponse;

class ScriptedModel implements AgentModelProvider {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly replies: readonly Reply[]) {}

  complete(request: AgentModelRequest): AgentModelResponse {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (reply === undefined) throw new Error(`The model was called ${this.requests.length} times; the script has ${this.replies.length} replies.`);
    return reply(request);
  }
}

const say = (value: string): Reply => (request) => agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", value) });
const call = (...items: readonly { readonly id: string; readonly name: string; readonly input?: JsonObject }[]): Reply =>
  (request) => agentModelResponse({ invocationId: request.invocationId, finishReason: "tool-calls", toolCalls: items.map((item) => agentToolCall(item)) });

const done: string[] = [];
const approvals: string[] = [];

@Tool({ callers: ["agent"], name: "orders.find", description: "Finds an order.", sideEffect: "read" })
class FindOrderTool {
  execute(input: JsonObject): JsonObject {
    done.push(`find:${String(input.id)}`);
    return { id: input.id ?? null, status: "paid" };
  }
}

@Tool({ callers: ["agent"], name: "orders.cancel", description: "Cancels an order.", sideEffect: "write" })
class CancelOrderTool {
  execute(input: JsonObject, context: AgentToolExecutionContext): JsonObject {
    done.push(`cancel:${String(input.id)}`);
    approvals.push(context.approval);
    return { id: input.id ?? null, status: "cancelled" };
  }
}

@Module({ tools: [FindOrderTool, CancelOrderTool] })
class OrdersModule {}

const operator = { name: "operator", instructions: "Help with orders.", toolNames: ["orders.find", "orders.cancel"] };

/** Reading is allowed, a change is left to a person. */
const askForChanges: AgentToolApprovalPolicy = (request) => request.tool.metadata.sideEffect === "read" ? true : "ask";

function runtimeOf(model: AgentModelProvider, approvalPolicy: AgentToolApprovalPolicy = askForChanges) {
  done.length = 0;
  approvals.length = 0;
  const container = createContainer(withToolExecution(OrdersModule, { approvalPolicy, auditSink: () => undefined }));
  return { runtime: new AgentRuntime(container, model), dispose: () => container.dispose() };
}

function roles(result: { readonly messages: readonly { readonly role: string }[] }): string[] {
  return result.messages.map((message) => message.role);
}

describe("a Tool call that waits for a person", () => {
  test("stops the run with status waiting, and nothing is changed", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.cancel", input: { id: 7 } })]);
    const { runtime, dispose } = runtimeOf(model);
    try {
      const events: AgentRunEvent[] = [];
      const result = await runtime.run(operator, { input: "Cancel order 7", onEvent: (event) => events.push(event) });

      expect(result.status).toBe("waiting");
      expect(result.error).toBeUndefined();
      expect(result.pendingApprovals).toEqual([{ call: { id: "c1", name: "orders.cancel", input: { id: 7 }, metadata: {} }, tool: { name: "orders.cancel", description: "Cancels an order.", sideEffect: "write" } }]);
      expect(done).toEqual([]);
      // The dialog ends with the call nobody has answered yet.
      expect(roles(result)).toEqual(["user", "assistant"]);
      expect(result.toolResults).toEqual([]);
      expect(events.map((event) => event.kind)).toEqual(["step-started", "model-answered", "tool-started", "finished"]);
    } finally { await dispose(); }
  });

  test("runs the Tool as approved and goes on when the person says yes", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.cancel", input: { id: 7 } }), say("Order 7 is cancelled.")]);
    const { runtime, dispose } = runtimeOf(model);
    try {
      const first = await runtime.run(operator, { id: "run-1", input: "Cancel order 7" });
      const second = await runtime.run(operator, { id: "run-1", messages: first.messages, approvals: [{ callId: "c1", approved: true }] });

      expect(second.status).toBe("completed");
      expect(done).toEqual(["cancel:7"]);
      expect(approvals).toEqual(["approved"]);
      expect(roles(second)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(second.toolResults).toMatchObject([{ callId: "c1", status: "success", output: { id: 7, status: "cancelled" } }]);
      // The model was asked once before the pause and once after the Tool ran.
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    } finally { await dispose(); }
  });

  test("tells the model why when the person says no", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.cancel", input: { id: 7 } }), say("I have not cancelled it.")]);
    const { runtime, dispose } = runtimeOf(model);
    try {
      const first = await runtime.run(operator, { input: "Cancel order 7" });
      const second = await runtime.run(operator, { messages: first.messages, approvals: [{ callId: "c1", approved: false, message: "The order is already shipped." }] });

      expect(second.status).toBe("completed");
      expect(done).toEqual([]);
      expect(second.toolResults[0]).toMatchObject({ callId: "c1", status: "denied", error: { code: "TOOL_APPROVAL_DENIED", message: "Tool \"orders.cancel\" was declined: The order is already shipped." } });
    } finally { await dispose(); }
  });

  test("keeps what was done before the call and does the rest after the answer", async () => {
    const model = new ScriptedModel([
      call({ id: "c1", name: "orders.find", input: { id: 7 } }, { id: "c2", name: "orders.cancel", input: { id: 7 } }, { id: "c3", name: "orders.find", input: { id: 8 } }),
      say("Done."),
    ]);
    const { runtime, dispose } = runtimeOf(model);
    try {
      const first = await runtime.run(operator, { input: "Check 7, cancel it, check 8" });
      expect(first.status).toBe("waiting");
      expect(first.pendingApprovals?.map((item) => item.call.id)).toEqual(["c2"]);
      expect(done).toEqual(["find:7"]);
      expect(roles(first)).toEqual(["user", "assistant", "tool"]);

      const second = await runtime.run(operator, { messages: first.messages, approvals: [{ callId: "c2", approved: true }] });
      expect(second.status).toBe("completed");
      expect(done).toEqual(["find:7", "cancel:7", "find:8"]);
      expect(second.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
    } finally { await dispose(); }
  });

  test("still waits when it is continued without an answer, and refuses wrong continuations", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.cancel", input: { id: 7 } })]);
    const { runtime, dispose } = runtimeOf(model);
    try {
      const first = await runtime.run(operator, { input: "Cancel order 7" });

      const again = await runtime.run(operator, { messages: first.messages });
      expect(again.status).toBe("waiting");
      expect(again.pendingApprovals?.[0]?.call.id).toBe("c1");

      const withInput = await runtime.run(operator, { messages: first.messages, input: "Please hurry" });
      expect(withInput.error).toMatchObject({ code: "AGENT_INPUT_INVALID" });
      expect(withInput.error?.message).toContain("continue it with approvals, not with input");

      const stranger = await runtime.run(operator, { messages: first.messages, approvals: [{ callId: "other", approved: true }] });
      expect(stranger.error?.message).toContain("does not wait for approval");
      expect(done).toEqual([]);
      expect(model.requests).toHaveLength(1);
    } finally { await dispose(); }
  });

  test("a policy may refuse with words for the model", async () => {
    const model = new ScriptedModel([call({ id: "c1", name: "orders.cancel", input: { id: 7 } }), say("Understood.")]);
    const { runtime, dispose } = runtimeOf(model, () => ({ approved: false, message: "Cancelling is closed until Monday." }));
    try {
      const result = await runtime.run(operator, { input: "Cancel order 7" });
      expect(result.status).toBe("completed");
      expect(result.toolResults[0]?.error?.message).toBe("Tool \"orders.cancel\" was declined: Cancelling is closed until Monday.");
    } finally { await dispose(); }
  });
});
