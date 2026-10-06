import { describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, Module, ServiceValidationError, createToken, type HostedService, type BazisModuleRef } from "../../di";
import {
  ApplicationLifetime,
  Environment,
  KernelError,
  LIFECYCLE_HOOK,
  Bazis,
  ShutdownTimeoutError,
  StartupAbortedError,
  StartupTimeoutError,
  type LifecycleHook,
  type Logger,
} from "../index";

function hosted(log: string[], name: string, phase?: number): HostedService {
  return {
    ...(phase === undefined ? {} : { phase }),
    start: () => {
      log.push(`start:${name}`);
    },
    stop: () => {
      log.push(`stop:${name}`);
    },
  };
}

function testBuilder(moduleRef: BazisModuleRef) {
  return Bazis.createBuilder(moduleRef).useEnvironment("test").useStartupReport(false);
}

describe("Kernel core", () => {
  test("Environment parses names and fails fast on unknown", () => {
    expect(new Environment("production").debug).toBe(false);
    expect(new Environment("development").isDevelopment).toBe(true);
    expect(new Environment("test").isTest).toBe(true);
    process.env.BAZIS_ENV = "prod";
    try {
      expect(Environment.fromProcess().name).toBe("production");
      process.env.BAZIS_ENV = "staging";
      expect(() => Environment.fromProcess()).toThrow(KernelError);
    } finally {
      delete process.env.BAZIS_ENV;
    }
  });

  test("missing process environment fails closed to production", () => {
    const previousBazis = process.env.BAZIS_ENV;
    const previousNode = process.env.NODE_ENV;
    try {
      delete process.env.BAZIS_ENV;
      delete process.env.NODE_ENV;
      const environment = Environment.fromProcess();
      expect(environment.name).toBe("production");
      expect(environment.debug).toBe(false);
    } finally {
      if (previousBazis === undefined) delete process.env.BAZIS_ENV;
      else process.env.BAZIS_ENV = previousBazis;
      if (previousNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNode;
    }
  });

  test("full lifecycle order: hooks, phased hosted services, reverse stop", async () => {
    const log: string[] = [];
    const hook: LifecycleHook = {
      onInit: () => {
        log.push("hook:init");
      },
      onBootstrap: () => {
        log.push("hook:bootstrap");
      },
      onShutdown: (signal) => {
        log.push(`hook:shutdown:${signal ?? "none"}`);
      },
      onDestroy: () => {
        log.push("hook:destroy");
      },
    };

    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, hook)),
        // Registered first but phase 1: must start AFTER phase 0.
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "http", 1))),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "db", 0))),
      ],
    };

    const kernel = await testBuilder(moduleRef).build();
    await kernel.start();
    expect(kernel.isStarted).toBe(true);
    await kernel.stop({ exitCode: 0, signal: "SIGTERM" });

    expect(log).toEqual([
      "hook:init",
      "start:db",
      "start:http",
      "hook:bootstrap",
      "stop:http",
      "stop:db",
      "hook:shutdown:SIGTERM",
      "hook:destroy",
    ]);
  });

  test("lifetime callbacks fire and lifetime.stop() ends run() with exit code", async () => {
    const log: string[] = [];

    class Stopper {
      public constructor(private readonly lifetime: ApplicationLifetime) {}
      public scheduleStop(): void {
        queueMicrotask(() => this.lifetime.stop(42));
      }
    }

    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.classProvider(Stopper, Stopper, [ApplicationLifetime] as const))],
    };

    const kernel = await testBuilder(moduleRef).build();
    kernel.lifetime.onStarted(() => {
      log.push("started");
      kernel.container.resolve(Stopper).scheduleStop();
    });
    kernel.lifetime.onStopping(() => {
      log.push("stopping");
    });
    kernel.lifetime.onStopped(() => {
      log.push("stopped");
    });

    const exitCode = await kernel.run();
    expect(exitCode).toBe(42);
    expect(log).toEqual(["started", "stopping", "stopped"]);
  });

  test("immediate public stop() cancels a concurrent run() before startup and preserves its exit code", async () => {
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "svc")))],
    };
    const kernel = await testBuilder(moduleRef).useSignals([]).build();

    const running = kernel.run();
    await kernel.stop({ exitCode: 23 });

    expect(await running).toBe(23);
    // The stop request arrives before the planned start callback executes.
    expect(log).toEqual([]);
  });

  test("failed hosted start rolls back started services and disposes container", async () => {
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "ok"))),
        DI.singleton(
          DI.valueProvider(HOSTED_SERVICE, {
            start: () => {
              throw new Error("boom");
            },
            stop: () => {
              log.push("stop:broken");
            },
          } satisfies HostedService),
        ),
      ],
    };

    const kernel = await testBuilder(moduleRef).build();
    await expect(kernel.start()).rejects.toThrow("boom");
    expect(log).toEqual(["start:ok", "stop:ok"]);
    // Container is disposed after a failed start.
    expect(() => kernel.container.resolve(createToken("anything"))).toThrow();
  });

  test("hanging stop() hits ShutdownTimeoutError", async () => {
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(
          DI.valueProvider(HOSTED_SERVICE, {
            start: () => {},
            stop: () => new Promise<void>(() => {}),
          } satisfies HostedService),
        ),
      ],
    };

    const kernel = await testBuilder(moduleRef).useShutdownTimeout(20).build();
    await kernel.start();
    await expect(kernel.stop()).rejects.toThrow(ShutdownTimeoutError);
  });

  test("failing started callback shuts services down and surfaces the error", async () => {
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "svc")))],
    };

    const kernel = await testBuilder(moduleRef).build();
    kernel.lifetime.onStarted(() => {
      throw new Error("started hook boom");
    });

    await expect(kernel.start()).rejects.toThrow("started hook boom");
    // The hosted service that came up is stopped — no half-started hang.
    expect(log).toEqual(["start:svc", "stop:svc"]);
    expect(() => kernel.container.resolve(createToken("anything"))).toThrow();
  });

  test("a hanging stopping callback is bounded by the shutdown timeout", async () => {
    const moduleRef: BazisModuleRef = { providers: [] };
    const kernel = await testBuilder(moduleRef).useShutdownTimeout(20).build();
    await kernel.start();
    // Previously only hosted-service shutdown was timed; a hanging lifetime
    // callback would wedge stop() forever.
    kernel.lifetime.onStopping(() => new Promise<void>(() => {}));
    await expect(kernel.stop()).rejects.toThrow(ShutdownTimeoutError);
  });

  test("kernel infra is global: closed module sees Environment without imports", async () => {
    class NeedsEnvironment {
      public constructor(public readonly environment: Environment) {}
    }

    @Module({
      providers: [DI.singleton(DI.classProvider(NeedsEnvironment, NeedsEnvironment, [Environment] as const))],
      exports: [],
    })
    class ClosedModule {}

    @Module({ imports: [ClosedModule] })
    class RootModule {}

    const kernel = await testBuilder(RootModule).build();
    expect(kernel.container.resolve(NeedsEnvironment).environment.name).toBe("test");
    await kernel.stop();
  });

  test("profile factory receives the environment", async () => {
    const MARKER = createToken<string>("ProfileMarker");
    const kernel = await Bazis.createBuilder((env: Environment) => ({
      providers: [DI.singleton(DI.valueProvider(MARKER, `profile:${env.name}`))],
    }))
      .useEnvironment("test")
      .useStartupReport(false)
      .build();
    expect(kernel.container.resolve(MARKER)).toBe("profile:test");
    await kernel.stop();
  });

  test("empty and background-only @Module classes are never invoked as profile factories", async () => {
    const log: string[] = [];
    class Worker implements HostedService {
      start(): void {
        log.push("start");
      }
      stop(): void {
        log.push("stop");
      }
    }

    @Module({})
    class EmptyModule {}

    @Module({ imports: [EmptyModule], background: [Worker] })
    class BackgroundOnlyModule {}

    const kernel = await testBuilder(BackgroundOnlyModule).build();
    await kernel.start();
    await kernel.stop();
    expect(log).toEqual(["start", "stop"]);
  });

  test("concurrent start and stop calls share lifecycle work", async () => {
    const startGate = Promise.withResolvers<void>();
    const stopGate = Promise.withResolvers<void>();
    let starts = 0;
    let stops = 0;
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(
          DI.valueProvider(HOSTED_SERVICE, {
            async start() {
              starts += 1;
              await startGate.promise;
            },
            async stop() {
              stops += 1;
              await stopGate.promise;
            },
          } satisfies HostedService),
        ),
      ],
    };
    const kernel = await testBuilder(moduleRef).build();

    const firstStart = kernel.start();
    expect(kernel.start()).toBe(firstStart);
    startGate.resolve();
    await firstStart;
    expect(starts).toBe(1);

    const firstStop = kernel.stop();
    expect(kernel.stop()).toBe(firstStop);
    stopGate.resolve();
    await firstStop;
    expect(stops).toBe(1);
  });

  test("a throwing startup logger triggers full hosted-service cleanup", async () => {
    const log: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {
        throw new Error("logger failed");
      },
      warn: () => {},
      error: () => {},
    };
    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "svc")))],
    };
    const kernel = await Bazis.createBuilder(moduleRef)
      .useEnvironment("test")
      .useLogger(logger)
      .useStartupReport(true)
      .build();

    await expect(kernel.start()).rejects.toThrow("logger failed");
    expect(log).toEqual(["start:svc", "stop:svc"]);
    expect(() => kernel.container.resolve(createToken("disposed"))).toThrow();
  });

  test("validateOnBuild stays on by default in the kernel", async () => {
    const MISSING = createToken<unknown>("KernelMissingDep");
    class Broken {
      public constructor(public readonly dep: unknown) {}
    }
    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.classProvider(Broken, Broken, [MISSING] as const))],
    };

    await expect(testBuilder(moduleRef).build()).rejects.toThrow(ServiceValidationError);
  });

  test("stop during startup aborts the pending service and rolls back services that already started", async () => {
    const entered = Promise.withResolvers<void>();
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "ready"))),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
          start(signal?: AbortSignal) {
            log.push("start:pending");
            entered.resolve();
            return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          },
          stop() {
            log.push("stop:pending");
          },
        } satisfies HostedService)),
      ],
    };
    const kernel = await testBuilder(moduleRef).useShutdownTimeout(100).build();
    const starting = kernel.start();
    const startOutcome = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;

    await kernel.stop({ exitCode: 17 });
    expect(await startOutcome).toBeInstanceOf(StartupAbortedError);
    await Bun.sleep(0);
    expect(log).toEqual(["start:ready", "start:pending", "stop:ready", "stop:pending"]);
  });

  test("startup timeout bounds an uncooperative hosted service and rolls back earlier phases", async () => {
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "ready"))),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
          start: () => new Promise<void>(() => {}),
          stop: () => {
            log.push("stop:pending");
          },
        } satisfies HostedService)),
      ],
    };
    const kernel = await testBuilder(moduleRef)
      .useStartupTimeout(20)
      .useShutdownTimeout(50)
      .build();

    await expect(kernel.start()).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(log).toEqual(["start:ready", "stop:ready"]);
  });

  test("run installs signal handlers before startup completes", async () => {
    const entered = Promise.withResolvers<void>();
    const log: string[] = [];
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "ready"))),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
          start(signal?: AbortSignal) {
            entered.resolve();
            return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          },
          stop: () => {},
        } satisfies HostedService)),
      ],
    };
    const kernel = await testBuilder(moduleRef).useSignals(["SIGUSR2"]).build();
    const running = kernel.run();
    await entered.promise;
    process.emit("SIGUSR2", "SIGUSR2");

    expect(await running).toBe(0);
    expect(log).toContain("stop:ready");
  });
});
