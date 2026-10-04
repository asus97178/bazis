import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CodexError } from "./contracts";

export type RpcObject = Record<string, unknown>;
export type RpcListener = (method: string, params: RpcObject) => void;
const MAX_FRAME = 1_048_576, MAX_PENDING = 64;

/** One private, bounded JSON-RPC connection. Never logs wire data or retries requests. */
export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: RpcObject) => void; reject: (error: Error) => void; clean: () => void }>();
  private readonly listeners = new Set<RpcListener>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly handlers = new Map<string, (params: RpcObject) => Promise<RpcObject>>();
  private readonly incoming = new Map<string | number, string>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private failure?: Error;
  private readonly exited: Promise<void>;

  constructor(binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
    this.child = spawn(binary, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume(); // Drain without retaining credentials, prompts or arbitrary diagnostics.
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.stdin.on("error", () => this.close(new CodexError("UNAVAILABLE")));
    this.child.on("error", () => this.close(new CodexError("UNAVAILABLE")));
    this.exited = new Promise(resolve => this.child.once("close", () => {
      this.close(new CodexError("UNAVAILABLE")); resolve();
    }));
  }
  get alive(): boolean { return !this.failure; }

  request(method: string, params: unknown = {}, timeoutMs = 15_000, signal?: AbortSignal): Promise<RpcObject> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new CodexError("BUSY"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => this.close(signal?.reason instanceof Error ? signal.reason : new CodexError("TIMEOUT"));
      const timer = setTimeout(() => this.close(new CodexError("TIMEOUT")), timeoutMs);
      const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, clean });
      signal?.addEventListener("abort", abort, { once: true });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }
  /** Only dynamic tools for an explicitly subscribed thread can reach application code. */
  handleTools(threadId: string, handler: (params: RpcObject) => Promise<RpcObject>): () => void {
    if (!this.alive || this.handlers.has(threadId) || this.handlers.size >= 8) throw new CodexError("BUSY");
    this.handlers.set(threadId, handler);
    return () => { if (this.handlers.get(threadId) === handler) this.handlers.delete(threadId); };
  }
  hasPendingTools(threadId: string): boolean {
    return Array.from(this.incoming.values()).includes(threadId);
  }
  subscribe(listener: RpcListener, failure: (error: Error) => void = () => {}): () => void {
    if (this.failure) { failure(this.failure); return () => {}; }
    if (this.listeners.size >= 32) throw new CodexError("BUSY");
    this.listeners.add(listener); this.failures.add(failure);
    return () => { this.listeners.delete(listener); this.failures.delete(failure); };
  }
  close(error: Error = new CodexError("UNAVAILABLE")): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.pending.values()) { item.clean(); item.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) { try { listener(error); } catch { /* Already failed. */ } }
    this.listeners.clear(); this.failures.clear(); this.buffer = "";
    this.handlers.clear(); this.incoming.clear();
    this.child.stdin.destroy(); this.child.kill("SIGTERM");
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    kill.unref(); void this.exited?.then(() => clearTimeout(kill));
  }
  async stop(): Promise<void> { this.close(); await this.exited; }

  private write(value: unknown): void {
    if (this.failure) return;
    const frame = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME || this.child.stdin.writableLength + Buffer.byteLength(frame) > 2 * MAX_FRAME) {
      this.close(new CodexError("PROTOCOL_ERROR")); return;
    }
    this.child.stdin.write(frame, error => { if (error) this.close(new CodexError("UNAVAILABLE")); });
  }
  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) throw new CodexError("PROTOCOL_ERROR");
        if (!line.trim()) continue;
        const message = object(JSON.parse(line));
        if (typeof message.method === "string") {
          if (message.id !== undefined) {
            this.receiveRequest(message);
          } else {
            for (const listener of this.listeners) listener(message.method, object(message.params ?? {}));
          }
        } else if (typeof message.id === "number") {
          const item = this.pending.get(message.id);
          if (!item) continue;
          this.pending.delete(message.id); item.clean();
          if (message.error !== undefined) item.reject(new CodexError("RESPONSE_FAILED"));
          else {
            try { item.resolve(object(message.result)); }
            catch { item.reject(new CodexError("PROTOCOL_ERROR")); this.close(new CodexError("PROTOCOL_ERROR")); }
          }
        } else throw new CodexError("PROTOCOL_ERROR");
        if (this.failure) return;
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) throw new CodexError("PROTOCOL_ERROR");
    } catch { this.close(new CodexError("PROTOCOL_ERROR")); }
  }
  private receiveRequest(message: RpcObject): void {
    const id = message.id;
    const validId = typeof id === "string" ? id.length > 0 && id.length <= 256 : typeof id === "number" && Number.isSafeInteger(id);
    if (!validId || this.incoming.has(id as string | number) || this.incoming.size >= 32) {
      throw new CodexError("PROTOCOL_ERROR");
    }
    const params = object(message.params ?? {});
    const handler = message.method === "item/tool/call" && typeof params.threadId === "string"
      ? this.handlers.get(params.threadId) : undefined;
    const deny = () => {
      this.write({ id, error: { code: -32601, message: "Client capability is unavailable" } });
      for (const listener of this.listeners) listener("osnova/unsupportedRequest", params);
    };
    if (!handler) { deny(); return; }
    this.incoming.set(id as string | number, params.threadId as string);
    void Promise.resolve().then(() => handler(params)).then(result => {
      this.write({ id, result });
    }, deny).catch(() => this.close(new CodexError("PROTOCOL_ERROR")))
      .finally(() => this.incoming.delete(id as string | number));
  }
}
export function object(value: unknown): RpcObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexError("PROTOCOL_ERROR");
  return value as RpcObject;
}
export function text(value: unknown, maximum = 32_000): string {
  if (typeof value !== "string" || value.length > maximum) throw new CodexError("PROTOCOL_ERROR");
  return value;
}
