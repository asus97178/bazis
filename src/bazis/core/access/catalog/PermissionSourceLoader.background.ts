import type { HostedService, HostedServiceHealth } from "../../di";
import type { PermissionSourcesService } from "./PermissionSources.service";

/** After the infrastructure and the schema (phases below), before the HTTP host (phase 10). */
const PHASE = 5;
/** How often a failed source is tried again when the versions are not polled. */
const RETRY_SECONDS = 5;
/** A failure or two is a database that blinked; `/health` reports a source that keeps failing. */
const UNHEALTHY_AFTER = 3;

/**
 * Reads the permission sources before the application takes requests and
 * then asks their versions every `access.sourcePollSeconds` (ACCESS-001 §3.1).
 * A source that fails does not stop the start: its permissions do not exist
 * until a later reading succeeds, and `/health` says so. Without a poll
 * (`sourcePollSeconds: 0`) only the sources that failed are tried again.
 */
export class PermissionSourceLoader implements HostedService {
  readonly phase = PHASE;
  readonly diagnosticName = "access:permission-sources";
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly sources: PermissionSourcesService) {}

  async start(): Promise<void> {
    if (this.sources.count === 0) return;
    await this.sources.load();
    const poll = this.sources.pollSeconds;
    this.timer = setInterval(() => {
      // One question at a time: a slow source is not asked again before it answers.
      this.polling ??= (poll > 0 ? this.sources.poll() : this.sources.retry()).catch(() => undefined).finally(() => { this.polling = undefined; });
    }, (poll > 0 ? poll : RETRY_SECONDS) * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  /** Unhealthy: a source without permissions at all, or one whose readings keep failing. */
  checkHealth(): HostedServiceHealth {
    const failed = this.sources.state().filter((source) => !source.loaded || source.failures >= UNHEALTHY_AFTER);
    if (failed.length === 0) return { healthy: true };
    return { healthy: false, details: failed.map((source) => `permission source "${source.prefix}": ${source.loaded ? "" : "not loaded: "}${source.error ?? "no reading yet"}`).join("; ") };
  }
}
