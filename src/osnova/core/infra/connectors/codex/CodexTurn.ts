import type { CodexTool, CodexRunInput } from "./contracts";
import { CodexError } from "./contracts";
import { CodexAppServer, object, text, type RpcObject } from "./CodexAppServer";

/** Exactly one turn of an isolated ephemeral thread. Osnova owns persisted conversation history. */
export class CodexTurn {
  constructor(private readonly client: CodexAppServer) {}

  async run(threadId: string, input: string, signal: AbortSignal, onText: (delta: string) => void, effort?: string, tools: readonly CodexTool[] = [], onToolCall?: CodexRunInput["onToolCall"]): Promise<string> {
    let turnId: string | undefined, terminal = false, stopped = false, settled = false, output = "";
    const items = new Map<string, string>();
    const calls = new Set<string>();
    const toolLifetime = new AbortController();
    const toolSignal = AbortSignal.any([signal, toolLifetime.signal]);
    let startReady!: () => void;
    const started = new Promise<void>(resolve => { startReady = resolve; });
    let queue = Promise.resolve();
    const unhandle = this.client.handleTools(threadId, async params => {
      await started;
      if (!onToolCall || stopped || settled || toolSignal.aborted || params.turnId !== turnId
        || (params.namespace !== null && params.namespace !== undefined)) throw new CodexError("PROTOCOL_ERROR");
      const id = text(params.callId, 256), name = text(params.tool, 64);
      if (!id || calls.has(id) || calls.size >= 16 || !tools.some(tool => tool.name === name)) throw new CodexError("PROTOCOL_ERROR");
      calls.add(id);
      const work = queue.then(async () => {
        toolSignal.throwIfAborted();
        const result = await new Promise<Awaited<ReturnType<NonNullable<CodexRunInput["onToolCall"]>>>>((resolve, reject) => {
          const abort = () => reject(new CodexError("RESPONSE_FAILED"));
          toolSignal.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => { toolSignal.throwIfAborted(); return onToolCall({ id, name, arguments: params.arguments }, toolSignal); })
            .then(resolve, reject).finally(() => toolSignal.removeEventListener("abort", abort));
        });
        toolSignal.throwIfAborted();
        if (!result || typeof result.success !== "boolean" || typeof result.text !== "string" || result.text.length > 128000) throw new CodexError("PROTOCOL_ERROR");
        return { contentItems: [{ type: "inputText", text: result.text }], success: result.success };
      });
      queue = work.then(() => {}, () => {});
      return work;
    });
    const early: [string, RpcObject][] = [];
    let earlyBytes = 0;
    let resolve!: (value: string) => void, reject!: (reason: Error) => void;
    const completed = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    // The transport can fail while turn/start is still in flight.
    void completed.catch(() => {});
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const append = (id: string, delta: string) => {
      if (signal.aborted || stopped || settled) return;
      const prefix = !items.has(id) && items.size ? "\n\n" : "";
      if (items.size >= 32 && !items.has(id) || output.length + prefix.length + delta.length > 32_000) {
        throw new CodexError("RESPONSE_FAILED");
      }
      items.set(id, (items.get(id) ?? "") + delta);
      output += prefix + delta;
      if (prefix || delta) onText(prefix + delta);
    };
    const itemCompleted = (value: unknown) => {
      const item = object(value);
      if (item.type !== "agentMessage") return;
      const id = text(item.id, 256), valueText = text(item.text), existing = items.get(id) ?? "";
      if (!valueText.startsWith(existing)) throw new CodexError("PROTOCOL_ERROR");
      append(id, valueText.slice(existing.length));
    };
    const handle = (method: string, params: RpcObject) => {
      if (params.threadId !== threadId) return;
      if (!turnId) {
        earlyBytes += JSON.stringify(params).length;
        if (early.length >= 128 || earlyBytes > 128_000) throw new CodexError("PROTOCOL_ERROR");
        early.push([method, params]); return;
      }
      if (method === "osnova/unsupportedRequest") { fail(new CodexError("RESPONSE_FAILED")); return; }
      const eventTurnId = method === "turn/completed" ? object(params.turn).id : params.turnId;
      if (eventTurnId !== undefined && eventTurnId !== turnId) return;
      if (method === "turn/completed") {
        terminal = true;
        // A final model message cannot acknowledge an unfinished host action.
        // The transport counts requests before dispatching asynchronous callbacks.
        if (this.client.hasPendingTools(threadId)) { fail(new CodexError("PROTOCOL_ERROR")); return; }
        const turn = object(params.turn);
        if (turn.status !== "completed" || signal.aborted || stopped) { fail(new CodexError("RESPONSE_FAILED")); return; }
        if (Array.isArray(turn.items)) for (const item of turn.items) itemCompleted(item);
        if (!output.trim()) { fail(new CodexError("RESPONSE_FAILED")); return; }
        if (!settled) { settled = true; resolve(output.trim()); }
      } else if (method === "item/agentMessage/delta") {
        append(text(params.itemId, 256), text(params.delta));
      } else if (method === "item/completed") itemCompleted(params.item);
      else if (method === "item/started") {
        if (!["agentMessage", "userMessage", "reasoning", ...(tools.length ? ["dynamicToolCall"] : [])].includes(text(object(params.item).type, 128))) {
          fail(new CodexError("RESPONSE_FAILED"));
        }
      }
    };
    const unsubscribe = this.client.subscribe((method, params) => {
      try { handle(method, params); } catch { fail(new CodexError("PROTOCOL_ERROR")); }
    }, fail);
    const abort = () => { stopped = true; fail(signal.reason instanceof Error ? signal.reason : new CodexError("TIMEOUT")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.client.request("turn/start", {
        threadId, input: [{ type: "text", text: input, text_elements: [] }],
        ...(effort !== undefined ? { effort } : {}),
      }, 15_000, signal);
      turnId = text(object(response.turn).id, 256);
      startReady();
      for (const [method, params] of early) handle(method, params);
      early.length = 0;
      return await completed;
    } finally {
      toolLifetime.abort(); startReady(); unhandle();
      await queue;
      signal.removeEventListener("abort", abort);
      if (!terminal && turnId && this.client.alive) {
        stopped = true;
        try {
          await this.client.request("turn/interrupt", { threadId, turnId }, 3000);
          // A successful RPC only acknowledges the interrupt request, not completion of generation.
          if (!terminal) await new Promise<void>(done => {
            let clean = () => {};
            const timer = setTimeout(() => { clean(); this.client.close(new CodexError("TIMEOUT")); done(); }, 3000);
            clean = this.client.subscribe((method, params) => {
              if (method === "turn/completed" && params.threadId === threadId && object(params.turn).id === turnId) {
                clearTimeout(timer); clean(); done();
              }
            }, () => { clearTimeout(timer); clean(); done(); });
            if (terminal) { clearTimeout(timer); clean(); done(); }
          });
        } catch { this.client.close(new CodexError("UNAVAILABLE")); }
      }
      unsubscribe();
    }
  }
}
