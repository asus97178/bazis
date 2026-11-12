import type { HostedService, HostedServiceHealth } from "../../di";
import type { PermissionSources } from "./PermissionSources";

/** After the infrastructure and the schema (phases below), before the HTTP host (phase 10). */
const PHASE = 5;

/**
 * Reads the permission sources before the application takes requests and
 * then asks their versions every `access.sourcePollSeconds` (ACCESS-001 §3.1).
 * A source that fails does not stop the start: its permissions do not exist
 * until a later reading succeeds, and `/health` says so.
 */
export class PermissionSourceLoader implements HostedService {
  readonly phase = PHASE;
  readonly diagnosticName = "access:permission-sources";
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly sources: PermissionSources) {}

  async start(): Promise<void> {
    await this.sources.load();
    const seconds = this.sources.pollSeconds;
    if (seconds <= 0) return;
    this.timer = setInterval(() => {
      // One question at a time: a slow source is not asked again before it answers.
      this.polling ??= this.sources.poll().finally(() => { this.polling = undefined; });
    }, seconds * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  checkHealth(): HostedServiceHealth {
    const failed = this.sources.state().filter((source) => !source.loaded || source.error !== undefined);
    if (failed.length === 0) return { healthy: true };
    return { healthy: false, details: failed.map((source) => `permission source "${source.prefix}": ${source.loaded ? "" : "not loaded: "}${source.error ?? "no reading yet"}`).join("; ") };
  }
}
