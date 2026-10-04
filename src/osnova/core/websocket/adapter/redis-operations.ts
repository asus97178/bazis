import type { RedisClient } from "bun";
import { WebSocketDeliveryError } from "../reliable-delivery";

/** Bounds waiting and native in-flight work without closing the host's client. */
export class RedisWebSocketOperations {
  private pending = 0;
  private timedOut = 0;
  constructor(private readonly client: RedisClient, private readonly timeoutMs: number, private readonly maxPending: number) {}

  async send(command: string, args: string[]): Promise<unknown> {
    return this.run(() => this.client.send(command, args));
  }

  async run(operation: () => Promise<unknown>): Promise<unknown> {
    if (this.timedOut > 0 || this.pending >= this.maxPending) throw new WebSocketDeliveryError("STORE_BUSY");
    this.pending++;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const native = Promise.resolve().then(operation);
    const settled = native.finally(() => {
      this.pending--;
      if (expired) this.timedOut--;
      if (timer !== undefined) clearTimeout(timer);
    });
    return Promise.race([settled, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        this.timedOut++;
        reject(new WebSocketDeliveryError("STORE_TIMEOUT"));
      }, this.timeoutMs);
    })]);
  }
}
