/** Fixed text avoids exposing arbitrary observer errors, secrets or user inspection hooks. */
export function reportDiagnosticFailure(component: "supervised.onRetry" | "startup.cleanup"): void {
  try {
    void Promise.resolve(console.error(`[bazis] ${component} failed.`)).catch(() => undefined);
  } catch {
    // A broken diagnostic sink cannot change the owning operation's outcome.
  }
}
