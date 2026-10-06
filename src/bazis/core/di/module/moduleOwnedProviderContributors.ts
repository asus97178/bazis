import { ModuleOwnedProviderConflictError } from "../errors";
import type { ServiceCollection } from "../ServiceCollection";
import {
  isClassProvider,
  ProviderDefinition,
} from "../provider";
import type { Class, Token } from "../token";
import type { ServiceKey, ServiceResolver } from "../types";
import type { BazisModuleMetadata } from "./types";

declare const MODULE_OWNED_CHANNEL_PAYLOAD: unique symbol;
declare const MODULE_OWNED_CHANNEL_SERVICE: unique symbol;

interface ModuleOwnedContributionChannelBase<TPayload> {
  /** Diagnostic-only name. Channel lookup uses this object's identity. */
  readonly description: string;
  readonly [MODULE_OWNED_CHANNEL_PAYLOAD]?: (payload: TPayload) => TPayload;
}

/** Opaque per-container channel for owner-bound scoped providers. */
export interface ModuleOwnedProviderChannel<TPayload, TService>
  extends ModuleOwnedContributionChannelBase<TPayload> {
  readonly kind: "provider";
  readonly [MODULE_OWNED_CHANNEL_SERVICE]?: (service: TService) => TService;
}

/** Opaque per-container channel for owner-attributed metadata without a provider. */
export interface ModuleOwnedMetadataChannel<TPayload>
  extends ModuleOwnedContributionChannelBase<TPayload> {
  readonly kind: "metadata";
}

export type ModuleOwnedContributionChannel<TPayload, TService = never> =
  | ModuleOwnedProviderChannel<TPayload, TService>
  | ModuleOwnedMetadataChannel<TPayload>;

/**
 * Resolves exactly the provider registration created for one contribution.
 * Its private keyed identity is deliberately not exposed.
 */
export interface ModuleOwnedProviderActivation<TService> {
  activate(resolver: ServiceResolver): TService;
  activateAsync(resolver: ServiceResolver): Promise<TService>;
}

export interface ModuleOwnedProviderContribution<TPayload, TService> {
  readonly kind: "provider";
  readonly ownerName: string;
  readonly payload: TPayload;
  readonly activation: ModuleOwnedProviderActivation<TService>;
}

export interface ModuleOwnedMetadataContribution<TPayload> {
  readonly kind: "metadata";
  readonly ownerName: string;
  readonly payload: TPayload;
}

export interface ModuleOwnedProviderContributionContext {
  /** Creates an ordinary scoped self-class provider when absent, otherwise attaches to its exact owner registration. */
  registerScoped<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
    definition: ProviderDefinition<TService>,
    payload: TPayload,
  ): ModuleOwnedProviderActivation<TService>;

  /**
   * Adds an unkeyed scoped class definition under a fresh private key and
   * attributes it to the module currently being loaded.
   */
  addScoped<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
    definition: ProviderDefinition<TService>,
    payload: TPayload,
  ): ModuleOwnedProviderActivation<TService>;

  /**
   * Attaches owner-attributed metadata to the exact ordinary scoped class
   * provider which the current module has already registered. Unlike
   * `addScoped`, this never creates a provider, keyed alias, or new lifetime.
   */
  attachExistingScoped<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
    implementation: Class<TService>,
    payload: TPayload,
  ): ModuleOwnedProviderActivation<TService>;

  /** Adds inert owner-attributed metadata without manufacturing a DI service. */
  addMetadata<TPayload>(channel: ModuleOwnedMetadataChannel<TPayload>, payload: TPayload): void;
}

/** Higher-layer hook. DI invokes it once for every module in the actual root graph. */
export type ModuleOwnedProviderContributor = (
  metadata: BazisModuleMetadata,
  context: ModuleOwnedProviderContributionContext,
) => void;

const contributors: ModuleOwnedProviderContributor[] = [];
const validators: ModuleOwnedContributionValidator[] = [];

/** Registers a feature-independent owner-window contributor, idempotently by reference. */
export function registerModuleOwnedProviderContributor(contributor: ModuleOwnedProviderContributor): void {
  if (!contributors.includes(contributor)) {
    contributors.push(contributor);
  }
}

/** Read-only, channel-capability-based view over one completed module graph. */
export interface ModuleOwnedContributionSnapshot {
  getProviderContributions<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
  ): readonly ModuleOwnedProviderContribution<TPayload, TService>[];
  getMetadataContributions<TPayload>(
    channel: ModuleOwnedMetadataChannel<TPayload>,
  ): readonly ModuleOwnedMetadataContribution<TPayload>[];
}

/** Build-time view; the ordinary contribution snapshot remains usable at runtime. */
export interface ModuleOwnedValidationSnapshot extends ModuleOwnedContributionSnapshot {
  /** Counts final registrations after configure/remove/replace, without creating services. */
  countProviders(token: Token<unknown>, key?: ServiceKey): number;
}

/** Higher-layer cross-module validation, run once for every built container. */
export type ModuleOwnedContributionValidator = (snapshot: ModuleOwnedValidationSnapshot) => void;

/** Registers a final contribution validator, idempotently by function reference. */
export function registerModuleOwnedContributionValidator(validator: ModuleOwnedContributionValidator): void {
  if (!validators.includes(validator)) {
    validators.push(validator);
  }
}

export function createModuleOwnedProviderChannel<TPayload, TService>(
  description: string,
): ModuleOwnedProviderChannel<TPayload, TService> {
  return Object.freeze({ kind: "provider", description: requireChannelDescription(description) }) as
    ModuleOwnedProviderChannel<TPayload, TService>;
}

export function createModuleOwnedMetadataChannel<TPayload>(
  description: string,
): ModuleOwnedMetadataChannel<TPayload> {
  return Object.freeze({ kind: "metadata", description: requireChannelDescription(description) }) as
    ModuleOwnedMetadataChannel<TPayload>;
}

function requireChannelDescription(description: string): string {
  const normalized = description.trim();
  if (normalized.length === 0) {
    throw new TypeError("Module-owned contribution channel description must not be empty.");
  }
  return normalized;
}

type AnyChannel = object;
type AnyContribution = ModuleOwnedProviderContribution<unknown, unknown> | ModuleOwnedMetadataContribution<unknown>;

interface ProviderRegistrationAudit {
  readonly ownerName: string;
  readonly implementation: Class<unknown>;
  readonly token: Class<unknown>;
  readonly definition: ProviderDefinition;
}

const EMPTY_CONTRIBUTIONS: readonly never[] = Object.freeze([]);

/** @internal Mutable only while createContainer builds one module graph. */
export class ModuleOwnedContributionStore {
  private readonly records = new Map<AnyChannel, AnyContribution[]>();
  private readonly providerAudits: ProviderRegistrationAudit[] = [];
  private sealed = false;

  public addProvider<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
    ownerName: string,
    payload: TPayload,
    activation: ModuleOwnedProviderActivation<TService>,
    implementation: Class<TService>,
    definition: ProviderDefinition<TService>,
  ): void {
    this.assertMutable();
    this.append(channel, Object.freeze({
      kind: "provider",
      ownerName,
      payload,
      activation,
    }));
    this.providerAudits.push({
      ownerName,
      implementation: implementation as Class<unknown>,
      token: implementation as Class<unknown>,
      definition: definition as ProviderDefinition,
    });
  }

  public addMetadata<TPayload>(
    channel: ModuleOwnedMetadataChannel<TPayload>,
    ownerName: string,
    payload: TPayload,
  ): void {
    this.assertMutable();
    this.append(channel, Object.freeze({ kind: "metadata", ownerName, payload }));
  }

  public validateProviderExclusivity(definitions: readonly ProviderDefinition[]): void {
    const issues = new Set<string>();
    const contributedDefinitions = new Set<ProviderDefinition>(
      this.providerAudits.map((audit) => audit.definition),
    );
    for (let auditIndex = 0; auditIndex < this.providerAudits.length; auditIndex += 1) {
      const audit = this.providerAudits[auditIndex] as ProviderRegistrationAudit;
      for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
        const definition = definitions[definitionIndex] as ProviderDefinition;
        // Every owner-bound registration has its own private key. Reusing the
        // same class in another owner therefore cannot collide; the higher
        // layer validates semantic identities in its opaque channel. Only an
        // ordinary second DI registration would create another lifetime.
        if (contributedDefinitions.has(definition)) {
          continue;
        }
        if (
          definition.provider.provide === audit.token
          || (isClassProvider(definition.provider) && definition.provider.useClass === audit.implementation)
        ) {
          issues.add(
            `Module "${audit.ownerName}": class "${className(audit.implementation)}" is both a module-owned contribution and another DI registration.`,
          );
        }
      }
    }
    if (issues.size > 0) {
      throw new ModuleOwnedProviderConflictError(Object.freeze([...issues]));
    }
  }

  public seal(): void {
    if (this.sealed) {
      return;
    }
    for (const records of this.records.values()) {
      Object.freeze(records);
    }
    this.sealed = true;
  }

  public getProvider<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
  ): readonly ModuleOwnedProviderContribution<TPayload, TService>[] {
    return (this.records.get(channel) ?? EMPTY_CONTRIBUTIONS) as
      readonly ModuleOwnedProviderContribution<TPayload, TService>[];
  }

  public getMetadata<TPayload>(
    channel: ModuleOwnedMetadataChannel<TPayload>,
  ): readonly ModuleOwnedMetadataContribution<TPayload>[] {
    return (this.records.get(channel) ?? EMPTY_CONTRIBUTIONS) as
      readonly ModuleOwnedMetadataContribution<TPayload>[];
  }

  private append(channel: AnyChannel, contribution: AnyContribution): void {
    const existing = this.records.get(channel);
    if (existing) {
      existing.push(contribution);
    } else {
      this.records.set(channel, [contribution]);
    }
  }

  private assertMutable(): void {
    if (this.sealed) {
      throw new Error("Module-owned contribution store is sealed.");
    }
  }
}

function className(target: Class<unknown>): string {
  return target.name.trim() || "<anonymous>";
}

/** @internal Invoked only from createContainer while the owner record is open. */
export function applyModuleOwnedProviderContributors(
  metadata: BazisModuleMetadata,
  ownerName: string,
  collection: ServiceCollection,
  store: ModuleOwnedContributionStore,
  ownerDefinitionsStart: number,
): void {
  if (contributors.length === 0) {
    return;
  }

  const context: ModuleOwnedProviderContributionContext = {
    registerScoped: <TPayload, TService>(
      channel: ModuleOwnedProviderChannel<TPayload, TService>,
      definition: ProviderDefinition<TService>,
      payload: TPayload,
    ): ModuleOwnedProviderActivation<TService> => {
      if (channel.kind !== "provider" || definition.lifetime !== "scoped" || definition.key !== undefined
        || !isClassProvider(definition.provider) || definition.provider.provide !== definition.provider.useClass) {
        throw new TypeError(`Module "${ownerName}": module-owned provider must be an unkeyed scoped self-class definition.`);
      }
      const implementation = definition.provider.useClass;
      const exists = collection.definitionsFrom(ownerDefinitionsStart).some((existing) =>
        existing.provider.provide === implementation
        || (isClassProvider(existing.provider) && existing.provider.useClass === implementation));
      // An incompatible explicit registration is an error; never silently replace it.
      if (!exists) collection.add(definition);
      return context.attachExistingScoped(channel, implementation, payload);
    },
    addScoped: <TPayload, TService>(
      channel: ModuleOwnedProviderChannel<TPayload, TService>,
      definition: ProviderDefinition<TService>,
      payload: TPayload,
    ): ModuleOwnedProviderActivation<TService> => {
      if (channel.kind !== "provider") {
        throw new TypeError("addScoped requires a module-owned provider channel.");
      }
      if (
        definition.lifetime !== "scoped"
        || definition.key !== undefined
        || !isClassProvider(definition.provider)
        || definition.provider.provide !== definition.provider.useClass
      ) {
        throw new TypeError(
          `Module "${ownerName}": module-owned provider must be an unkeyed scoped self-class definition.`,
        );
      }

      const implementation = definition.provider.useClass;
      const privateKey = Symbol(`${channel.description}:${ownerName}:${className(implementation)}`);
      const keyedDefinition = new ProviderDefinition(definition.provider, "scoped", privateKey);
      const start = collection.size;
      collection.add(keyedDefinition);
      const storedDefinition = collection.definitionsFrom(start)[0] as ProviderDefinition<TService>;
      const activation: ModuleOwnedProviderActivation<TService> = Object.freeze({
        activate: (resolver: ServiceResolver): TService =>
          resolver.resolveKeyed(storedDefinition.provider.provide, privateKey),
        activateAsync: (resolver: ServiceResolver): Promise<TService> =>
          resolver.resolveKeyedAsync(storedDefinition.provider.provide, privateKey),
      });
      store.addProvider(channel, ownerName, payload, activation, implementation, storedDefinition);
      return activation;
    },
    attachExistingScoped: <TPayload, TService>(
      channel: ModuleOwnedProviderChannel<TPayload, TService>,
      implementation: Class<TService>,
      payload: TPayload,
    ): ModuleOwnedProviderActivation<TService> => {
      if (channel.kind !== "provider") {
        throw new TypeError("attachExistingScoped requires a module-owned provider channel.");
      }
      const candidates = collection.definitionsFrom(ownerDefinitionsStart).filter((definition) =>
        definition.lifetime === "scoped"
        && definition.key === undefined
        && isClassProvider(definition.provider)
        && definition.provider.provide === implementation
        && definition.provider.useClass === implementation,
      ) as readonly ProviderDefinition<TService>[];
      if (candidates.length !== 1) {
        const qualifier = candidates.length === 0 ? "missing" : "duplicated";
        throw new TypeError(
          `Module "${ownerName}": exact ordinary scoped provider for class "${className(implementation)}" is ${qualifier}.`,
        );
      }
      const definition = candidates[0] as ProviderDefinition<TService>;
      const activation: ModuleOwnedProviderActivation<TService> = Object.freeze({
        activate: (resolver: ServiceResolver): TService => resolver.resolve(implementation),
        activateAsync: (resolver: ServiceResolver): Promise<TService> => resolver.resolveAsync(implementation),
      });
      store.addProvider(channel, ownerName, payload, activation, implementation, definition);
      return activation;
    },
    addMetadata: <TPayload>(channel: ModuleOwnedMetadataChannel<TPayload>, payload: TPayload): void => {
      if (channel.kind !== "metadata") {
        throw new TypeError("addMetadata requires a module-owned metadata channel.");
      }
      store.addMetadata(channel, ownerName, payload);
    },
  };

  for (let index = 0; index < contributors.length; index += 1) {
    (contributors[index] as ModuleOwnedProviderContributor)(metadata, context);
  }
}

/** @internal Runs after the complete graph has been collected and frozen. */
export function validateModuleOwnedContributions(
  store: ModuleOwnedContributionStore,
  definitions: readonly ProviderDefinition[],
): void {
  store.seal();
  if (validators.length === 0) {
    return;
  }
  const snapshot: ModuleOwnedValidationSnapshot = Object.freeze({
    countProviders: (token: Token<unknown>, key?: ServiceKey): number =>
      definitions.reduce((count, definition) => count + Number(definition.provider.provide === token && definition.key === key), 0),
    getProviderContributions: <TPayload, TService>(
      channel: ModuleOwnedProviderChannel<TPayload, TService>,
    ): readonly ModuleOwnedProviderContribution<TPayload, TService>[] => store.getProvider(channel),
    getMetadataContributions: <TPayload>(
      channel: ModuleOwnedMetadataChannel<TPayload>,
    ): readonly ModuleOwnedMetadataContribution<TPayload>[] => store.getMetadata(channel),
  });
  for (let index = 0; index < validators.length; index += 1) {
    (validators[index] as ModuleOwnedContributionValidator)(snapshot);
  }
}
