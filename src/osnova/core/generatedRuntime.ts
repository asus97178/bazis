import path from "node:path";
import type { AgentMetadataIndex } from "./agent/AgentRegistry";
import { registerGeneratedClassDeps, restoreGeneratedClassDeps, snapshotGeneratedClassDeps, type GeneratedClassDependency } from "./di/module/autoDeps";
import { registerGeneratedBindings, restoreGeneratedBindings, snapshotGeneratedBindings } from "./http/Binding/autoBindings";
import { registerRequestModelShape, restoreRequestModelRegistry, snapshotRequestModelRegistry, type RequestModelClass, type RequestModelShape } from "./http/Binding/requestModelRegistry";
import { registerListModelClass, restoreListModelRegistry, snapshotListModelRegistry, type ListModelClass } from "./http/Binding/listModelRegistry";
import { registerGeneratedOpenApiMetadata, registerGeneratedOpenApiSchemaModel, restoreGeneratedOpenApiRegistry, snapshotGeneratedOpenApiRegistry, type GeneratedOpenApiSchemaModel } from "./http/OpenApi/generatedOpenApiRegistry";
import type { Class } from "./di";
import type { GeneratedBindingSpec } from "./http/Binding/generatedSpec";
import type { GeneratedOpenApiMetadata } from "../library/openapi";
import {
  commitGeneratedProviderAttachments,
  prepareGeneratedProviderAttachments,
  restoreGeneratedProviderAttachments,
  snapshotGeneratedProviderAttachments,
  type GeneratedProviderAttachmentV1,
} from "./di/module/generatedProviderAttachments";
export type { GeneratedProviderAttachmentV1 } from "./di/module/generatedProviderAttachments";
export { warnIfGeneratedSourcesChanged, type GeneratedSourceFingerprint } from "./generatedFingerprint";
export {
  createGeneratedProviderAttachmentChannel,
  getGeneratedProviderAttachment,
  type GeneratedProviderAttachmentChannel,
} from "./di/module/generatedProviderAttachments";

type GeneratedRuntimeModule = {
  readonly registerOsnovaGeneratedRuntime?: () => void | Promise<void>;
};

type GeneratedAgentCatalogModule = {
  readonly GENERATED_AGENT_METADATA?: AgentMetadataIndex;
};

let runtimeLoad: Promise<void> | undefined;

export interface OsnovaGeneratedTargetDescriptor {
  readonly id: string;
  readonly classDeps: readonly (readonly [Class<unknown>, readonly GeneratedClassDependency[]])[];
  readonly bindings: readonly (readonly [Class<object>, Readonly<Record<string, readonly GeneratedBindingSpec[]>>])[];
  readonly requestModels: readonly RequestModelClass[];
  readonly requestShapes: readonly (readonly [RequestModelClass, RequestModelShape])[];
  readonly listModels: readonly ListModelClass[];
  readonly openApi: GeneratedOpenApiMetadata;
  readonly openApiSchemaModels: readonly (readonly [GeneratedOpenApiSchemaModel, string])[];
  /** Target-local generated Agent/Tool/Prompt metadata. */
  readonly agentMetadata?: AgentMetadataIndex;
  /** Package-internal exact-class metadata attached atomically with this target. */
  readonly providerAttachments?: readonly GeneratedProviderAttachmentV1[];
}

const committedTargetDescriptors = new Set<string>();
const targetDescriptorLoads = new Map<string, Promise<void>>();
const committedTargetDescriptorsById = new Map<string, OsnovaGeneratedTargetDescriptor>();
const explicitlyActivatedTargetIds = new Set<string>();

/**
 * Internal atomic publication boundary for one complete generated target.
 * Generated modules only export immutable data; validation happens before any
 * owner registry receives a mutation. Repeated and concurrent activation is
 * target-idempotent.
 */
export function registerOsnovaGeneratedTargetDescriptor(descriptor: OsnovaGeneratedTargetDescriptor): Promise<void> {
  const existing = targetDescriptorLoads.get(descriptor.id);
  if (existing !== undefined) return existing;
  const load = Promise.resolve().then(() => {
    validateDescriptor(descriptor);
    if (committedTargetDescriptors.has(descriptor.id)) return;
    const preparedAttachments = prepareGeneratedProviderAttachments(descriptor.providerAttachments);
    const snapshots = {
      classDeps: snapshotGeneratedClassDeps(),
      bindings: snapshotGeneratedBindings(),
      requestModels: snapshotRequestModelRegistry(),
      listModels: snapshotListModelRegistry(),
      openApi: snapshotGeneratedOpenApiRegistry(),
      providerAttachments: snapshotGeneratedProviderAttachments(),
    };
    try {
      for (const [target, deps] of descriptor.classDeps) registerGeneratedClassDeps(target, deps);
      const modelIndex = new Map<string, Class<object>>();
      for (const model of [...descriptor.requestModels, ...descriptor.listModels]) {
        if (model.name) modelIndex.set(model.name, model);
      }
      for (const [target, bindings] of descriptor.bindings) registerGeneratedBindings(target, bindings, modelIndex);
      for (const [model, shape] of descriptor.requestShapes) registerRequestModelShape(model, shape);
      for (const model of descriptor.listModels) registerListModelClass(model);
      registerGeneratedOpenApiMetadata(descriptor.openApi, descriptor.bindings.map(([controller]) => controller));
      for (const [model, name] of descriptor.openApiSchemaModels) registerGeneratedOpenApiSchemaModel(model, name);
      commitGeneratedProviderAttachments(preparedAttachments);
      committedTargetDescriptors.add(descriptor.id);
      committedTargetDescriptorsById.set(descriptor.id, descriptor);
      explicitlyActivatedTargetIds.add(descriptor.id);
    } catch (error) {
      restoreGeneratedClassDeps(snapshots.classDeps);
      restoreGeneratedBindings(snapshots.bindings);
      restoreRequestModelRegistry(snapshots.requestModels);
      restoreListModelRegistry(snapshots.listModels);
      restoreGeneratedOpenApiRegistry(snapshots.openApi);
      restoreGeneratedProviderAttachments(snapshots.providerAttachments);
      throw error;
    }
  });
  targetDescriptorLoads.set(descriptor.id, load);
  void load.catch(() => targetDescriptorLoads.delete(descriptor.id));
  return load;
}

function validateDescriptor(descriptor: OsnovaGeneratedTargetDescriptor): void {
  if (!/^[a-z][a-z0-9-]*$/.test(descriptor.id)) throw new TypeError("Invalid generated target descriptor id.");
  const dependencyTargets = new Set<object>();
  for (const [target, deps] of descriptor.classDeps) {
    if (typeof target !== "function" || !Array.isArray(deps) || dependencyTargets.has(target)) throw new TypeError(`Invalid generated DI descriptor for ${descriptor.id}.`);
    dependencyTargets.add(target);
  }
  const bindingTargets = new Set<object>();
  for (const [target, bindings] of descriptor.bindings) {
    if (typeof target !== "function" || bindings === null || typeof bindings !== "object" || bindingTargets.has(target)) throw new TypeError(`Invalid generated HTTP descriptor for ${descriptor.id}.`);
    bindingTargets.add(target);
  }
  for (const model of [...descriptor.requestModels, ...descriptor.listModels]) if (typeof model !== "function") throw new TypeError(`Invalid generated model descriptor for ${descriptor.id}.`);
  for (const [model, name] of descriptor.openApiSchemaModels) if (typeof model !== "function" || name.trim().length === 0) throw new TypeError(`Invalid generated OpenAPI descriptor for ${descriptor.id}.`);
  if (descriptor.providerAttachments !== undefined && !Array.isArray(descriptor.providerAttachments)) throw new TypeError(`Invalid generated provider attachment descriptor for ${descriptor.id}.`);
}

/**
 * Loads project-owned generated runtime registrations, when present.
 *
 * The framework core stays independent from `src/app`: generated
 * files live under `src/generated/osnv` and register request/list models,
 * OpenAPI metadata and similar app-owned artifacts through public registries.
 */
export function loadOsnovaGeneratedRuntime(): Promise<void> {
  // A project-local target bootstrap is authoritative for this process.  Do
  // not even import the default generated graph after it was selected.
  if (explicitlyActivatedTargetIds.size > 0) return Promise.resolve();
  runtimeLoad ??= loadRuntimeOnce();
  return runtimeLoad;
}

export async function loadOsnovaGeneratedAgentMetadata(
  targets: readonly Class<object>[] = [],
): Promise<AgentMetadataIndex | undefined> {
  const registered = selectRegisteredAgentMetadata(targets);
  if (registered !== undefined || explicitlyActivatedTargetIds.size > 0) return registered;
  const module = await importGeneratedModule<GeneratedAgentCatalogModule>("agentCatalog");
  return module?.GENERATED_AGENT_METADATA;
}

function selectRegisteredAgentMetadata(targets: readonly Class<object>[]): AgentMetadataIndex | undefined {
  const candidates = [...committedTargetDescriptorsById.values()]
    .map((descriptor) => descriptor.agentMetadata)
    .filter((metadata): metadata is AgentMetadataIndex => metadata !== undefined);
  if (candidates.length === 0) return undefined;
  for (const metadata of candidates) {
    for (const target of targets) {
      if (metadata.agents.has(target) || metadata.tools.has(target) || metadata.prompts.has(target)) return metadata;
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function loadRuntimeOnce(): Promise<void> {
  const module = await importGeneratedModule<GeneratedRuntimeModule>("runtime");
  await module?.registerOsnovaGeneratedRuntime?.();
}

/**
 * The project's generated module `name`, or undefined when it does not exist.
 * Framework sources inside the project (`src/osnova`) find `src/generated`
 * next to them; an installed package (`node_modules/osnv`) cannot, so the
 * project root is the working directory, as for `osnv dev` and `osnv test`.
 */
async function importGeneratedModule<T>(name: string): Promise<T | undefined> {
  const candidates = [`../../generated/osnv/${name}`, path.join(process.cwd(), "src/generated/osnv", name)];
  for (const candidate of candidates) {
    try {
      return (await import(candidate)) as T;
    } catch (error) {
      if (!isOptionalGeneratedModuleMissing(error, `generated/osnv/${name}`)) throw error;
    }
  }
  return undefined;
}

function isOptionalGeneratedModuleMissing(error: unknown, generatedPath: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cannot find module") && message.includes(generatedPath);
}
