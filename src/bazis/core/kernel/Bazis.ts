import { DiError } from "../di";
import { Kernel } from "./Kernel";
import { KernelBuilder, type RootModuleInput } from "./KernelBuilder";
import { KernelError, ShutdownTimeoutError } from "./errors";
import type { KernelOptions } from "./types";
import { redactSensitiveText } from "../../library/redaction";
import { formatStartupFailure } from "./startupFailure";
import { StartupScreen, startupScreenEnabled } from "./report/StartupScreen";

/**
 * Entry-point facade.
 *
 * One-liner: `await Bazis.run(AppModule)`.
 * Fine-grained control: `Bazis.createBuilder(AppModule)` -> configure -> `build()` -> `run()`.
 */
export class Bazis {
  public static createBuilder(rootModule: RootModuleInput): KernelBuilder {
    return new KernelBuilder(rootModule);
  }

  /**
   * Builds and runs the application until a shutdown trigger. Configuration
   * errors (DI graph, options, environment) are reported to stderr and turn
   * into exit code 1 instead of an unhandled stack trace.
   */
  public static async run(
    rootModule: RootModuleInput,
    options?: KernelOptions,
    configure?: (builder: KernelBuilder) => void,
  ): Promise<number> {
    const builder = new KernelBuilder(rootModule);
    if (options) {
      builder.useOptions(options);
    }
    // On a terminal the start is a screen: what started, or what failed and why.
    const screen = startupScreenEnabled() ? new StartupScreen() : undefined;
    let stopWaiting: (() => void) | undefined;
    if (screen !== undefined && options?.startupReport !== false) {
      builder.useStartupScreen((started) => {
        stopWaiting?.();
        screen.started(started);
      });
    }
    configure?.(builder);

    let kernel: Kernel;
    try {
      kernel = await builder.build();
    } catch (error) {
      return reportBuildFailure(error, screen, builder.report);
    }

    try {
      if (kernel.report.screen) stopWaiting = screen?.waiting(kernel);
      const exitCode = await kernel.run();
      stopWaiting?.();
      process.exitCode = exitCode;
      return exitCode;
    } catch (error) {
      stopWaiting?.();
      if (error instanceof ShutdownTimeoutError) {
        // A failed start whose cleanup is stuck: report why the start failed
        // first, otherwise only the cleanup timeout would be visible.
        const startFailure = error.cause;
        if (startFailure !== undefined) {
          if (screen !== undefined) screen.failed(startFailure, kernel);
          else console.error(`[bazis] application failed: ${formatStartupFailure(startFailure)}`);
        }
        // Graceful shutdown is stuck: hanging handles would keep the process
        // alive forever, so this is the one place a hard exit is correct.
        const text = startFailure === undefined ? error.message : `Cleanup after the failed start did not finish within ${error.timeoutMs}ms.`;
        console.error(`[bazis] ${redactSensitiveText(text)} Forcing exit.`);
        process.exit(1);
      }
      // Configuration problems surfacing at start (e.g. options fail-fast)
      // deserve the same friendly output as build-time ones.
      if (screen !== undefined) {
        screen.failed(error, kernel);
      } else if (error instanceof DiError || error instanceof KernelError) {
        console.error(`[bazis] configuration error: ${redactSensitiveText(error.message)}`);
      } else {
        console.error(`[bazis] application failed: ${formatStartupFailure(error)}`);
      }
      process.exitCode = 1;
      return 1;
    }
  }
}

/**
 * @internal How a start that failed before the kernel was built is reported:
 * the startup screen on a terminal, otherwise one `[bazis] configuration error`
 * line for DI and kernel errors. Returns exit code 1; anything else is rethrown.
 * `runApp` uses it for errors found while it composes the application.
 */
export function reportBuildFailure(
  error: unknown,
  screen: StartupScreen | undefined = startupScreenEnabled() ? new StartupScreen() : undefined,
  report?: KernelBuilder["report"],
): number {
  if (screen !== undefined && !(error instanceof ShutdownTimeoutError)) {
    screen.failed(error, undefined, report);
    process.exitCode = 1;
    return 1;
  }
  if (error instanceof DiError || error instanceof KernelError) {
    console.error(`[bazis] configuration error: ${redactSensitiveText(error.message)}`);
    process.exitCode = 1;
    return 1;
  }
  throw error;
}
