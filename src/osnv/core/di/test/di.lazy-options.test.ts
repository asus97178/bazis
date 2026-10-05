import { describe, expect, test } from "bun:test";
import {
  DI,
  OptionsValidationError,
  ScopeDisposedError,
  ScopedServiceFromRootError,
  ServiceCollection,
  ServiceValidationError,
  addValidatedOptions,
  createContainer,
  createOptionsToken,
  createToken,
  lazyDependency,
  validateOptionsOnStart,
  type Lazy,
  type OsnvModuleRef,
} from "../index";

class Heavy {
  public static created = 0;
  public constructor() {
    Heavy.created += 1;
  }
  public work(): string {
    return "done";
  }
}

class NeedsHeavyLazily {
  public constructor(public readonly heavy: Lazy<Heavy>) {}
}

describe("DI Lazy<T>", () => {
  test("lazy dependency is created on first .value access and cached", () => {
    Heavy.created = 0;
    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(Heavy, Heavy)),
        DI.singleton(DI.classProvider(NeedsHeavyLazily, NeedsHeavyLazily, [lazyDependency(Heavy)] as const)),
      ],
    };

    const container = createContainer(moduleRef);
    const consumer = container.resolve(NeedsHeavyLazily);
    expect(Heavy.created).toBe(0);
    expect(consumer.heavy.isCreated).toBe(false);

    expect(consumer.heavy.value.work()).toBe("done");
    expect(Heavy.created).toBe(1);
    expect(consumer.heavy.isCreated).toBe(true);

    // Repeated access returns the memoized instance.
    expect(consumer.heavy.value).toBe(consumer.heavy.value);
    expect(Heavy.created).toBe(1);
  });

  test("lazy breaks a circular dependency", () => {
    interface IA {
      readonly b: Lazy<IB>;
    }
    interface IB {
      readonly a: IA;
    }
    const A = createToken<IA>("LazyCycleA");
    const B = createToken<IB>("LazyCycleB");

    class ServiceA implements IA {
      public constructor(public readonly b: Lazy<IB>) {}
    }
    class ServiceB implements IB {
      public constructor(public readonly a: IA) {}
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(A, ServiceA, [lazyDependency(B)] as const)),
        DI.singleton(DI.classProvider(B, ServiceB, [A] as const)),
      ],
    };

    const container = createContainer(moduleRef, { validateOnBuild: true });
    const a = container.resolve(A);
    expect(a.b.value.a).toBe(a);
  });

  test("validateOnBuild still reports a missing lazy dependency", () => {
    const MISSING = createToken<Heavy>("LazyMissing");
    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(NeedsHeavyLazily, NeedsHeavyLazily, [lazyDependency(MISSING)] as const)),
      ],
    };

    expect(() => createContainer(moduleRef, { validateOnBuild: true })).toThrow(ServiceValidationError);
    expect(() => createContainer(moduleRef, { validateOnBuild: true })).toThrow(/LazyMissing/);
  });

  test("lazy access from singleton to scoped service still throws", () => {
    class ScopedThing {}
    const SCOPED = createToken<ScopedThing>("LazyScopedThing");
    class SingletonHolder {
      public constructor(public readonly scopedThing: Lazy<ScopedThing>) {}
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(SCOPED, ScopedThing)),
        DI.singleton(DI.classProvider(SingletonHolder, SingletonHolder, [lazyDependency(SCOPED)] as const)),
      ],
    };

    const container = createContainer(moduleRef);
    const holder = container.resolve(SingletonHolder);
    expect(() => holder.scopedThing.value).toThrow(ScopedServiceFromRootError);
  });

  test("lazy from scope resolves scoped instance of that scope", () => {
    class PerRequest {}
    const PER_REQUEST = createToken<PerRequest>("LazyPerRequest");
    class Handler {
      public constructor(public readonly perRequest: Lazy<PerRequest>) {}
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(PER_REQUEST, PerRequest)),
        DI.scoped(DI.classProvider(Handler, Handler, [lazyDependency(PER_REQUEST)] as const)),
      ],
    };

    const container = createContainer(moduleRef);
    const scope = container.createScope();
    const handler = scope.resolve(Handler);
    expect(handler.perRequest.value).toBe(scope.resolve(PER_REQUEST));
  });

  test("lazy access after scope disposal throws ScopeDisposedError", async () => {
    class PerRequest {}
    const PER_REQUEST = createToken<PerRequest>("LazyDisposedPerRequest");
    class Handler {
      public constructor(public readonly perRequest: Lazy<PerRequest>) {}
    }

    const moduleRef: OsnvModuleRef = {
      providers: [
        DI.scoped(DI.classProvider(PER_REQUEST, PerRequest)),
        DI.scoped(DI.classProvider(Handler, Handler, [lazyDependency(PER_REQUEST)] as const)),
      ],
    };

    const container = createContainer(moduleRef);
    const scope = container.createScope();
    const handler = scope.resolve(Handler);
    await scope.dispose();
    expect(() => handler.perRequest.value).toThrow(ScopeDisposedError);
  });
});

describe("DI validated options", () => {
  interface SmtpOptions {
    host: string;
    port: number;
  }

  function buildSmtp(host: string, port: number) {
    const SMTP = createOptionsToken<SmtpOptions>("Smtp");
    const services = new ServiceCollection();
    addValidatedOptions(services, SMTP, {
      load: () => ({ host, port }),
      validate: (o) => {
        const issues: string[] = [];
        if (!o.host) issues.push("host is required");
        if (!Number.isInteger(o.port) || o.port <= 0) issues.push("port must be a positive integer");
        return issues;
      },
    });
    return { SMTP, services };
  }

  test("valid options resolve and are cached as singleton", () => {
    const { SMTP, services } = buildSmtp("smtp.local", 25);
    const provider = services.buildServiceProvider();
    const first = provider.resolve(SMTP);
    expect(first.value).toEqual({ host: "smtp.local", port: 25 });
    expect(provider.resolve(SMTP)).toBe(first);
  });

  test("invalid options throw OptionsValidationError with all issues", () => {
    const { SMTP, services } = buildSmtp("", 0);
    const provider = services.buildServiceProvider();
    expect(() => provider.resolve(SMTP)).toThrow(OptionsValidationError);
    try {
      provider.resolve(SMTP);
      throw new Error("unreachable");
    } catch (error) {
      const validationError = error as OptionsValidationError;
      expect(validationError.issues).toHaveLength(2);
      expect(validationError.issues[0]).toContain("IOptions<Smtp>");
    }
  });

  test("validateOptionsOnStart aggregates issues from multiple options", () => {
    const services = new ServiceCollection();
    const SMTP = createOptionsToken<SmtpOptions>("Smtp");
    const DB = createOptionsToken<{ url: string }>("Db");
    addValidatedOptions(services, SMTP, {
      load: () => ({ host: "", port: -1 }),
      validate: (o) => {
        const issues: string[] = [];
        if (!o.host) issues.push("host is required");
        if (o.port <= 0) issues.push("port must be positive");
        return issues;
      },
    });
    addValidatedOptions(services, DB, {
      load: () => ({ url: "" }),
      validate: (o) => (o.url ? [] : ["url is required"]),
    });

    const provider = services.buildServiceProvider();
    try {
      validateOptionsOnStart(provider);
      throw new Error("unreachable");
    } catch (error) {
      const validationError = error as OptionsValidationError;
      expect(validationError).toBeInstanceOf(OptionsValidationError);
      expect(validationError.issues).toHaveLength(3);
      expect(validationError.issues.join("\n")).toContain("IOptions<Db>: url is required");
    }
  });

  test("validateOptionsOnStart passes when all options are valid", () => {
    const { services } = buildSmtp("smtp.local", 25);
    const provider = services.buildServiceProvider();
    expect(() => validateOptionsOnStart(provider)).not.toThrow();
  });

  test("Application.start fails fast on invalid options and disposes the host", async () => {
    const { Application } = await import("../extensions");
    const { services } = buildSmtp("", 1);
    const provider = services.buildServiceProvider();

    let disposed = false;
    const originalDispose = provider.dispose.bind(provider);
    provider.dispose = async () => {
      disposed = true;
      await originalDispose();
    };

    await expect(Application.start(provider)).rejects.toThrow(OptionsValidationError);
    expect(disposed).toBe(true);
  });
});
