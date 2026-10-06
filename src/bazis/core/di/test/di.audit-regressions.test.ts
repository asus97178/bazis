import { describe, expect, test } from "bun:test";
import {
  Application,
  CircularDependencyError,
  DI,
  HOSTED_SERVICE,
  ProviderDefinition,
  ScopeDisposedError,
  ServiceCollection,
  createContainer,
  createOpenGenericTokenFamily,
  createToken,
  lazyDependency,
  type Lazy,
} from "../index";

describe("DI regressions", () => {
  test.each(["scope", "root"] as const)("cached Lazy rejects access after %s disposal", async (disposedOwner) => {
    class Resource {
      disposed = false;
      dispose() { this.disposed = true; }
    }
    class Consumer {
      constructor(readonly resource: Lazy<Resource>) {}
    }
    const provider = createContainer({ providers: [
      DI.scoped(DI.classProvider(Resource, Resource)),
      DI.scoped(DI.classProvider(Consumer, Consumer, [lazyDependency(Resource)])),
    ] });
    const scope = provider.createScope();
    try {
      const lazy = scope.resolve(Consumer).resource;
      const instance = lazy.value;
      expect(lazy.value).toBe(instance);
      await (disposedOwner === "scope" ? scope : provider).dispose();
      expect(instance.disposed).toBe(true);
      expect(lazy.isCreated).toBe(true);
      expect(() => lazy.value).toThrow(ScopeDisposedError);
    } finally {
      await provider.dispose();
    }
  });

  test.each(["sync", "async"] as const)("eager Lazy access reports a cycle during %s resolution and permits retry", async (mode) => {
    interface A { readonly b: Lazy<B> }
    interface B { readonly a: A }
    const A = createToken<A>("EagerLazyA");
    const B = createToken<B>("EagerLazyB");
    let eager = true;
    class ServiceA implements A {
      constructor(readonly b: Lazy<B>) {
        if (eager) void b.value;
      }
    }
    class ServiceB implements B {
      constructor(readonly a: A) {}
    }
    const provider = createContainer({ providers: [
      DI.singleton(DI.classProvider(A, ServiceA, [lazyDependency(B)])),
      DI.singleton(DI.classProvider(B, ServiceB, [A])),
    ] }, { validateOnBuild: true });
    try {
      if (mode === "sync") {
        expect(() => provider.resolve(A)).toThrow(CircularDependencyError);
      } else {
        await expect(provider.resolveAsync(A)).rejects.toBeInstanceOf(CircularDependencyError);
      }
      eager = false;
      const a = mode === "sync" ? provider.resolve(A) : await provider.resolveAsync(A);
      expect(a.b.isCreated).toBe(false);
      expect(a.b.value.a).toBe(a);
      expect(a.b.isCreated).toBe(true);
    } finally {
      await provider.dispose();
    }
  });

  for (const validateOnBuild of [false, true]) {
    test.each([undefined, "blue"])(`explicit generic singleton stays selected after enumeration (validateOnBuild=${validateOnBuild}, key=%s)`, async (key) => {
      const ARG = createToken<object>("StableGenericArg");
      const FAMILY = createOpenGenericTokenFamily<unknown, { source: string }>("StableGeneric");
      const token = FAMILY.of(ARG);
      const services = new ServiceCollection();
      services.addSingleton(DI.valueProvider(ARG, {}));
      for (const source of ["explicit-old", "explicit"]) {
        services.add(new ProviderDefinition({ provide: token, deps: [], useFactory: () => ({ source }) }, "singleton", key));
      }
      for (const source of ["generic-first", "generic-last"]) {
        services.addOpenGeneric(FAMILY, "singleton", argument => ({
          provide: FAMILY.of(argument), deps: [], useFactory: () => ({ source }),
        }), key);
      }
      const provider = services.buildServiceProvider({ validateOnBuild });
      try {
        const first = key === undefined ? provider.resolve(token) : provider.resolveKeyed(token, key);
        expect(first.source).toBe("explicit");
        const all = key === undefined ? provider.resolveAll(token) : provider.resolveAllKeyed(token, key);
        expect(all.map(value => value.source)).toEqual(["explicit-old", "explicit", "generic-first", "generic-last"]);
        expect(all[1]).toBe(first);
        expect(provider.tryResolve(token, key)).toBe(first);
        expect(key === undefined ? provider.resolve(token) : provider.resolveKeyed(token, key)).toBe(first);
        expect(await (key === undefined ? provider.resolveAsync(token) : provider.resolveKeyedAsync(token, key))).toBe(first);
      } finally {
        await provider.dispose();
      }
    });
  }

  test("a retained Lazy drops its settled owner even while an ancestor is constructing", async () => {
    interface A { readonly b: B }
    interface B { readonly a: Lazy<A> }
    const A = createToken<A>("RetainedLazyAncestor");
    const B = createToken<B>("RetainedLazyOwner");
    let created = 0;
    class ServiceA implements A {
      constructor(readonly b: B) {
        created += 1;
        if (created === 1) void b.a.value;
      }
    }
    class ServiceB implements B {
      constructor(readonly a: Lazy<A>) {}
    }
    const container = createContainer({ providers: [
      DI.transient(DI.classProvider(A, ServiceA, [B])),
      DI.transient(DI.classProvider(B, ServiceB, [lazyDependency(A)])),
    ] });
    try {
      const first = container.resolve(A);
      expect(first.b.a.value).not.toBe(first);
      expect(created).toBe(2);
    } finally {
      await container.dispose();
    }
  });

  test("tryAddEnumerable deduplicates async factory identity per token and key", () => {
    const TOKEN = createToken<object>("AsyncEnumerable");
    const OTHER = createToken<object>("OtherAsyncEnumerable");
    const factory = async () => ({});
    const services = new ServiceCollection();
    const provider = { provide: TOKEN, deps: [] as const, useAsyncFactory: factory };
    expect(services.tryAddEnumerable(DI.singleton(provider))).toBe(true);
    expect(services.tryAddEnumerable(DI.singleton({ ...provider }))).toBe(false);
    expect(services.tryAddEnumerable(DI.keyedSingleton("blue", provider))).toBe(true);
    expect(services.tryAddEnumerable(DI.keyedSingleton("blue", { ...provider }))).toBe(false);
    expect(services.tryAddEnumerable(DI.singleton({ ...provider, useAsyncFactory: async () => ({}) }))).toBe(true);
    expect(services.tryAddEnumerable(DI.singleton({ ...provider, provide: OTHER }))).toBe(true);
    expect(services.size).toBe(4);
  });

  test.each([false, true])("concurrent Application.stop callers share completion and errors (failure=%s)", async (fail) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("hosted stop failed");
    let stopCalls = 0;
    let disposeCalls = 0;
    const services = new ServiceCollection();
    services.addSingleton(DI.factoryProvider(HOSTED_SERVICE, [], () => ({
      start() {},
      async stop() {
        stopCalls += 1;
        entered.resolve();
        await release.promise;
        if (fail) throw failure;
      },
      dispose() { disposeCalls += 1; },
    })));
    const application = await Application.start(services.buildServiceProvider());
    const first = application.stop();
    await entered.promise;
    const second = application.stop();
    let secondFinished = false;
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    await Promise.resolve();
    const premature = secondFinished;
    const outcomes = Promise.allSettled([first, second]);
    release.resolve();
    const results = await outcomes;
    expect(premature).toBe(false);
    expect(first).toBe(second);
    expect(stopCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    for (const result of results) {
      if (fail) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toBe(failure);
      } else {
        expect(result.status).toBe("fulfilled");
      }
    }
    expect(application.stop()).toBe(first);
  });
});
