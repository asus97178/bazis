import type { ServiceCollection } from "../ServiceCollection";
import { createToken } from "../token";
import { prepareHostedServicePlan } from "../internal/HostedServicePlan";
// Framework-only composition hook; not part of the DI root barrel.
export { registerHostedServiceWrapper, type HostedServicePlanAdmission } from "../internal/HostedServicePlan";

/**
 * Pure, repeatable configuration checks, once by identity per plan version.
 * Initial admission precedes every hook/start; a retry replacement validates
 * the full new plan again, which may include already-started services.
 */
export interface HostedServicePlanValidator {
  validate(services: readonly HostedService[], signal?: AbortSignal): void | Promise<void>;
}

export interface HostedService {
  /** Shared validators see real service identities, including inside supervised wrappers. */
  readonly planValidator?: HostedServicePlanValidator;
  start(signal?: AbortSignal): void | Promise<void>;
  stop(): void | Promise<void>;
  /**
   * Startup phase (Spring SmartLifecycle): lower phases start first, stop
   * last. Services without a phase belong to phase 0. The kernel starts
   * phases in ascending order and stops everything in reverse start order.
   */
  readonly phase?: number;
}

export const HOSTED_SERVICE = createToken<HostedService>("IHostedService");

interface HostedServiceResolver {
  resolveAll(token: typeof HOSTED_SERVICE): readonly HostedService[];
}

interface HostedServiceRun {
  readonly started: HostedService[];
  starting?: Promise<void>;
  stopping?: Promise<void>;
  stopped: boolean;
}

// A resolver owns one helper-managed run. Retaining its actual instances keeps
// transient registrations safe without changing their public DI lifetime.
const hostedRuns = new WeakMap<HostedServiceResolver, HostedServiceRun>();

/**
 * Hosted services in registration order, each instance once. Several
 * registrations may legitimately resolve one singleton (for example the shared
 * owned-store admission plan of every `ownedStore` context); it is one service
 * and starts/stops once. Distinct supervised wrappers that materialize one
 * concrete service are still rejected by plan validation.
 */
export function resolveHostedServices(services: HostedServiceResolver): readonly HostedService[] {
  return [...new Set(services.resolveAll(HOSTED_SERVICE))];
}

/** Shared by the kernel and the lightweight host; validators never start services. */
export function validateHostedServicePlan(services: readonly HostedService[], signal?: AbortSignal): void | Promise<void> {
  return prepareHostedServicePlan(services, signal);
}

export async function startHostedServices(services: HostedServiceResolver): Promise<void> {
  const previous = hostedRuns.get(services);
  if (previous?.stopping && !previous.stopped) {
    await previous.stopping;
    return startHostedServices(services);
  }
  if (previous?.starting && !previous.stopped) return previous.starting;

  const run: HostedServiceRun = { started: [], stopped: false };
  hostedRuns.set(services, run);
  // Publish the run before entering user callbacks, including a concurrent stop.
  run.starting = Promise.resolve().then(async () => {
    const hosted = resolveHostedServices(services);
    const validation = validateHostedServicePlan(hosted);
    if (validation) await validation;
    for (const service of hosted) {
      // A failed start may already own resources that the paired stop must release.
      run.started.push(service);
      await service.start();
    }
  });
  return run.starting;
}

export async function stopHostedServices(services: HostedServiceResolver): Promise<void> {
  let run = hostedRuns.get(services);
  if (!run) {
    run = { started: [], stopped: false };
    hostedRuns.set(services, run);
  }
  if (!run.stopping) {
    const current = run;
    current.stopping = Promise.resolve().then(async () => {
      if (current.starting) {
        // Startup reports its own error; stop also cleans up a partially started service.
        await current.starting.catch(() => undefined);
      } else {
        // Keep the existing standalone stop helper for manually started services.
        current.started.push(...resolveHostedServices(services));
      }
      const errors: unknown[] = [];
      for (let index = current.started.length - 1; index >= 0; index -= 1) {
        try {
          await (current.started[index] as HostedService).stop();
        } catch (error) {
          errors.push(error);
        }
      }
      current.started.length = 0;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Hosted service shutdown finished with errors.");
    }).finally(() => { current.stopped = true; });
  }
  return run.stopping;
}

export function addHostedService(services: ServiceCollection, factory: () => HostedService): void {
  services.addTransient({
    provide: HOSTED_SERVICE,
    useFactory: factory,
    deps: [],
  });
}
