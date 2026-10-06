import type { EnvironmentName } from "./EnvironmentName";

/** What the kernel does with unhandledRejection / uncaughtException. */
export type UnhandledErrorPolicy = "shutdown" | "none";

export interface KernelOptions {
  /** Overrides BAZIS_ENV / NODE_ENV detection. */
  readonly environment?: EnvironmentName;
  /** Overrides the debug flag (default: true everywhere except production). */
  readonly debug?: boolean;
  /** Graceful shutdown budget: integer 0..2147483647ms. Default: 10000ms; 0 disables the limit. */
  readonly shutdownTimeoutMs?: number;
  /** Whole startup budget, including notifications: integer 0..2147483647ms. Default: 30000ms; 0 disables the limit. */
  readonly startupTimeoutMs?: number;
  /** Signals that trigger graceful shutdown. Default: SIGINT, SIGTERM. The built kernel snapshots unique values. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Default: "shutdown" — an unhandled error triggers graceful stop with exit code 1. */
  readonly unhandledErrorPolicy?: UnhandledErrorPolicy;
  /** Default: true — the DI graph is fully validated at build. */
  readonly validateOnBuild?: boolean;
  /** Startup report in the console. Default: only outside production. */
  readonly startupReport?: boolean;
}
