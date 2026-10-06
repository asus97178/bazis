import { DI, Global, Module, collectModuleConfigs, createContainer, type BazisModule, type BazisModuleRef } from "../di";
import { isBazisModuleClass } from "../di/module/Module";
import { ApplicationLifetime } from "./ApplicationLifetime";
import { Configuration, loadConfiguration } from "./config/Configuration";
import { ConfigRegistry } from "./config/ConfigRegistry";
import { argsSource, envSource } from "./config/sources";
import { Environment } from "./Environment";
import { EventBus } from "./events/EventBus";
import { HealthService } from "./health/HealthService";
import { Kernel, type KernelTimings } from "./Kernel";
import { ConsoleLogger } from "./logging/ConsoleLogger";
import { LOGGER, type Logger } from "./logging/Logger";
import type { ConfigSource, EnvironmentName, KernelOptions, UnhandledErrorPolicy } from "./types";
import { validateTimeout } from "./internal/validateTimeout";

/** Root module or a profile factory (Spring profiles, but explicit). */
export type RootModuleInput = BazisModuleRef | ((environment: Environment) => BazisModuleRef);

function resolveUserRoot(rootModule: RootModuleInput, environment: Environment): BazisModuleRef {
  if (typeof rootModule === "function") {
    if (isBazisModuleClass(rootModule)) {
      return rootModule as BazisModule;
    }
    return (rootModule as (environment: Environment) => BazisModuleRef)(environment);
  }
  return rootModule;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Mutable configuration phase (.NET HostApplicationBuilder). `build()`
 * produces an immutable Kernel: config is loaded, the DI graph is built and
 * validated, nothing can be registered afterwards.
 */
export class KernelBuilder {
  private readonly configSources: ConfigSource[] = [];
  private environmentName?: EnvironmentName;
  private debugFlag?: boolean;
  private shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  private startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  private signals: readonly NodeJS.Signals[] = DEFAULT_SIGNALS;
  private unhandledErrorPolicy: UnhandledErrorPolicy = "shutdown";
  private validateOnBuild = true;
  private startupReport?: boolean;
  private logger?: Logger;

  public constructor(private readonly rootModule: RootModuleInput) {}

  /** Overrides the default {@link ConsoleLogger} registered under `LOGGER`. */
  public useLogger(logger: Logger): this {
    this.logger = logger;
    return this;
  }

  public useOptions(options: KernelOptions): this {
    if (options.environment !== undefined) this.environmentName = options.environment;
    if (options.debug !== undefined) this.debugFlag = options.debug;
    if (options.shutdownTimeoutMs !== undefined) this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    if (options.startupTimeoutMs !== undefined) this.startupTimeoutMs = options.startupTimeoutMs;
    if (options.signals !== undefined) this.signals = options.signals;
    if (options.unhandledErrorPolicy !== undefined) this.unhandledErrorPolicy = options.unhandledErrorPolicy;
    if (options.validateOnBuild !== undefined) this.validateOnBuild = options.validateOnBuild;
    if (options.startupReport !== undefined) this.startupReport = options.startupReport;
    return this;
  }

  public useEnvironment(name: EnvironmentName, debug?: boolean): this {
    this.environmentName = name;
    if (debug !== undefined) {
      this.debugFlag = debug;
    }
    return this;
  }

  public useShutdownTimeout(timeoutMs: number): this {
    this.shutdownTimeoutMs = timeoutMs;
    return this;
  }

  public useStartupTimeout(timeoutMs: number): this {
    this.startupTimeoutMs = timeoutMs;
    return this;
  }

  public useSignals(signals: readonly NodeJS.Signals[]): this {
    this.signals = signals;
    return this;
  }

  public useUnhandledErrorPolicy(policy: UnhandledErrorPolicy): this {
    this.unhandledErrorPolicy = policy;
    return this;
  }

  public useStartupReport(enabled: boolean): this {
    this.startupReport = enabled;
    return this;
  }

  /** Sources are merged in registration order: later sources override earlier ones. */
  public addConfigSource(source: ConfigSource): this {
    this.configSources.push(source);
    return this;
  }

  public async build(): Promise<Kernel> {
    validateTimeout("startupTimeoutMs", this.startupTimeoutMs);
    validateTimeout("shutdownTimeoutMs", this.shutdownTimeoutMs);
    const buildStartedAt = performance.now();

    const environment =
      this.environmentName !== undefined
        ? new Environment(this.environmentName, this.debugFlag ?? this.environmentName !== "production")
        : Environment.fromProcess(this.debugFlag);

    const configStartedAt = performance.now();
    const configuration = await loadConfiguration(this.configSources.length ? this.configSources : [envSource(), argsSource()]);
    const configMs = performance.now() - configStartedAt;

    const lifetime = new ApplicationLifetime();
    const logger = this.logger ?? new ConsoleLogger({ minLevel: environment.debug ? "debug" : "info" });
    const userRoot = resolveUserRoot(this.rootModule, environment);
    const configs = collectModuleConfigs([userRoot]);
    const configRegistry = new ConfigRegistry(configs, environment.name, configuration);

    // Kernel infrastructure is a global module: any user module can depend on
    // Environment / Configuration / ApplicationLifetime / EventBus without
    // importing anything (NestJS @Global semantics).
    @Global()
    @Module({
      providers: [
        DI.singleton(DI.valueProvider(ConfigRegistry, configRegistry)),
        ...configRegistry.providers,
        DI.singleton(DI.valueProvider(Environment, environment)),
        DI.singleton(DI.valueProvider(Configuration, configuration)),
        DI.singleton(DI.valueProvider(ApplicationLifetime, lifetime)),
        DI.singleton(DI.valueProvider(LOGGER, logger)),
        DI.singleton(DI.factoryProviderWithResolver(EventBus, [], (resolver) => new EventBus(resolver))),
        DI.singleton(DI.factoryProviderWithResolver(HealthService, [], (resolver) => new HealthService(resolver))),
      ],
    })
    class BazisKernelInfraModule {}

    @Module({
      imports: [BazisKernelInfraModule, userRoot],
    })
    class BazisKernelModule {}

    const kernelRootModule = BazisKernelModule;

    const containerStartedAt = performance.now();
    const container = createContainer(kernelRootModule, { validateOnBuild: this.validateOnBuild });
    const containerMs = performance.now() - containerStartedAt;

    const timings: KernelTimings = {
      configMs,
      containerMs,
      buildStartedAt,
    };

    return new Kernel(container, environment, configuration, lifetime, timings, {
      startupTimeoutMs: this.startupTimeoutMs,
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      signals: this.signals,
      unhandledErrorPolicy: this.unhandledErrorPolicy,
      startupReport: this.startupReport ?? !environment.isProduction,
    });
  }
}
