import type { Token } from "../token";
import { resolveHostedServices, validateHostedServicePlan, type HostedService } from "./hosted-service";
import { validateOptionsOnStart } from "./options";

interface ApplicationHost {
  resolveAll<T>(token: Token<T>): readonly T[];
  dispose(): Promise<void>;
}

export interface RunApplicationOptions {
  /** Signals that trigger graceful shutdown. Default: SIGINT, SIGTERM. */
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Lifecycle wrapper over the DI container:
 * - `Application.start` resolves and starts all hosted services in registration order;
 * - `stop` stops them in reverse order and disposes the container.
 *
 * Fault tolerance: a failed start rolls back already-started services; a failed
 * stop continues stopping the rest and reports all errors at the end.
 */
export class Application {
  private stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly host: ApplicationHost,
    private readonly hosted: readonly HostedService[],
  ) {}

  public static async start(host: ApplicationHost): Promise<Application> {
    const started: HostedService[] = [];
    let hosted: readonly HostedService[];
    try {
      // Validate before starting services; all startup failures share cleanup
      // so disposal errors cannot replace the original failure.
      validateOptionsOnStart(host);
      hosted = resolveHostedServices(host);
      const validation = validateHostedServicePlan(hosted);
      if (validation) await validation;
      for (let index = 0; index < hosted.length; index += 1) {
        const service = hosted[index] as HostedService;
        await service.start();
        started.push(service);
      }
    } catch (error) {
      await stopInReverse(started, []);
      try {
        await host.dispose();
      } catch {
        // Startup's construction/start failure remains the primary error.
      }
      throw error;
    }
    return new Application(host, hosted);
  }

  public stop(): Promise<void> {
    if (!this.stopPromise) {
      // Publish before invoking user cleanup, including a reentrant stop().
      this.stopPromise = Promise.resolve().then(() => this.stopCore());
    }
    return this.stopPromise;
  }

  private async stopCore(): Promise<void> {
    const errors: unknown[] = [];
    await stopInReverse(this.hosted, errors);
    try {
      await this.host.dispose();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Application shutdown finished with errors.");
    }
  }
}

/** Starts the application and blocks until a shutdown signal, then stops gracefully. */
export async function runApplication(host: ApplicationHost, options?: RunApplicationOptions): Promise<void> {
  const app = await Application.start(host);
  const signals = options?.signals ?? ["SIGINT", "SIGTERM"];

  const handlers: Array<{ readonly signal: NodeJS.Signals; readonly handler: () => void }> = [];
  try {
    await new Promise<void>((resolve) => {
      for (let index = 0; index < signals.length; index += 1) {
        const signal = signals[index] as NodeJS.Signals;
        const handler = (): void => resolve();
        handlers.push({ signal, handler });
        process.once(signal, handler);
      }
    });
  } finally {
    for (let index = 0; index < handlers.length; index += 1) {
      const entry = handlers[index]!;
      process.off(entry.signal, entry.handler);
    }
  }

  await app.stop();
}

async function stopInReverse(services: readonly HostedService[], errors: unknown[]): Promise<void> {
  for (let index = services.length - 1; index >= 0; index -= 1) {
    try {
      await (services[index] as HostedService).stop();
    } catch (error) {
      errors.push(error);
    }
  }
}
