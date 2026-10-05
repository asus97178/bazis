import { describe, expect, test } from "bun:test";
import {
  CircularDependencyError,
  DI,
  ScopedServiceFromRootError,
  ServiceCollection,
  ServiceValidationError,
  createContainer,
  createOpenGenericTokenFamily,
  createToken,
  type OsnvModuleRef,
  type ServiceResolver,
} from "../index";
import {
  AppService,
  CounterService,
  LOGGER,
  MissingDepsAppService,
  TestLogger,
  tokenToName,
} from "./test-fixtures";

describe("DI validation and open generic", () => {
  test("throws on circular dependencies", () => {
    const TOKEN_A = createToken<{ b: unknown }>("A");
    const TOKEN_B = createToken<{ a: unknown }>("B");

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.singleton(DI.factoryProvider(TOKEN_A, [TOKEN_B], (b: { a: unknown }) => ({ b }))),
        DI.singleton(DI.factoryProvider(TOKEN_B, [TOKEN_A], (a: { b: unknown }) => ({ a }))),
      ],
    };

    const container = createContainer(moduleRef);
    expect(() => container.resolve(TOKEN_A)).toThrow(CircularDependencyError);
  });

  test("throws for scoped resolution from root", () => {
    const moduleRef: OsnvModuleRef = {
      providers: [DI.scoped(DI.classProvider(CounterService, CounterService))],
    };

    const container = createContainer(moduleRef);
    expect(() => container.resolve(CounterService)).toThrow(ScopedServiceFromRootError);
  });

  test("validates singleton->scoped chain on build", () => {
    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(DI.classProvider(AppService, AppService, [LOGGER])),
      ],
    };

    expect(() => createContainer(moduleRef, { validateOnBuild: true })).toThrow(
      ServiceValidationError,
    );
  });

  test("open generic of() is canonical and keeps singleton identity", () => {
    const OPEN_REPO = createOpenGenericTokenFamily<unknown, { n: number }>("IRepository");
    const ENTITY_A = createToken<{ id: string }>("EntityA");

    let created = 0;
    const services = new ServiceCollection();
    services.addOpenGeneric(OPEN_REPO, "singleton", (argument) => ({
      provide: OPEN_REPO.of(argument),
      useFactory: () => ({ n: (created += 1) }),
      deps: [],
    }));

    expect(OPEN_REPO.of(ENTITY_A)).toBe(OPEN_REPO.of(ENTITY_A));

    const provider = services.buildServiceProvider();
    const first = provider.resolve(OPEN_REPO.of(ENTITY_A));
    const second = provider.resolve(OPEN_REPO.of(ENTITY_A));
    expect(first).toBe(second);
    expect(created).toBe(1);
  });

  test("supports open generic registrations", () => {
    const OPEN_REPO = createOpenGenericTokenFamily<unknown, { type: string }>("IRepository");
    const ENTITY_A = createToken<{ id: string }>("EntityA");

    const services = new ServiceCollection();
    services.addOpenGeneric(OPEN_REPO, "singleton", (argument) => ({
      provide: OPEN_REPO.of(argument),
      useFactory: () => ({ type: `repo:${String(tokenToName(argument))}` }),
      deps: [],
    }));

    const provider = services.buildServiceProvider();
    const repo = provider.resolve(OPEN_REPO.of(ENTITY_A));
    expect(repo.type).toContain("EntityA");
  });

  test("open generic materialization publishes no partial batch after failure", () => {
    const FAMILY = createOpenGenericTokenFamily<unknown, string>("AtomicGeneric");
    const ARG = createToken<object>("AtomicGenericArg");
    let attempts = 0;
    const services = new ServiceCollection();
    services.addOpenGeneric(FAMILY, "singleton", (argument) => ({ provide: FAMILY.of(argument), useFactory: () => "first", deps: [] }));
    services.addOpenGeneric(FAMILY, "singleton", (argument) => {
      attempts += 1;
      if (attempts === 1) throw new Error("materialize once");
      return { provide: FAMILY.of(argument), useFactory: () => "second", deps: [] };
    });
    const provider = services.buildServiceProvider();
    expect(() => provider.resolveAll(FAMILY.of(ARG))).toThrow("materialize once");
    expect(provider.resolveAll(FAMILY.of(ARG))).toEqual(["first", "second"]);
    expect(attempts).toBe(2);
  });

  test("eagerly validates open generic dependencies on build", () => {
    const OPEN_REPO = createOpenGenericTokenFamily<unknown, { required: unknown }>("IRepository");
    const ENTITY_A = createToken<{ id: string }>("EntityA");
    const MISSING_DEP = createToken<string>("MissingDep");

    const services = new ServiceCollection();
    services.addSingleton({
      provide: ENTITY_A,
      useValue: { id: "1" },
    });
    services.addOpenGeneric(OPEN_REPO, "singleton", (argument) => ({
      provide: OPEN_REPO.of(argument),
      useFactory: (_resolver: ServiceResolver, missing: unknown) => ({ required: missing }),
      deps: [MISSING_DEP],
      withResolver: true,
    }));

    expect(() => services.buildServiceProvider({ validateOnBuild: true })).toThrow(
      ServiceValidationError,
    );
  });

  test("validateOnBuild catches class deps mismatch without resolve", () => {
    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(DI.classProvider(MissingDepsAppService, MissingDepsAppService)),
      ],
    };

    expect(() => createContainer(moduleRef, { validateOnBuild: true })).toThrow(
      ServiceValidationError,
    );
  });
});
