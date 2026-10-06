import {
  createModuleOwnedProviderChannel,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  scoped,
  type Class,
  type DiContainer,
  type ModuleOwnedContributionSnapshot,
  type ModuleOwnedProviderContribution,
  type BazisModuleMetadata,
  type BazisModuleRef,
} from "../di";
import { AgentSetupError } from "./errors";
import { toolMetadataOf } from "./metadata";
import type { AgentToolHookRegistrationV1 } from "./AgentToolHooks";

export interface AgentOwnedToolContributionV1 { readonly target: Class<object>; readonly owner: BazisModuleRef; }
export interface AgentOwnedHookContributionV1 { readonly registration: AgentToolHookRegistrationV1; readonly owner: BazisModuleRef; }
export type AgentOwnedToolRegistrationV1 = ModuleOwnedProviderContribution<AgentOwnedToolContributionV1, object>;
export type AgentOwnedHookRegistrationV1 = ModuleOwnedProviderContribution<AgentOwnedHookContributionV1, object>;

const TOOL_CHANNEL = createModuleOwnedProviderChannel<AgentOwnedToolContributionV1, object>("agent.tool/v1");
const HOOK_CHANNEL = createModuleOwnedProviderChannel<AgentOwnedHookContributionV1, object>("agent.tool-hook/v1");

// Internal imports (including generatedRuntime's type-only AgentRegistry import)
// must not depend on the public barrel having augmented DI's metadata interface.
interface AgentModuleFields {
  readonly tools?: readonly Class<object>[];
  readonly agentToolHooks?: readonly AgentToolHookRegistrationV1[];
}

function classValues(value: unknown, field: string): readonly Class<object>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "function")) {
    throw new AgentSetupError(`${field} must be an array of classes.`);
  }
  return value as readonly Class<object>[];
}

export function assertAgentToolHookIdV1(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[\x20-\x7e]{1,128}$/.test(id)) {
    throw new AgentSetupError("Agent Tool hook id must contain 1 to 128 printable ASCII characters.");
  }
}

function assertHook(registration: AgentToolHookRegistrationV1): void {
  if (registration.kind !== "enforcement" && registration.kind !== "settlement" && registration.kind !== "observer") throw new AgentSetupError("Agent Tool hook kind is invalid.");
  assertAgentToolHookIdV1(registration.id);
  if (!Number.isSafeInteger(registration.version) || registration.version <= 0) throw new AgentSetupError(`Agent Tool hook "${registration.id}" version must be a positive safe integer.`);
  if (registration.order !== undefined && !Number.isSafeInteger(registration.order)) throw new AgentSetupError(`Agent Tool hook "${registration.id}" order must be a safe integer.`);
  if (registration.timeoutMs !== undefined && (!Number.isSafeInteger(registration.timeoutMs) || registration.timeoutMs <= 0)) throw new AgentSetupError(`Agent Tool hook "${registration.id}" timeoutMs must be a positive safe integer.`);
  if (typeof registration.handler !== "function") throw new AgentSetupError(`Agent Tool hook "${registration.id}" handler must be a class.`);
  const method = registration.kind === "enforcement" ? "enforce" : registration.kind === "settlement" ? "settle" : "observe";
  if (typeof (registration.handler as { prototype?: Record<string, unknown> }).prototype?.[method] !== "function") {
    throw new AgentSetupError(`Agent Tool hook "${registration.id}" handler must expose ${method}(...).`);
  }
}

registerModuleOwnedProviderContributor((metadata: BazisModuleMetadata, context) => {
  const owner = metadata as BazisModuleRef;
  const fields = metadata as BazisModuleMetadata & AgentModuleFields;
  for (const target of classValues(fields.tools, "tools")) {
    if (!toolMetadataOf(target)) throw new AgentSetupError(`${target.name || "<anonymous class>"} is listed as a tool but is not decorated with @Tool(...).`);
    try {
      context.registerScoped(TOOL_CHANNEL, scoped(target), Object.freeze({ target, owner }));
    } catch (error) {
      throw new AgentSetupError(error instanceof Error ? error.message : "Agent Tool provider ownership is invalid.");
    }
  }
  if (fields.agentToolHooks === undefined) return;
  if (!Array.isArray(fields.agentToolHooks)) throw new AgentSetupError("agentToolHooks must be an array.");
  for (const registration of fields.agentToolHooks) {
    assertHook(registration);
    context.addScoped(HOOK_CHANNEL, scoped(registration.handler), Object.freeze({ registration, owner }));
  }
});

registerModuleOwnedContributionValidator((snapshot: ModuleOwnedContributionSnapshot) => {
  const toolNames = new Set<string>();
  for (const contribution of snapshot.getProviderContributions(TOOL_CHANNEL)) {
    const name = toolMetadataOf(contribution.payload.target)!.name;
    if (toolNames.has(name)) throw new AgentSetupError(`Duplicate Tool registration "${name}".`);
    toolNames.add(name);
  }
  const seen = new Set<string>();
  const versions = new Map<string, number>();
  for (const contribution of snapshot.getProviderContributions(HOOK_CHANNEL)) {
    const registration = contribution.payload.registration;
    const identity = `${registration.kind}:${registration.id}:${registration.version}`;
    if (seen.has(identity)) throw new AgentSetupError(`Duplicate Agent Tool hook identity "${identity}".`);
    seen.add(identity);
    const versionKey = `${registration.kind}:${registration.id}`;
    const existingVersion = versions.get(versionKey);
    if (existingVersion !== undefined && existingVersion !== registration.version) throw new AgentSetupError(`Agent Tool hook "${versionKey}" has incompatible active versions.`);
    versions.set(versionKey, registration.version);
  }
});

export interface AgentModuleContributionSnapshotV1 {
  readonly tools: readonly AgentOwnedToolRegistrationV1[];
  readonly hooks: readonly AgentOwnedHookRegistrationV1[];
}
const snapshots = new WeakMap<DiContainer, AgentModuleContributionSnapshotV1>();
export function getAgentModuleContributionsV1(container: DiContainer): AgentModuleContributionSnapshotV1 {
  const existing = snapshots.get(container);
  if (existing) return existing;
  const snapshot = Object.freeze({
    tools: Object.freeze([...container.getModuleOwnedProviderContributions(TOOL_CHANNEL)]),
    hooks: Object.freeze([...container.getModuleOwnedProviderContributions(HOOK_CHANNEL)]),
  });
  snapshots.set(container, snapshot);
  return snapshot;
}
