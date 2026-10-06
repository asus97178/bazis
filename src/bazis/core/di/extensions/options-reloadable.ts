import { OptionsValidationError } from "../errors";
import type { ServiceCollection } from "../ServiceCollection";
import { createToken, type InjectionToken } from "../token";
import type { ServiceResolver } from "../types";
import { OPTIONS_STARTUP_VALIDATOR, type ValidatedOptionsConfig } from "./options";

/** Unsubscribes an {@link OptionsMonitor.onChange} listener. Idempotent. */
export interface OptionsChangeSubscription {
  dispose(): void;
}

/**
 * .NET `IOptionsMonitor<T>` analog: a singleton holding the always-current value,
 * able to reload it on demand and notify subscribers. Reloads are explicit
 * (`reload()`) — call it from a file watcher, admin endpoint, etc. — which keeps
 * the design free of ambient config-change machinery.
 */
export interface OptionsMonitor<T> {
  /** The latest validated value. */
  readonly current: T;
  /** Subscribes to value changes; dispose the result to unsubscribe. */
  onChange(listener: (value: T) => void): OptionsChangeSubscription;
  /**
   * Re-runs `load`/`validate`. On success updates `current` and notifies
   * listeners; on validation failure throws and keeps the last good value.
   */
  reload(): void;
}

/**
 * .NET `IOptionsSnapshot<T>` analog: scoped, captured once per scope from the
 * monitor's current value. Stable for the lifetime of the scope (e.g. a request)
 * even if the monitor reloads mid-scope.
 */
export interface OptionsSnapshot<T> {
  readonly value: T;
}

export function createOptionsMonitorToken<T>(name = "default"): InjectionToken<OptionsMonitor<T>> {
  return createToken<OptionsMonitor<T>>(`IOptionsMonitor<${name}>`);
}

export function createOptionsSnapshotToken<T>(name = "default"): InjectionToken<OptionsSnapshot<T>> {
  return createToken<OptionsSnapshot<T>>(`IOptionsSnapshot<${name}>`);
}

/** Token pair for a single reloadable options source. */
export interface ReloadableOptionsTokens<T> {
  readonly monitor: InjectionToken<OptionsMonitor<T>>;
  readonly snapshot: InjectionToken<OptionsSnapshot<T>>;
}

export function createReloadableOptionsTokens<T>(name = "default"): ReloadableOptionsTokens<T> {
  return {
    monitor: createOptionsMonitorToken<T>(name),
    snapshot: createOptionsSnapshotToken<T>(name),
  };
}

class OptionsMonitorImpl<T> implements OptionsMonitor<T> {
  private value: T;
  private readonly listeners = new Set<(value: T) => void>();

  public constructor(
    private readonly config: ValidatedOptionsConfig<T>,
    private readonly name: string,
  ) {
    this.value = this.loadValidated();
  }

  public get current(): T {
    return this.value;
  }

  public onChange(listener: (value: T) => void): OptionsChangeSubscription {
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.listeners.delete(listener);
      },
    };
  }

  public reload(): void {
    // Validation runs before mutating state, so a bad reload leaves the last
    // good value in place and never fires listeners with invalid data.
    const next = this.loadValidated();
    this.value = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private loadValidated(): T {
    const value = this.config.load();
    const issues = this.config.validate?.(value) ?? [];
    if (issues.length > 0) {
      throw new OptionsValidationError(issues.map((issue) => `${this.name}: ${issue}`));
    }
    return value;
  }
}

/**
 * Registers a reloadable options source: a singleton {@link OptionsMonitor} (the
 * source of truth) and a scoped {@link OptionsSnapshot} read once per scope.
 * Like `addValidatedOptions`, it participates in `validateOptionsOnStart` so a
 * broken config fails fast on boot.
 */
export function addReloadableOptions<T>(
  services: ServiceCollection,
  tokens: ReloadableOptionsTokens<T>,
  config: ValidatedOptionsConfig<T>,
): void {
  services.addSingleton({
    provide: tokens.monitor,
    useFactory: (): OptionsMonitor<T> => new OptionsMonitorImpl(config, tokens.monitor.description),
    deps: [],
  });

  services.addScoped({
    provide: tokens.snapshot,
    // Captured once per scope from the singleton monitor's current value.
    useFactory: (resolver: ServiceResolver): OptionsSnapshot<T> => ({ value: resolver.resolve(tokens.monitor).current }),
    deps: [],
    withResolver: true,
  });

  services.addTransient({
    provide: OPTIONS_STARTUP_VALIDATOR,
    useFactory: (resolver: ServiceResolver) => (): void => {
      resolver.resolve(tokens.monitor);
    },
    deps: [],
    withResolver: true,
  });
}
