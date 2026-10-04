import type { HostedService, HostedServicePlanValidator } from "../extensions/hosted-service";

/** Internal bridge: DI knows plan composition, never a particular wrapper class. */
export interface HostedServicePlanAdmission {
  readonly phase: number;
  replace(candidate: HostedService, signal?: AbortSignal): Promise<void>;
}

interface HostedServiceWrapper {
  readonly explicitPhase?: number;
  prepare(): HostedService;
  bind(admission: HostedServicePlanAdmission): void;
}

const wrappers = new WeakMap<HostedService, HostedServiceWrapper>();
const owners = new WeakMap<HostedService, HostedServicePlan>();

export function registerHostedServiceWrapper(service: HostedService, wrapper: HostedServiceWrapper): void {
  wrappers.set(service, wrapper);
}

interface PlanNode {
  readonly service: HostedService;
  readonly phase: number;
  readonly wrapper?: HostedServiceWrapper;
  readonly child?: PlanNode;
}

export function prepareHostedServicePlan(services: readonly HostedService[], signal?: AbortSignal): void | Promise<void> {
  signal?.throwIfAborted();
  if (!services.some(service => wrappers.has(service) || service.planValidator !== undefined)) return;
  return new HostedServicePlan(services, signal).admit(signal);
}

/** One host run owns its concrete identities and serializes whole-plan replacements. */
class HostedServicePlan {
  private roots: readonly PlanNode[];
  private readonly phases: readonly number[];
  private replacement: Promise<void> = Promise.resolve();

  constructor(services: readonly HostedService[], signal?: AbortSignal) {
    this.roots = services.map(service => materialize(service, new Set(), signal));
    this.phases = this.roots.map(node => node.phase);
  }

  async admit(signal?: AbortSignal): Promise<void> {
    await this.validate(this.roots, signal);
    signal?.throwIfAborted();
    this.bind();
  }

  private replace(owner: HostedService, candidate: HostedService, signal?: AbortSignal): Promise<void> {
    const replacing = this.replacement.then(async () => {
      signal?.throwIfAborted();
      this.assertOwner(owner);
      const child = materialize(candidate, new Set([owner]), signal);
      const roots = this.roots.map(node => replaceChild(node, owner, child));
      if (roots.some((node, index) => node.phase !== this.phases[index])) {
        throw new Error("Hosted service retry cannot change the admitted startup phase.");
      }
      await this.validate(roots, signal);
      signal?.throwIfAborted();
      this.assertOwner(owner);
      // No await between the last admission check and publication.
      this.roots = roots;
      this.bind();
    });
    this.replacement = replacing.catch(() => {});
    return replacing;
  }

  private assertOwner(owner: HostedService): void {
    if (owners.get(owner) !== this || !nodesOf(this.roots).some(node => node.service === owner && node.wrapper)) {
      throw new Error("Hosted service retry belongs to an inactive plan wrapper.");
    }
  }

  private async validate(roots: readonly PlanNode[], signal?: AbortSignal): Promise<void> {
    const nodes = nodesOf(roots);
    const seen = new Set<HostedService>();
    for (const node of nodes) {
      if (seen.has(node.service)) throw new Error("Hosted service plan contains a duplicate service identity.");
      seen.add(node.service);
    }
    const plan = Object.freeze(roots.map(concrete));
    const validators = new Set<HostedServicePlanValidator>();
    for (const service of plan) if (service.planValidator !== undefined) validators.add(service.planValidator);
    if (validators.size > 0) {
      for (const node of nodes) {
        if (node.wrapper && node.phase !== (concrete(node).phase ?? 0)) {
          throw new Error("Supervised hosted phase conflicts with the concrete service phase required by plan validators.");
        }
      }
    }
    for (const validator of validators) {
      signal?.throwIfAborted();
      await awaitValidation(validator.validate(plan, signal), signal);
    }
    signal?.throwIfAborted();
  }

  private bind(): void {
    for (const node of nodesOf(this.roots)) {
      if (!node.wrapper) continue;
      owners.set(node.service, this);
      node.wrapper.bind({ phase: node.phase, replace: (candidate, signal) => this.replace(node.service, candidate, signal) });
    }
  }
}

function materialize(service: HostedService, ancestors: Set<HostedService>, signal?: AbortSignal): PlanNode {
  signal?.throwIfAborted();
  if (ancestors.has(service)) throw new Error("Hosted service wrapper factory cycle.");
  const wrapper = wrappers.get(service);
  if (!wrapper) return { service, phase: service.phase ?? 0 };
  ancestors.add(service);
  try {
    const child = materialize(wrapper.prepare(), ancestors, signal);
    return { service, wrapper, child, phase: wrapper.explicitPhase ?? child.phase };
  } finally {
    ancestors.delete(service);
  }
}

function concrete(node: PlanNode): HostedService {
  return node.child ? concrete(node.child) : node.service;
}

function nodesOf(roots: readonly PlanNode[]): PlanNode[] {
  const nodes: PlanNode[] = [];
  for (const root of roots) {
    for (let node: PlanNode | undefined = root; node !== undefined; node = node.child) nodes.push(node);
  }
  return nodes;
}

function replaceChild(node: PlanNode, owner: HostedService, replacement: PlanNode): PlanNode {
  if (!node.wrapper || !node.child) return node;
  const child = node.service === owner ? replacement : replaceChild(node.child, owner, replacement);
  return child === node.child ? node : { ...node, child, phase: node.wrapper.explicitPhase ?? child.phase };
}

async function awaitValidation(value: void | Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return await value;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
