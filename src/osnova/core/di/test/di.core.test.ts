import { describe, expect, test } from "bun:test";
import {
  AmbiguousNamedDependencyError,
  ClassDependenciesMismatchError,
  collectModuleControllers,
  DI,
  ProviderNotFoundError,
  createContainer,
  createToken,
  scoped,
  singleton,
  transient,
  registerClassProviderHook,
  type DiRegistrar,
  type OsnovaModuleRef,
  type ServiceResolver,
} from "../index";
import { namedDependency } from "../provider";
import {
  AppService,
  BoundDepsAppService,
  CounterService,
  LOGGER,
  MissingDepsAppService,
  SugarAppService,
  TestLogger,
} from "./test-fixtures";

describe("DI core", () => {
  test("resolves class with token dependency", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(DI.classProvider(AppService, AppService, [LOGGER])),
      ],
    };

    const container = createContainer(moduleRef);
    const appService = container.resolve(AppService);
    expect(appService.logger).toBeInstanceOf(TestLogger);
  });

  test("returns same instance for singleton", () => {
    CounterService.created = 0;
    const moduleRef: OsnovaModuleRef = {
      providers: [DI.singleton(DI.classProvider(CounterService, CounterService))],
    };

    const container = createContainer(moduleRef);
    const first = container.resolve(CounterService);
    const second = container.resolve(CounterService);
    expect(first).toBe(second);
    expect(first.id).toBe(1);
  });

  test("returns different instances for transient", () => {
    CounterService.created = 0;
    const moduleRef: OsnovaModuleRef = {
      providers: [DI.transient(DI.classProvider(CounterService, CounterService))],
    };

    const container = createContainer(moduleRef);
    const first = container.resolve(CounterService);
    const second = container.resolve(CounterService);
    expect(first).not.toBe(second);
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  test("supports one-argument scoped and transient sugars", () => {
    class ScopedCounter {
      static created = 0;
      id: number;

      constructor() {
        ScopedCounter.created += 1;
        this.id = ScopedCounter.created;
      }
    }

    class TransientCounter {
      static created = 0;
      id: number;

      constructor() {
        TransientCounter.created += 1;
        this.id = TransientCounter.created;
      }
    }

    const moduleRef: OsnovaModuleRef = {
      providers: [scoped(ScopedCounter), transient(TransientCounter)],
    };

    const container = createContainer(moduleRef);
    const scope = container.createScope();
    const scopedA = scope.resolve(ScopedCounter);
    const scopedB = scope.resolve(ScopedCounter);
    const transientA = scope.resolve(TransientCounter);
    const transientB = scope.resolve(TransientCounter);
    expect(scopedA).toBe(scopedB);
    expect(transientA).not.toBe(transientB);
  });

  test("supports scoped lifetime via scope", () => {
    CounterService.created = 0;
    const moduleRef: OsnovaModuleRef = {
      providers: [DI.scoped(DI.classProvider(CounterService, CounterService))],
    };

    const container = createContainer(moduleRef);
    const scopeA = container.createScope();
    const scopeB = container.createScope();
    const a1 = scopeA.resolve(CounterService);
    const a2 = scopeA.resolve(CounterService);
    const b1 = scopeB.resolve(CounterService);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  test("supports module configure registration", () => {
    const moduleRef: OsnovaModuleRef = {
      configure(di: DiRegistrar) {
        di.trySingleton(DI.classProvider(LOGGER, TestLogger));
      },
    };

    const container = createContainer(moduleRef);
    expect(container.resolve(LOGGER)).toBeInstanceOf(TestLogger);
  });

  test("throws when provider missing", () => {
    const container = createContainer({ providers: [] });
    expect(() => container.resolve(LOGGER)).toThrow(ProviderNotFoundError);
  });

  test("supports class deps binding without module deps", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(DI.classProvider(BoundDepsAppService, BoundDepsAppService)),
      ],
    };

    const container = createContainer(moduleRef);
    expect(container.resolve(BoundDepsAppService).logger).toBeInstanceOf(TestLogger);
  });

  test("supports one-argument singleton sugar", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [singleton(LOGGER, TestLogger), singleton(SugarAppService)],
    };

    const container = createContainer(moduleRef);
    expect(container.resolve(SugarAppService).logger).toBeInstanceOf(TestLogger);
  });

  test("class-provider hooks apply to singleton(Class) even when registered after definition creation", () => {
    class LateHookService {
      public readonly source: string = "original";
    }
    class HookedService extends LateHookService {
      public override readonly source = "hooked";
    }

    const definition = singleton(LateHookService);
    registerClassProviderHook((request) =>
      request.useClass === LateHookService
        ? DI.singleton(DI.classProvider(request.provide, HookedService))
        : undefined,
    );

    const container = createContainer({ providers: [definition] });
    expect(container.resolve(LateHookService).source).toBe("hooked");
  });

  test("throws when class constructor deps are not declared", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(DI.classProvider(MissingDepsAppService, MissingDepsAppService)),
      ],
    };

    const container = createContainer(moduleRef);
    expect(() => container.resolve(MissingDepsAppService)).toThrow(ClassDependenciesMismatchError);
  });

  test("supports factory with service resolver", () => {
    const RESOLVER_MESSAGE = createToken<string>("ResolverMessage");
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(RESOLVER_MESSAGE, "ok")),
        DI.singleton(
          DI.factoryProviderWithResolver(LOGGER, [], (resolver: ServiceResolver) => ({
            log() {
              expect(resolver.resolve(RESOLVER_MESSAGE)).toBe("ok");
            },
          })),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    container.resolve(LOGGER).log("ignored");
  });

  test("supports factory without resolver argument", () => {
    const VALUE_TOKEN = createToken<number>("FactoryValue");
    const moduleRef: OsnovaModuleRef = {
      providers: [DI.singleton(DI.factoryProvider(VALUE_TOKEN, [], () => 123))],
    };

    const container = createContainer(moduleRef);
    expect(container.resolve(VALUE_TOKEN)).toBe(123);
  });

  test("factory resolver respects originating scope", () => {
    class ScopedValue {
      public static created = 0;

      public constructor() {
        ScopedValue.created += 1;
      }
    }

    const FROM_FACTORY = createToken<ScopedValue>("FromFactory");
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(ScopedValue, ScopedValue)),
        DI.scoped(
          DI.factoryProviderWithResolver(FROM_FACTORY, [], (resolver: ServiceResolver) =>
            resolver.resolve(ScopedValue),
          ),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    const scope = container.createScope();
    expect(scope.resolve(FROM_FACTORY)).toBe(scope.resolve(ScopedValue));
  });

  test("tryResolve returns undefined for missing provider and has reports registration", () => {
    const MISSING = createToken<string>("Missing");
    const moduleRef: OsnovaModuleRef = {
      providers: [singleton(LOGGER, TestLogger)],
    };

    const container = createContainer(moduleRef);
    expect(container.tryResolve(MISSING)).toBeUndefined();
    expect(container.tryResolve(LOGGER)).toBeInstanceOf(TestLogger);
    expect(container.has(LOGGER)).toBe(true);
    expect(container.has(MISSING)).toBe(false);
  });

  test("ProviderNotFoundError includes the resolution path", () => {
    const MISSING_DEP = createToken<string>("MissingDep");
    class NeedsMissing {
      public constructor(public readonly value: string) {}
    }

    const moduleRef: OsnovaModuleRef = {
      providers: [DI.singleton(DI.classProvider(NeedsMissing, NeedsMissing, [MISSING_DEP]))],
    };

    const container = createContainer(moduleRef);
    expect(() => container.resolve(NeedsMissing)).toThrow(
      'Resolution path: NeedsMissing -> MissingDep',
    );
  });

  test("throws on ambiguous named dependency", () => {
    const FIRST = createToken<string>("DuplicateName");
    const SECOND = createToken<string>("DuplicateName");

    class NamedConsumer {
      public constructor(public readonly value: string) {}
    }

    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(FIRST, "first")),
        DI.singleton(DI.valueProvider(SECOND, "second")),
        DI.singleton(
          DI.classProvider(NamedConsumer, NamedConsumer, [namedDependency<string>("DuplicateName")]),
        ),
      ],
    };

    // Two visible tokens share a name within the same module — caught fail-fast
    // at build time instead of on first resolve.
    expect(() => createContainer(moduleRef)).toThrow(AmbiguousNamedDependencyError);
  });

  test("registers controllers from OsnovaModule.controllers as scoped", () => {
    class ApiController {
      public readonly id = Math.random();
    }

    const moduleRef: OsnovaModuleRef = {
      controllers: [ApiController],
    };

    const container = createContainer(moduleRef);
    const scope1 = container.createScope();
    const scope2 = container.createScope();
    const firstInScope1 = scope1.resolve(ApiController);
    const secondInScope1 = scope1.resolve(ApiController);
    const inScope2 = scope2.resolve(ApiController);

    expect(firstInScope1).toBe(secondInScope1);
    expect(firstInScope1.id).not.toBe(inScope2.id);
  });

  test("collectModuleControllers gathers controllers from module imports", () => {
    class UsersController {}
    class PostsController {}

    const usersModule: OsnovaModuleRef = {
      controllers: [UsersController],
    };
    const appModule: OsnovaModuleRef = {
      imports: [usersModule],
      controllers: [PostsController],
    };

    expect(collectModuleControllers([appModule])).toEqual([UsersController, PostsController]);
  });
});
