import { expect, test } from "bun:test";
import { createContainer } from "../../di";
import { AgentRegistry, AgentRuntime, agentMessage, agentModelResponse, type AgentModelProviderContext, type AgentModelResponse } from "../index";

for (const outcome of ["complete", "abort", "timeout"] as const) test(`runtime forwards provisional text and rejects late deltas after ${outcome}`, async () => {
  const services = createContainer({});
  const registry = AgentRegistry.fromDefinition({ name: "main", instructions: "Answer" });
  const controller = new AbortController();
  const deltas: unknown[] = [];
  let context!: AgentModelProviderContext, settle!: (value: AgentModelResponse) => void, started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const runtime = new AgentRuntime(services, registry, { complete(_request, ctx) {
    context = ctx; started(); return new Promise(resolve => { settle = resolve; });
  } });
  try {
    const result = runtime.invoke("main", { id: "stream", input: "Hi", signal: controller.signal,
      timeoutMs: outcome === "timeout" ? 25 : 1000, onTextDelta: delta => deltas.push(delta) });
    await dispatched;
    context.onTextDelta!("First"); expect(deltas).toEqual([{ step: 1, text: "First" }]);
    const final = agentModelResponse({ invocationId: "stream", finishReason: "stop", message: agentMessage("assistant", "First final") });
    if (outcome === "complete") settle(final);
    if (outcome === "abort") controller.abort();
    expect((await result).status).toBe(outcome === "complete" ? "completed" : "failed");
    context.onTextDelta!("Too late"); settle(final);
    expect(deltas).toEqual([{ step: 1, text: "First" }]);
  } finally { await services.dispose(); }
});
