import { DiError } from "../di";
import { Kernel } from "./Kernel";
import { KernelBuilder, type RootModuleInput } from "./KernelBuilder";
import { KernelError, ShutdownTimeoutError } from "./errors";
import type { KernelOptions } from "./types";
import { redactSensitiveText } from "../../library/redaction";
import { formatStartupFailure } from "./startupFailure";

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
    configure?.(builder);

    let kernel: Kernel;
    try {
      kernel = await builder.build();
    } catch (error) {
      if (error instanceof DiError || error instanceof KernelError) {
        console.error(`[bazis] configuration error: ${redactSensitiveText(error.message)}`);
        process.exitCode = 1;
        return 1;
      }
      throw error;
    }

    try {
      const exitCode = await kernel.run();
      process.exitCode = exitCode;
      return exitCode;
    } catch (error) {
      if (error instanceof ShutdownTimeoutError) {
        // Graceful shutdown is stuck: hanging handles would keep the process
        // alive forever, so this is the one place a hard exit is correct.
        console.error(`[bazis] ${redactSensitiveText(error.message)} Forcing exit.`);
        process.exit(1);
      }
      // Configuration problems surfacing at start (e.g. options fail-fast)
      // deserve the same friendly output as build-time ones.
      if (error instanceof DiError || error instanceof KernelError) {
        console.error(`[bazis] configuration error: ${redactSensitiveText(error.message)}`);
      } else {
        console.error(`[bazis] application failed: ${formatStartupFailure(error)}`);
      }
      process.exitCode = 1;
      return 1;
    }
  }
}
