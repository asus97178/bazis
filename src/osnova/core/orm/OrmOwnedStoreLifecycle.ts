import { ormHostedPlanValidator } from "./OrmHostedPlan.validator";
import type { HostedService } from "../di";
import type { DatabaseProvider } from "../../library/orm";
import { admitOwnedStoresV1, discardOwnedStoreAdmissionV1, publishOwnedStoreAdmissionV1, type OwnedStoreLeaseV1 } from "../../library/orm/Schema/OwnedStoreAdmission";
import { OrmOwnedStoreAdmissionError } from "../../library/orm";
import type { OwnedStoreRegistration } from "./ownedStoreContributions";
import { preparedOwnedStoreRegistration } from "./ownedStoreContributions";

const plans = new WeakMap<object, OrmOwnedStoreLifecycle>();

export interface OwnedStorePlanHealth { check(): Promise<{ healthy: boolean; details?: string }>; }

/** Container-local owner of the receipt and leases. It never owns the provider. */
export class OrmOwnedStoreLifecycle implements HostedService {
  readonly planValidator = ormHostedPlanValidator;
  public readonly phase = -105;
  public readonly __osnovaOrmOwnedStoreAdmission = true;
  private state: "idle" | "starting" | "ready" | "failed" | "closing" | "stopped" = "idle";
  private startPromise?: Promise<void>;
  private readonly controller = new AbortController();
  private leases: readonly OwnedStoreLeaseV1[] = Object.freeze([]);

  public constructor(private readonly provider: DatabaseProvider, private readonly registrations: readonly OwnedStoreRegistration[]) {}

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "stopped" || this.state === "closing") throw new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_LOCK_UNAVAILABLE", "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    this.startPromise ??= this.admit(signal);
    return this.startPromise;
  }

  public async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") return;
    this.state = "closing";
    this.controller.abort();
    try { await this.startPromise; } catch { /* a failed admission owns no lease */ }
    for (const lease of this.leases) lease.revoke();
    this.leases = Object.freeze([]);
    this.state = "stopped";
  }

  public readonly health: OwnedStorePlanHealth = Object.freeze({
    check: async () => this.state === "ready" && this.leases.length === this.registrations.length && this.leases.every((lease) => lease.active)
      ? { healthy: true }
      : { healthy: false, details: "ORM_OWNED_STORE_NOT_READY" },
  });

  private async admit(external: AbortSignal | undefined): Promise<void> {
    this.state = "starting";
    const signal = combineSignals(this.controller.signal, external);
    try {
      if (signal.aborted) throw unavailable();
      const receipt = await admitOwnedStoresV1(this.provider, { stores: this.registrations.map(preparedOwnedStoreRegistration), signal });
      if (signal.aborted || this.controller.signal.aborted) {
        discardOwnedStoreAdmissionV1(receipt);
        throw unavailable();
      }
      // Publication and ready are deliberately adjacent: no await can leave a
      // committed receipt visible to an aborted graph.
      const leases = publishOwnedStoreAdmissionV1(this.provider, receipt);
      if (signal.aborted || this.controller.signal.aborted) {
        for (const lease of leases) lease.revoke();
        throw unavailable();
      }
      this.leases = leases;
      this.state = "ready";
    } catch (error) {
      if (!this.controller.signal.aborted) this.state = "failed";
      throw error;
    }
  }
}

/** One container owns one whole-graph admission plan, regardless of module count. */
export function ownedStoreLifecycleFor(container: object, provider: DatabaseProvider, registrations: readonly OwnedStoreRegistration[]): OrmOwnedStoreLifecycle {
  let plan = plans.get(container);
  if (!plan) { plan = new OrmOwnedStoreLifecycle(provider, registrations); plans.set(container, plan); }
  return plan;
}

/** Health must not activate a provider merely to observe a plan that has not started. */
export function ownedStoreLifecycleHealthFor(container: object): OwnedStorePlanHealth | undefined {
  return plans.get(container)?.health;
}

function unavailable(): OrmOwnedStoreAdmissionError { return new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_LOCK_UNAVAILABLE", "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); }

function combineSignals(local: AbortSignal, external: AbortSignal | undefined): AbortSignal {
  if (!external) return local;
  if (local.aborted || external.aborted) { const controller = new AbortController(); controller.abort(); return controller.signal; }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  local.addEventListener("abort", abort, { once: true });
  external.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
