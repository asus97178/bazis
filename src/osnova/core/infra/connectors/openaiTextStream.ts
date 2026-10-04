/** Bounded SSE assembly. Tool arguments are executed only after the complete response is validated. */
export async function readOpenAiTextStream(
  response: Response, signal: AbortSignal, maxBytes: number, onText: (text: string) => void, allowTools = false,
): Promise<unknown> {
  const fail = (reason: string): never => { throw new Error(`OpenAI-compatible stream ${reason}.`); };
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    fail("exceeds maxResponseBytes");
  }
  if (!response.body) return fail("body is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text: string[] = [];
  const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  let buffer = "", fields: string[] = [], frameChars = 0, total = 0;
  let finish: string | undefined, done = false, usage: unknown;
  const maxFrameChars = Math.min(maxBytes, 1024 * 1024);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const dispatch = () => {
    if (!fields.length) return;
    const data = fields.join("\n"); fields = []; frameChars = 0;
    if (data === "[DONE]") {
      if (!finish) fail("ended without a finish reason");
      done = true;
      return;
    }
    let packet: Record<string, unknown>;
    try {
      const value = JSON.parse(data);
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("contains an invalid event");
      packet = value;
    } catch { return fail("contains invalid JSON"); }
    if (packet.error) fail("reported a provider error");
    if (packet.usage) usage = packet.usage;
    if (!Array.isArray(packet.choices)) return fail("contains invalid choices");
    for (const choice of packet.choices) {
      if (!choice || choice.index !== 0) fail("contains an unexpected choice");
      const delta = choice.delta;
      if (!delta || typeof delta !== "object" || Array.isArray(delta)
        || (!allowTools && delta.tool_calls != null) || delta.function_call != null) fail("contains an unsupported delta");
      if (delta.tool_calls != null) {
        if (finish || !Array.isArray(delta.tool_calls) || delta.tool_calls.length > 16) fail("contains invalid tool calls");
        for (const part of delta.tool_calls) {
          if (!part || !Number.isInteger(part.index) || part.index < 0 || part.index >= 16
            || (part.type !== undefined && part.type !== "function")) fail("contains an invalid tool fragment");
          const call = calls.get(part.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (part.id !== undefined) {
            if (typeof part.id !== "string" || !part.id || part.id.length > 256 || (call.id && call.id !== part.id)) fail("contains an invalid tool id");
            call.id = part.id;
          }
          if (part.function !== undefined) {
            if (!part.function || typeof part.function !== "object" || Array.isArray(part.function)) fail("contains an invalid function");
            for (const key of ["name", "arguments"] as const) {
              const value = part.function[key];
              if (value !== undefined) {
                if (typeof value !== "string") fail("contains an invalid function fragment");
                call.function[key] += value;
              }
            }
          }
          if (call.function.name.length > 128 || call.function.arguments.length > maxBytes) fail("tool exceeds its size limit");
          calls.set(part.index, call);
        }
      }
      if (delta.content != null) {
        if (typeof delta.content !== "string" || finish) fail("contains invalid text");
        if (delta.content) {
          signal.throwIfAborted();
          text.push(delta.content);
          onText(delta.content);
          signal.throwIfAborted();
        }
      }
      if (choice.finish_reason != null) {
        if (finish || !["stop", "length", "content_filter", ...(allowTools ? ["tool_calls"] : [])].includes(choice.finish_reason)) fail("contains an invalid finish reason");
        finish = choice.finish_reason;
      }
    }
  };
  const consume = () => {
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index];
      if (char !== "\r" && char !== "\n") continue;
      // Preserve a CR at a chunk boundary until its possible LF arrives.
      if (char === "\r" && index + 1 === buffer.length) break;
      const line = buffer.slice(start, index);
      if (char === "\r" && buffer[index + 1] === "\n") index++;
      start = index + 1;
      if (line === "") dispatch();
      else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        frameChars += value.length + 1;
        if (frameChars > maxFrameChars) fail("event exceeds its size limit");
        fields.push(value);
      }
      if (done) break;
    }
    buffer = buffer.slice(start);
    if (!done && buffer.length + frameChars > maxFrameChars) fail("event exceeds its size limit");
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!done) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) {
        // CR alone is a valid SSE line ending, including the last byte at EOF.
        if (buffer.endsWith("\r")) { buffer += "\n"; consume(); }
        break;
      }
      total += item.value.byteLength;
      if (total > maxBytes) fail("exceeds maxResponseBytes");
      try { buffer += decoder.decode(item.value, { stream: true }); }
      catch { fail("contains invalid UTF-8"); }
      consume();
    }
    // EOF alone is not success: both a terminal choice and [DONE] are required.
    if (!done) fail("was interrupted before completion");
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call], position) => {
      if (index !== position || !call.id || !call.function.name || !call.function.arguments) fail("contains an incomplete tool call");
      return call;
    });
    if ((toolCalls.length > 0) !== (finish === "tool_calls") || new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) fail("contains inconsistent tool calls");
    return { choices: [{ finish_reason: finish, message: { content: text.join(""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }], usage };
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel(); // Also release a peer that sends [DONE] but never closes its body.
    reader.releaseLock();
  }
}
