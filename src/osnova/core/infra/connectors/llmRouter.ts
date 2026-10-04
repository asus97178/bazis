import type { AppConfig } from "../../kernel";
import {
  AGENT_MODEL_PROVIDER,
  agentModelRequest,
  type AgentModelProvider,
  type AgentModelProviderContext,
  type AgentModelRequest,
  type AgentModelResponse,
} from "../../agent";
import { InfraError, type InfraConnector } from "../InfraConnector";
import { redactSensitiveText } from "../../../library/redaction";
import { awaitAbortable } from "../../kernel/internal/awaitAbortable";
import {
  resolveLlmConnectionOptions,
  type LlmConfigShape,
  type LlmConnectionOptions,
  type LlmConnectorOptions,
  type LlmProviderAdapter,
} from "./llm";

export interface LlmModelProfileOptions extends LlmConnectorOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly fallback?: string;
}

export interface LlmModelProfile<T extends LlmConfigShape = LlmConfigShape> {
  readonly config: AppConfig<T>;
  readonly adapter: LlmProviderAdapter;
  readonly options: LlmModelProfileOptions;
}

export interface LlmRouterOptions {
  readonly defaultProfile?: string;
}

interface RuntimeProfile {
  readonly name: string;
  readonly adapter: LlmProviderAdapter;
  readonly provider: AgentModelProvider;
  readonly connection: LlmConnectionOptions;
  readonly options: LlmModelProfileOptions;
}

export class LlmModelRouterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LlmModelRouterError";
  }
}

function nonEmptyText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InfraError(`${field} must be a non-empty string when provided.`);
  }
  return trimmed;
}

function profileEntries(profiles: Readonly<Record<string, LlmModelProfile>>): readonly (readonly [string, LlmModelProfile])[] {
  const entries = Object.entries(profiles).map(([name, profile]) => [
    name,
    Object.freeze({ ...profile, options: normalizeProfileOptions(profile.options, `llmRouter.${name}`) }),
  ] as const);
  if (entries.length === 0) {
    throw new InfraError("llmRouter requires at least one model profile.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const [name] = entries[index] as [string, LlmModelProfile];
    const normalized = nonEmptyText(name, `llmRouter.profile[${index}]`);
    if (normalized !== name) {
      throw new InfraError(`llmRouter profile name "${name}" must not have surrounding whitespace.`);
    }
  }
  return Object.freeze(entries);
}

function defaultProfileName(
  entries: readonly (readonly [string, LlmModelProfile])[],
  options: LlmRouterOptions,
): string {
  const requested = nonEmptyText(options.defaultProfile, "llmRouter.defaultProfile");
  if (requested !== undefined) {
    if (!entries.some(([name]) => name === requested)) {
      throw new InfraError(`llmRouter defaultProfile "${requested}" is not registered.`);
    }
    return requested;
  }
  if (entries.length === 1) {
    return entries[0]![0];
  }
  if (entries.some(([name]) => name === "default")) {
    return "default";
  }
  throw new InfraError("llmRouter with multiple profiles requires defaultProfile or a profile named \"default\".");
}

function ensureFallbacksValid(entries: readonly (readonly [string, LlmModelProfile])[]): void {
  const names = new Set(entries.map(([name]) => name));
  for (let index = 0; index < entries.length; index += 1) {
    const [name, profile] = entries[index] as readonly [string, LlmModelProfile];
    const fallback = nonEmptyText(profile.options.fallback, `llmRouter.${name}.fallback`);
    if (fallback === undefined) {
      continue;
    }
    if (fallback === name) {
      throw new InfraError(`llmRouter profile "${name}" cannot fallback to itself.`);
    }
    if (!names.has(fallback)) {
      throw new InfraError(`llmRouter profile "${name}" fallback "${fallback}" is not registered.`);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const visit = (name: string): void => {
    if (state.get(name) === "visited") {
      return;
    }
    if (state.get(name) === "visiting") {
      const start = path.indexOf(name);
      const cycle = [...path.slice(start), name];
      throw new InfraError(`llmRouter fallback cycle detected: ${cycle.join(" -> ")}.`);
    }
    state.set(name, "visiting");
    path.push(name);
    const fallback = entries.find(([entryName]) => entryName === name)?.[1].options.fallback;
    if (fallback !== undefined) {
      visit(fallback);
    }
    path.pop();
    state.set(name, "visited");
  };
  for (const [name] of entries) {
    visit(name);
  }
}

function errorMessageOf(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function positiveInteger(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new InfraError(`${field} must be a positive integer when provided.`);
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new InfraError(`${field} must be a non-negative safe integer when provided.`);
  }
  return value;
}

function finiteNumber(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new InfraError(`${field} must be finite when provided.`);
  }
  return value;
}

function normalizeProfileOptions(options: LlmModelProfileOptions, field: string): LlmModelProfileOptions {
  const model = nonEmptyText(options.model, `${field}.model`);
  const fallback = nonEmptyText(options.fallback, `${field}.fallback`);
  nonNegativeInteger(options.timeoutMs, `${field}.timeoutMs`);
  positiveInteger(options.maxOutputTokens, `${field}.maxOutputTokens`);
  finiteNumber(options.temperature, `${field}.temperature`);
  return Object.freeze({
    ...options,
    ...(model === undefined ? {} : { model }),
    ...(fallback === undefined ? {} : { fallback }),
  });
}

export function llmProfile<T extends LlmConfigShape>(
  config: AppConfig<T>,
  adapter: LlmProviderAdapter,
  options: LlmModelProfileOptions = {},
): LlmModelProfile<T> {
  return Object.freeze({ config, adapter, options: normalizeProfileOptions(options, "llmProfile") });
}

export class LlmModelRouter implements AgentModelProvider {
  private readonly profiles = new Map<string, RuntimeProfile>();
  private connectPromise?: Promise<void>;
  private initializePromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private disposed = false;

  public constructor(
    profiles: readonly RuntimeProfile[],
    private readonly defaultProfile: string,
    private readonly factories: readonly (() => RuntimeProfile)[] = [],
  ) {
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index] as RuntimeProfile;
      this.profiles.set(profile.name, profile);
    }
  }

  public async complete(request: AgentModelRequest, context: AgentModelProviderContext): Promise<AgentModelResponse> {
    context.signal.throwIfAborted();
    await this.initialize();
    const requested = request.modelProfile ?? context.modelProfile ?? this.defaultProfile;
    return this.completeWithProfile(request, context, requested, new Set<string>());
  }

  public connect(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new InfraError("LLM model router is already disposed."));
    }
    this.connectPromise ??= this.connectProfiles(signal);
    return this.connectPromise;
  }

  private async connectProfiles(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.initialize();
    for (const profile of this.profiles.values()) {
      try {
        if (this.disposed) throw new InfraError("LLM model router is already disposed.");
        signal?.throwIfAborted();
        await awaitAbortable(Promise.resolve(profile.adapter.connect?.(profile.provider, signal)), signal);
      } catch (error) {
        const primary = new InfraError(
          `LLM model profile "${profile.name}" failed to connect: ${errorMessageOf(error)}`,
        );
        try {
          await this.dispose();
        } catch (cleanupError) {
          const cleanupErrors =
            cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
          throw new AggregateError(
            [primary, ...cleanupErrors],
            `LLM model router failed to connect and rollback finished with errors.`,
          );
        }
        throw primary;
      }
    }
  }

  private initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new InfraError("LLM model router is already disposed."));
    this.initializePromise ??= Promise.resolve().then(async () => {
      try {
        if (this.disposed) throw new InfraError("LLM model router is already disposed.");
        for (const create of this.factories) {
          const profile = create();
          this.profiles.set(profile.name, profile);
        }
      } catch (error) {
        const primary = new InfraError(`LLM model router failed to create profiles: ${errorMessageOf(error)}`);
        try {
          await this.dispose();
        } catch (cleanupError) {
          throw new AggregateError([primary, cleanupError], "LLM model router creation and rollback failed.");
        }
        throw primary;
      }
    });
    return this.initializePromise;
  }

  public dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    if (this.disposed) {
      return Promise.resolve();
    }
    this.disposed = true;
    const work = Promise.resolve().then(() => this.disposeProfiles());
    this.disposePromise = work;
    const clear = (): void => {
      this.disposePromise = undefined;
    };
    void work.then(clear, clear);
    return work;
  }

  private async disposeProfiles(): Promise<void> {
    const errors: unknown[] = [];
    const profiles = Array.from(this.profiles.values()).reverse();
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index] as RuntimeProfile;
      try {
        await profile.adapter.dispose?.(profile.provider);
      } catch (error) {
        errors.push(new InfraError(
          `LLM model profile "${profile.name}" failed to dispose: ${errorMessageOf(error)}`,
        ));
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "LLM model router disposal finished with errors.");
    }
  }

  public async healthCheck(signal?: AbortSignal): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    await this.initialize();
    let healthy = true;
    for (const profile of this.profiles.values()) {
      if (profile.adapter.healthCheck) {
        try {
          signal?.throwIfAborted();
          if (!(await awaitAbortable(Promise.resolve(profile.adapter.healthCheck(profile.provider, signal)), signal))) {
            healthy = false;
          }
        } catch {
          healthy = false;
          if (signal?.aborted) return false;
        }
      }
    }
    return healthy;
  }

  private async completeWithProfile(
    request: AgentModelRequest,
    context: AgentModelProviderContext,
    profileName: string,
    visited: Set<string>,
  ): Promise<AgentModelResponse> {
    if (visited.has(profileName)) {
      throw new LlmModelRouterError(`LLM model profile fallback cycle detected at "${profileName}".`);
    }
    visited.add(profileName);

    const profile = this.profiles.get(profileName);
    if (!profile) {
      throw new LlmModelRouterError(`Unknown LLM model profile "${profileName}".`);
    }
    if (context.signal.aborted) {
      throw new LlmModelRouterError("LLM model request was cancelled before provider dispatch.");
    }

    let emittedText = false, acceptingText = true;
    const streamingContext = context.onTextDelta ? { ...context, onTextDelta: (text: string) => {
      if (!acceptingText || context.signal.aborted) return;
      if (text) emittedText = true;
      context.onTextDelta!(text);
    } } : context;
    try {
      return await profile.provider.complete(this.requestForProfile(request, profile), this.contextForProfile(streamingContext, profileName));
    } catch (error) {
      acceptingText = false;
      const fallback = profile.options.fallback;
      // A second model must not silently append a new answer to already visible text.
      if (fallback !== undefined && !emittedText) {
        if (context.signal.aborted) throw new LlmModelRouterError("LLM model request was cancelled before provider dispatch.");
        return this.completeWithProfile(request, context, fallback, visited);
      }
      throw new LlmModelRouterError(
        `LLM model profile "${profileName}" failed: ${errorMessageOf(error)}`,
      );
    } finally {
      acceptingText = false;
    }
  }

  private requestForProfile(request: AgentModelRequest, profile: RuntimeProfile): AgentModelRequest {
    return agentModelRequest({
      invocationId: request.invocationId,
      messages: request.messages,
      tools: request.tools,
      output: request.output,
      capabilities: request.capabilities,
      modelProfile: profile.name,
      // Model identity belongs to infra/profile policy. Invocation input may
      // tune sampling/limits but cannot bypass the selected profile's model.
      model: profile.options.model ?? profile.connection.model,
      maxOutputTokens: request.maxOutputTokens ?? profile.options.maxOutputTokens,
      temperature: request.temperature ?? profile.options.temperature,
      metadata: { ...request.metadata, modelProfile: profile.name },
    });
  }

  private contextForProfile(context: AgentModelProviderContext, profileName: string): AgentModelProviderContext {
    return Object.freeze({
      ...context,
      modelProfile: profileName,
    });
  }
}

export function llmRouter(
  profiles: Readonly<Record<string, LlmModelProfile>>,
  options: LlmRouterOptions = {},
): InfraConnector<AgentModelProvider> {
  const entries = profileEntries(profiles);
  const defaultProfile = defaultProfileName(entries, options);
  ensureFallbacksValid(entries);
  const configs = Object.freeze(Array.from(new Set(entries.map(([, profile]) => profile.config))));

  return {
    token: AGENT_MODEL_PROVIDER,
    config: configs,
    create(configs) {
      // The router must have an owner before adapters allocate resources.
      // Initialization happens inside an awaited operation, so rollback can
      // await asynchronous adapter disposal and preserve cleanup errors.
      const factories = entries.map(([name, profile]) => () => {
        const connection = resolveLlmConnectionOptions(profile.config, profile.options, configs);
        // A profile-owned model is part of the concrete Infra connection. This
        // keeps direct providers strict while the router remains the authority
        // that selects the active profile/model pair.
        const profileConnection = profile.options.model === undefined
          ? connection
          : Object.freeze({ ...connection, model: profile.options.model });
        return Object.freeze({
          name,
          adapter: profile.adapter,
          provider: profile.adapter.create(profileConnection),
          connection: profileConnection,
          options: profile.options,
        });
      });
      return new LlmModelRouter([], defaultProfile, factories);
    },
    connect(client, signal) {
      return client instanceof LlmModelRouter ? client.connect(signal) : undefined;
    },
    dispose(client) {
      return client instanceof LlmModelRouter ? client.dispose() : undefined;
    },
    healthCheck(client, signal) {
      return client instanceof LlmModelRouter ? client.healthCheck(signal) : false;
    },
  };
}
