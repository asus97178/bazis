import { describe, expect, test } from "bun:test";
import { AmbiguousNamedDependencyError, DI, createContainer, createToken } from "../index";
import { namedDependency } from "../provider";
import { testModule } from "./test-fixtures";

interface IRepo {
  readonly tag: string;
}

describe("DI module-scoped named dependencies", () => {
  test("two modules can reuse the same token name; resolution is module-scoped", () => {
    const REPO_A = createToken<IRepo>("IRepo");
    const REPO_B = createToken<IRepo>("IRepo");

    class ServiceA {
      public constructor(public readonly repo: IRepo) {}
    }
    class ServiceB {
      public constructor(public readonly repo: IRepo) {}
    }
    const SERVICE_A = createToken<ServiceA>("ServiceA");
    const SERVICE_B = createToken<ServiceB>("ServiceB");

    const moduleA = testModule("ModuleA", {
      providers: [
        DI.singleton(DI.valueProvider(REPO_A, { tag: "A" })),
        DI.singleton(DI.classProvider(SERVICE_A, ServiceA, [namedDependency<IRepo>("IRepo")] as const)),
      ],
      exports: [SERVICE_A],
    });
    const moduleB = testModule("ModuleB", {
      providers: [
        DI.singleton(DI.valueProvider(REPO_B, { tag: "B" })),
        DI.singleton(DI.classProvider(SERVICE_B, ServiceB, [namedDependency<IRepo>("IRepo")] as const)),
      ],
      exports: [SERVICE_B],
    });
    const appModule = testModule("AppModule", { imports: [moduleA, moduleB], providers: [] });

    const container = createContainer(appModule);

    // Each module's consumer binds to its own "IRepo", despite the name clash.
    expect(container.resolve(SERVICE_A).repo.tag).toBe("A");
    expect(container.resolve(SERVICE_B).repo.tag).toBe("B");
  });

  test("flat default: an unimported sibling token still resolves via global fallback", () => {
    interface Logger {
      readonly id: string;
    }
    const LOG = createToken<Logger>("FlatLogger");

    class Consumer {
      public constructor(public readonly log: Logger) {}
    }
    const CONSUMER = createToken<Consumer>("FlatConsumer");

    // Open modules (no `exports`): the legacy flat graph where a service may
    // depend on a sibling's token without importing it.
    const loggerModule = testModule("LoggerModule", {
      providers: [DI.singleton(DI.valueProvider(LOG, { id: "L" }))],
    });
    const consumerModule = testModule("ConsumerModule", {
      providers: [
        DI.singleton(DI.classProvider(Consumer, Consumer, [namedDependency<Logger>("FlatLogger")] as const)),
      ],
    });
    const appModule = testModule("AppModule", {
      imports: [loggerModule, consumerModule],
      providers: [],
    });

    const container = createContainer(appModule);
    expect(container.resolve(Consumer).log.id).toBe("L");
  });

  test("ambiguity within a single module's visibility fails fast at build time", () => {
    const FIRST = createToken<IRepo>("ClashRepo");
    const SECOND = createToken<IRepo>("ClashRepo");

    class Consumer {
      public constructor(public readonly repo: IRepo) {}
    }

    const appModule = testModule("AppModule", {
      providers: [
        DI.singleton(DI.valueProvider(FIRST, { tag: "1" })),
        DI.singleton(DI.valueProvider(SECOND, { tag: "2" })),
        DI.singleton(DI.classProvider(Consumer, Consumer, [namedDependency<IRepo>("ClashRepo")] as const)),
      ],
    });

    expect(() => createContainer(appModule)).toThrow(AmbiguousNamedDependencyError);
  });
});
