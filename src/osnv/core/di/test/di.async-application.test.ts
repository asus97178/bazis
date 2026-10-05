import { describe, expect, test } from "bun:test";
import {
  Application,
  AsyncResolutionRequiredError,
  CircularDependencyError,
  DI,
  HOSTED_SERVICE,
  type HostedService,
  addHostedService,
  addValidatedOptions,
  createContainer,
  createToken,
  createOptionsToken,
  singleton,
  singletonAsyncFactory,
  singletonAsyncFactoryWithResolver,
  ScopeDisposedError,
  type OsnvModuleRef,
  ServiceCollection,
  SERVICE_PROVIDER,
  type ServiceResolver,
} from "../index";
import { DisposableService } from "./test-fixtures";

interface IDb {
  ping(): string;
}

describe("DI async factories", () => {
  test("resolveAsync resolves singleton async factory once", async () => {
    const DB = createToken<IDb>("IDb");
    let created = 0;

    const moduleRef: OsnvModuleRef = {
      providers: [
        singletonAsyncFactory(DB, [], async () => {
          created += 1;
          await Promise.resolve();
          return { ping: () => "pong" };
        }),
      ],
    };

    const container = createContainer(moduleRef);
    const first = await container.resolveAsync(DB);
    const second = await container.resolveAsync(DB);
    expect(first).toBe(second);
    expect(first.ping()).toBe("pong");
    expect(created).toBe(1);
  });

  test("concurrent resolveAsync deduplicates creation", async () => {
    const DB = createToken<IDb>("IDb");
    let created = 0;

    const moduleRef: OsnvModuleRef = {
      providers: [
        singletonAsyncFactory(DB, [], async () => {
          created += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ping: () => "pong" };
        }),
      ],
    };

    const container = createContainer(moduleRef);
    const [a, b, c] = await Promise.all([
      container.resolveAsync(DB),
      container.resolveAsync(DB),
      container.resolveAsync(DB),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(created).toBe(1);
  });

  test("sync resolve of async provider throws AsyncResolutionRequiredError", () => {
    const DB = createToken<IDb>("IDb");
    const moduleRef: OsnvModuleRef = {
      providers: [singletonAsyncFactory(DB, [], async () => ({ ping: () => "pong" }))],
    };

    const container = createContainer(moduleRef);
    expect(() => container.resolve(DB)).toThrow(AsyncResolutionRequiredError);
  });

  test("sync resolve works after async materialization", async () => {
    const DB = createToken<IDb>("IDb");
    const moduleRef: OsnvModuleRef = {
      providers: [singletonAsyncFactory(DB, [], async () => ({ ping: () => "pong" }))],
    };

    const container = createContainer(moduleRef);
    const fromAsync = await container.resolveAsync(DB);
    expect(container.resolve(DB)).toBe(fromAsync);
  });

  test("class with async dependency resolves via resolveAsync", async () => {
    const DB = createToken<IDb>("IDb");

    class Repo {
      public constructor(public readonly db: IDb) {}
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        singletonAsyncFactory(DB, [], async () => ({ ping: () => "pong" })),
        DI.singleton(DI.classProvider(Repo, Repo, [DB])),
      ],
    };

    const container = createContainer(moduleRef);
    const repo = await container.resolveAsync(Repo);
    expect(repo.db.ping()).toBe("pong");
  });

  test("async factory with resolver respects scope", async () => {
    const SCOPED_VALUE = createToken<DisposableService>("ScopedValue");
    const WRAPPED = createToken<{ inner: DisposableService }>("Wrapped");

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(SCOPED_VALUE, DisposableService)),
        DI.scoped(
          DI.asyncFactoryProviderWithResolver(WRAPPED, [], async (resolver: ServiceResolver) => ({
            inner: resolver.resolve(SCOPED_VALUE),
          })),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    const scope = container.createScope();
    const wrapped = await scope.resolveAsync(WRAPPED);
    expect(wrapped.inner).toBe(scope.resolve(SCOPED_VALUE));
  });

  test("a captured scoped resolver rejects every resolving route after its scope is disposed", async () => {
    const CAPTURED = createToken<ServiceResolver>("DisposedCapturedResolver");
    const VALUE = createToken<string>("DisposedCapturedResolverValue");
    const MISSING = createToken<string>("DisposedCapturedResolverMissing");
    let created = 0;
    const container = createContainer({
      providers: [
        DI.scoped(DI.factoryProviderWithResolver(CAPTURED, [], (resolver) => resolver)),
        DI.keyedSingleton("keyed", DI.factoryProvider(VALUE, [], () => {
          created += 1;
          return "value";
        })),
      ],
    });
    const scope = container.createScope();
    const captured = scope.resolve(CAPTURED);
    await scope.dispose();

    expect(() => captured.resolveKeyed(VALUE, "keyed")).toThrow(ScopeDisposedError);
    expect(() => captured.resolveKeyed(MISSING, "missing")).toThrow(ScopeDisposedError);
    await expect(captured.resolveKeyedAsync(VALUE, "keyed")).rejects.toBeInstanceOf(ScopeDisposedError);
    await expect(captured.resolveAsync(MISSING)).rejects.toBeInstanceOf(ScopeDisposedError);
    expect(created).toBe(0);

    expect(container.resolveKeyed(VALUE, "keyed")).toBe("value");
    expect(created).toBe(1);
    await container.dispose();
  });

  test("resolver re-entry into its pending activation rejects as a circular dependency", async () => {
    const SELF = createToken<unknown>("AsyncResolverSelf");
    const container = createContainer({
      providers: [
        singletonAsyncFactoryWithResolver(SELF, [], async (resolver) => resolver.resolve(SELF)),
      ],
    });

    await expect(container.resolveAsync(SELF)).rejects.toBeInstanceOf(CircularDependencyError);
    await container.dispose();
  });

  test("resolver-driven async cycles reject and leave disposal settled", async () => {
    const A = createToken<unknown>("AsyncResolverCycleA");
    const B = createToken<unknown>("AsyncResolverCycleB");
    const container = createContainer({
      providers: [
        singletonAsyncFactoryWithResolver(A, [], async (resolver) => resolver.resolveAsync(B)),
        singletonAsyncFactoryWithResolver(B, [], async (resolver) => resolver.resolveAsync(A)),
      ],
    }, { validateOnBuild: true });

    await expect(container.resolveAsync(A)).rejects.toBeInstanceOf(CircularDependencyError);
    await container.dispose();
  });

  test("cross-root cycles through a newly-created async activation reject", async () => {
    const A = createToken<unknown>("CrossRootCycleA");
    const B = createToken<unknown>("CrossRootCycleB");
    const C = createToken<unknown>("CrossRootCycleC");
    const releaseA = Promise.withResolvers<void>();
    const releaseC = Promise.withResolvers<void>();
    const enteredB = Promise.withResolvers<void>();
    const container = createContainer({
      providers: [
        singletonAsyncFactoryWithResolver(A, [], async (resolver) => {
          await releaseA.promise;
          return resolver.resolveAsync(B);
        }),
        singletonAsyncFactoryWithResolver(B, [], async (resolver) => {
          enteredB.resolve();
          return resolver.resolveAsync(C);
        }),
        singletonAsyncFactoryWithResolver(C, [], async (resolver) => {
          await releaseC.promise;
          return resolver.resolveAsync(A);
        }),
      ],
    });
    const externalA = container.resolveAsync(A);
    const externalC = container.resolveAsync(C);
    releaseA.resolve();
    await enteredB.promise;
    releaseC.resolve();
    await expect(Promise.all([externalA, externalC])).rejects.toBeInstanceOf(CircularDependencyError);
    await container.dispose();
  });

  test("a completed child resolver does not retain its active parent ancestry", async () => {
    const A = createToken<string>("CompletedChildParent");
    const B = createToken<ServiceResolver>("CompletedChildResolver");
    const entered = Promise.withResolvers<void>();
    const releaseA = Promise.withResolvers<void>();
    let captured: ServiceResolver | undefined;
    const container = createContainer({
      providers: [
        singletonAsyncFactoryWithResolver(A, [], async (resolver) => {
          await resolver.resolveAsync(B);
          entered.resolve();
          await releaseA.promise;
          return "A";
        }),
        singletonAsyncFactoryWithResolver(B, [], async (resolver) => {
          captured = resolver;
          return resolver;
        }),
      ],
    });
    const pendingA = container.resolveAsync(A);
    await entered.promise;
    if (!captured) throw new Error("Expected completed child resolver.");
    const joinedA = captured.resolveAsync(A);
    releaseA.resolve();
    await expect(joinedA).resolves.toBe("A");
    await expect(pendingA).resolves.toBe("A");
    await container.dispose();
  });

  test("repeated rejected async cycles release their wait graph before container disposal", async () => {
    const A = createToken<unknown>("RepeatedCycleA");
    const B = createToken<unknown>("RepeatedCycleB");
    let release = Promise.withResolvers<void>();
    const container = createContainer({ providers: [
      singletonAsyncFactoryWithResolver(A, [], async resolver => {
        await release.promise;
        return resolver.resolveAsync(B);
      }),
      singletonAsyncFactoryWithResolver(B, [], async resolver => {
        await release.promise;
        return resolver.resolveAsync(A);
      }),
    ] });
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        release = Promise.withResolvers<void>();
        const first = container.resolveAsync(A);
        const second = container.resolveAsync(B);
        release.resolve();
        const results = await Promise.allSettled([first, second]);
        for (const result of results) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CircularDependencyError);
        }
      }
      // Inspect lifecycle bookkeeping: public rejection alone cannot prove
      // that a long-lived container released the failed dependency graphs.
      const state = container as unknown as {
        lifetime: { root: { pendingWaits: Map<number, Set<number>> } };
        activations: { activeActivations: Map<number, unknown> };
      };
      expect(state.activations.activeActivations.size).toBe(0);
      expect(state.lifetime.root.pendingWaits.size).toBe(0);
    } finally {
      await container.dispose();
    }
  });

  test("scoped async factory caches per scope", async () => {
    const DB = createToken<IDb>("IDb");
    let created = 0;

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(
          DI.asyncFactoryProvider(DB, [], async () => {
            created += 1;
            return { ping: () => "pong" };
          }),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    const scopeA = container.createScope();
    const scopeB = container.createScope();
    const a1 = await scopeA.resolveAsync(DB);
    const a2 = await scopeA.resolveAsync(DB);
    const b1 = await scopeB.resolveAsync(DB);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(created).toBe(2);
  });

  test("async-created disposable is disposed by container", async () => {
    const SERVICE = createToken<DisposableService>("AsyncDisposable");
    const moduleRef: OsnvModuleRef = {
      providers: [singletonAsyncFactory(SERVICE, [], async () => new DisposableService())],
    };

    const container = createContainer(moduleRef);
    const service = await container.resolveAsync(SERVICE);
    expect(service.disposed).toBe(false);

    await container.dispose();
    expect(service.disposed).toBe(true);
  });

  test("one disposable exposed through a singleton alias is disposed exactly once", async () => {
    const ALIAS = createToken<CountingDisposable>("CountingDisposableAlias");
    class CountingDisposable {
      public disposeCount = 0;
      public dispose(): void {
        this.disposeCount += 1;
      }
    }
    const moduleRef: OsnvModuleRef = {
      providers: [
        singleton(CountingDisposable),
        DI.singleton(DI.factoryProvider(ALIAS, [CountingDisposable], (service) => service)),
      ],
    };
    const container = createContainer(moduleRef);
    const service = container.resolve(CountingDisposable);
    expect(container.resolve(ALIAS)).toBe(service);

    await container.dispose();
    expect(service.disposeCount).toBe(1);
  });

  test("dispose waits for an in-flight async factory and cleans up its late resource", async () => {
    const SERVICE = createToken<DisposableService>("PendingAsyncDisposable");
    const gate = Promise.withResolvers<void>();
    let created: DisposableService | undefined;
    const moduleRef: OsnvModuleRef = {
      providers: [
        singletonAsyncFactory(SERVICE, [], async () => {
          await gate.promise;
          created = new DisposableService();
          return created;
        }),
      ],
    };

    const container = createContainer(moduleRef);
    const resolution = container.resolveAsync(SERVICE);
    const firstDispose = container.dispose();
    expect(container.dispose()).toBe(firstDispose);
    gate.resolve();

    await expect(resolution).rejects.toBeInstanceOf(ScopeDisposedError);
    await firstDispose;
    expect(created?.disposed).toBe(true);
    expect(() => container.createScope()).toThrow(ScopeDisposedError);
  });

  test("a pending async resolution does not create a second cached lifetime instance", async () => {
    const SERVICE = createToken<DisposableService>("PendingCachedClass");
    const gate = Promise.withResolvers<void>();
    let created = 0;
    const container = createContainer({
      providers: [DI.singleton(DI.factoryProvider(SERVICE, [], () => {
        created += 1;
        return new DisposableService();
      }))],
    });

    // Async class/factory resolution yields before publishing its cache entry.
    const pending = container.resolveAsync(SERVICE);
    expect(() => container.resolve(SERVICE)).toThrow(AsyncResolutionRequiredError);
    gate.resolve();
    const service = await pending;
    expect(container.resolve(SERVICE)).toBe(service);
    expect(created).toBe(1);
    await container.dispose();
    expect(service.disposed).toBe(true);
  });

  test("root disposal invalidates active scopes and continues after disposer failures", async () => {
    class GoodDisposable extends DisposableService {}
    class RootGoodDisposable extends DisposableService {}
    class BrokenDisposable {
      public disposed = false;
      dispose(): void {
        this.disposed = true;
        throw new Error("broken dispose");
      }
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(GoodDisposable, GoodDisposable)),
        singleton(RootGoodDisposable),
        singleton(BrokenDisposable),
      ],
    };
    const container = createContainer(moduleRef);
    const scope = container.createScope();
    const good = scope.resolve(GoodDisposable);
    const rootGood = container.resolve(RootGoodDisposable);
    const broken = container.resolve(BrokenDisposable);

    await expect(container.dispose()).rejects.toThrow("broken dispose");
    expect(good.disposed).toBe(true);
    expect(rootGood.disposed).toBe(true);
    expect(broken.disposed).toBe(true);
    expect(() => scope.resolve(GoodDisposable)).toThrow(ScopeDisposedError);
  });

  test("resolving the injectable service provider does not recursively dispose the container", async () => {
    const container = createContainer({ providers: [] });
    expect(container.resolve(SERVICE_PROVIDER)).toBe(container);

    const first = container.dispose();
    expect(container.dispose()).toBe(first);
    await first;
  });
});

describe("DI application lifecycle", () => {
  test("options failure stays primary when startup cleanup also fails", async () => {
    const primary = new Error("options load failed");
    const cleanup = new Error("startup cleanup failed");
    const RESOURCE = createToken<object>("OptionsStartupResource");
    const services = new ServiceCollection();
    let disposed = 0;
    let started = 0;
    services.addSingleton(DI.factoryProvider(RESOURCE, [], () => ({
      dispose() { disposed += 1; throw cleanup; },
    })));
    addValidatedOptions(services, createOptionsToken("startup-failure"), {
      load() { throw primary; },
    });
    addHostedService(services, () => ({ start() { started += 1; }, stop() {} }));
    const provider = services.buildServiceProvider();
    provider.resolve(RESOURCE);
    await expect(Application.start(provider)).rejects.toBe(primary);
    expect(disposed).toBe(1);
    expect(started).toBe(0);
    expect(() => provider.resolve(RESOURCE)).toThrow(ScopeDisposedError);
  });

  test("starts hosted services in order and stops in reverse", async () => {
    const events: string[] = [];
    const services = new ServiceCollection();
    addHostedService(services, () => ({
      start: () => void events.push("start:a"),
      stop: () => void events.push("stop:a"),
    }));
    addHostedService(services, () => ({
      start: () => void events.push("start:b"),
      stop: () => void events.push("stop:b"),
    }));

    const provider = services.buildServiceProvider();
    const app = await Application.start(provider);
    await app.stop();

    expect(events).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
  });

  test("stop disposes the container and is idempotent", async () => {
    const moduleRef: OsnvModuleRef = {
      providers: [singleton(DisposableService)],
    };

    const container = createContainer(moduleRef);
    const service = container.resolve(DisposableService);
    const app = await Application.start(container);

    await app.stop();
    await app.stop();
    expect(service.disposed).toBe(true);
  });

  test("failed start rolls back started services and disposes", async () => {
    const events: string[] = [];
    const services = new ServiceCollection();
    addHostedService(services, () => ({
      start: () => void events.push("start:a"),
      stop: () => void events.push("stop:a"),
    }));
    addHostedService(services, () => ({
      start: () => {
        throw new Error("boom");
      },
      stop: () => void events.push("stop:b"),
    }));

    const provider = services.buildServiceProvider();
    await expect(Application.start(provider)).rejects.toThrow("boom");
    expect(events).toEqual(["start:a", "stop:a"]);
  });

  test("hosted construction failure disposes earlier resources without replacing its primary error", async () => {
    class Resource extends DisposableService {}
    const RESOURCE = createToken<Resource>("HostedConstructionResource");
    let resource: Resource | undefined;
    const services = new ServiceCollection();
    services.addSingleton({ provide: RESOURCE, useFactory: () => (resource = new Resource()), deps: [] });
    services.addTransient(
      DI.factoryProvider<HostedService, [typeof RESOURCE]>(
        HOSTED_SERVICE,
        [RESOURCE],
        (_resource) => ({ start: () => undefined, stop: () => undefined }),
      ),
    );
    addHostedService(services, () => {
      throw new Error("hosted construction failed");
    });
    const provider = services.buildServiceProvider();

    await expect(Application.start(provider)).rejects.toThrow("hosted construction failed");
    expect(resource?.disposed).toBe(true);
  });

  test("runApplication removes every installed signal listener after the first signal", async () => {
    const SIGNAL_A = "SIGWINCH" as NodeJS.Signals;
    const SIGNAL_B = "SIGUSR2" as NodeJS.Signals;
    const beforeA = process.listenerCount(SIGNAL_A);
    const beforeB = process.listenerCount(SIGNAL_B);
    const provider = new ServiceCollection().buildServiceProvider();

    const running = (await import("../extensions/application")).runApplication(provider, {
      signals: [SIGNAL_A, SIGNAL_B],
    });
    await Bun.sleep(1);
    (process.emit as (event: string, ...args: unknown[]) => boolean)(SIGNAL_A, SIGNAL_A);
    await running;

    expect(process.listenerCount(SIGNAL_A)).toBe(beforeA);
    expect(process.listenerCount(SIGNAL_B)).toBe(beforeB);
  });
});
