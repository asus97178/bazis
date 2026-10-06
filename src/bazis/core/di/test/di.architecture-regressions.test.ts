import { afterEach, describe, expect, test } from "bun:test";
import {
  DI, Module, ModuleEncapsulationError, SERVICE_PROVIDER, ServiceCollection, ServiceProvider, createContainer,
  createOpenGenericTokenFamily, createToken, lazyDependency, namedDependency,
  singleton, singletonValue, type Lazy, type BazisModuleRef,
} from "../index";
import { registerGeneratedClassDeps, restoreGeneratedClassDeps, snapshotGeneratedClassDeps } from "../module/autoDeps";

const originalDeps = snapshotGeneratedClassDeps();
afterEach(() => restoreGeneratedClassDeps(originalDeps));

describe("architecture: generated constructor identity", () => {
  test("an independent UserService does not inherit application metadata", async () => {
    class UserService { get() { return "independent"; } }
    const container = createContainer({ providers: [singleton(UserService)] }, { validateOnBuild: true });
    expect(container.resolve(UserService).get()).toBe("independent");
    await container.dispose();
  });

  test.each(["module", "collection"])("binds late data and honours bound/explicit deps: %s", async (mode) => {
    const old = createToken<string>("OldGeneratedValue");
    const current = createToken<string>("CurrentGeneratedValue");
    const bound = createToken<string>("BoundValue");
    class Service { constructor(readonly value: string) {} }
    registerGeneratedClassDeps(Service, ["OldGeneratedValue"]);
    const definition = singleton(Service);
    registerGeneratedClassDeps(Service, ["CurrentGeneratedValue"]);
    const build = () => {
      const definitions = [singletonValue(old, "old"), singletonValue(current, "current"), singletonValue(bound, "bound"), definition];
      return mode === "module"
        ? createContainer({ providers: definitions }, { validateOnBuild: true })
        : new ServiceCollection().addMany(definitions).buildServiceProvider({ validateOnBuild: true });
    };
    const generated = build();
    expect(generated.resolve(Service).value).toBe("current");
    await generated.dispose();
    DI.bindDeps(Service, bound);
    const overridden = build();
    expect(overridden.resolve(Service).value).toBe("bound");
    await overridden.dispose();
    const explicit = createContainer({ providers: [singletonValue(old, "explicit"), singleton(Service, Service, [old])] });
    expect(explicit.resolve(Service).value).toBe("explicit");
    await explicit.dispose();
  });

  test("an empty late descriptor overrides stale data for the same constructor", async () => {
    class Service {}
    registerGeneratedClassDeps(Service, ["ObsoleteDependency"]);
    const definition = singleton(Service);
    registerGeneratedClassDeps(Service, []);
    const container = createContainer({ providers: [definition] }, { validateOnBuild: true });
    expect(container.resolve(Service)).toBeInstanceOf(Service);
    await container.dispose();
  });
});

describe("architecture: injectable ServiceProvider identity", () => {
  test.each(["class", "named", "lazy-class", "lazy-named"] as const)("closed modules receive the root provider through %s dependencies", async (mode) => {
    class Consumer { constructor(readonly provider: ServiceProvider | Lazy<ServiceProvider>) {} }
    const dependency = mode === "class" ? ServiceProvider
      : mode === "named" ? "ServiceProvider"
      : mode === "lazy-class" ? lazyDependency(ServiceProvider) : "lazy:ServiceProvider";
    registerGeneratedClassDeps(Consumer, [dependency]);
    @Module({ providers: [singleton(Consumer)], exports: [] })
    class ClosedModule {}
    const container = createContainer({ imports: [ClosedModule] }, { validateOnBuild: true });
    const scope = container.createScope();
    try {
      const consumer = scope.resolve(Consumer);
      const received = mode.startsWith("lazy-") ? (consumer.provider as Lazy<ServiceProvider>).value : consumer.provider;
      expect(received).toBe(container);
      expect(container.resolve(SERVICE_PROVIDER)).toBe(container);
      expect(container.resolve(ServiceProvider)).toBe(container);
      expect(scope.resolve(SERVICE_PROVIDER)).toBe(container);
      expect(scope.resolve(ServiceProvider)).toBe(container);
    } finally {
      await scope.dispose();
      await container.dispose();
    }
  });

  test("a foreign ServiceProvider class keeps its own identity", async () => {
    const ForeignProvider = class ServiceProvider { readonly marker = "foreign"; };
    class Consumer { constructor(readonly provider: InstanceType<typeof ForeignProvider>) {} }
    registerGeneratedClassDeps(Consumer, [ForeignProvider]);
    expect(() => createContainer({ providers: [singleton(Consumer)] }, { validateOnBuild: true }))
      .toThrow('Missing dependency "ServiceProvider"');
    @Module({ providers: [singleton(ForeignProvider), singleton(Consumer)], exports: [] })
    class ClosedModule {}
    const container = createContainer({ imports: [ClosedModule] }, { validateOnBuild: true });
    try {
      expect(container.resolve(Consumer).provider).toBe(container.resolve(ForeignProvider));
      expect(container.resolve(Consumer).provider.marker).toBe("foreign");
      expect(container.resolve(ServiceProvider)).toBe(container);
    } finally { await container.dispose(); }
  });

  test("canonical and public provider tokens do not recursively dispose the root", async () => {
    class Resource {
      disposals = 0;
      dispose() { this.disposals++; }
    }
    const container = createContainer({ providers: [singleton(Resource)] }, { validateOnBuild: true });
    const resource = container.resolve(Resource);
    try {
      expect(container.resolve(ServiceProvider)).toBe(container);
      expect(container.resolve(SERVICE_PROVIDER)).toBe(container);
      const stopping = container.dispose();
      expect(container.dispose()).toBe(stopping);
      await stopping;
      expect(resource.disposals).toBe(1);
    } finally { await container.dispose(); }
  });
});

describe("architecture: module graph and selected provider", () => {
  test("rejects import cycles, accepts a shared diamond", async () => {
    @Module({ exports: [] }) class A { static imports: BazisModuleRef[] = []; }
    @Module({ imports: [A], exports: [] }) class B {}
    A.imports.push(B);
    expect(() => createContainer(A)).toThrow("A -> B -> A");
    A.imports.length = 0;
    const container = createContainer({ imports: [A, B, A] }, { validateOnBuild: true });
    await container.dispose();
    A.imports.push(A);
    expect(() => createContainer(A)).toThrow("A -> A");
  });

  test.each(["direct", "keyed", "named", "lazy"] as const)("rejects a private last provider: %s", (kind) => {
    const token = createToken<string>("VisibleValue");
    const consumer = createToken<unknown>("Consumer");
    const key = kind === "keyed" ? "blue" : undefined;
    const visible: BazisModuleRef = { providers: [DI.keyedSingleton(key!, DI.valueProvider(token, "public"))], exports: [token] };
    const hidden: BazisModuleRef = { providers: [DI.keyedSingleton(key!, DI.valueProvider(token, "private"))], exports: [] };
    const dep = kind === "keyed" ? DI.keyed(token, "blue")
      : kind === "named" ? namedDependency("VisibleValue") : kind === "lazy" ? lazyDependency(token) : token;
    const owner: BazisModuleRef = { imports: [visible], providers: [DI.singleton(DI.factoryProvider(consumer, [dep], value => value))], exports: [consumer] };
    for (const validateOnBuild of [false, true]) {
      expect(() => createContainer({ imports: [owner, hidden] }, { validateOnBuild })).toThrow(ModuleEncapsulationError);
    }
  });

  test("preserves visible overrides, separate keys and root enumerable access", async () => {
    const token = createToken<string>("SharedValue");
    const consumer = createToken<string>("SelectedConsumer");
    const first = { providers: [singletonValue(token, "first")], exports: [token] };
    const second = { providers: [singletonValue(token, "second")], exports: [token] };
    const hidden = { providers: [DI.keyedSingleton("hidden", DI.valueProvider(token, "private"))], exports: [] };
    const container = createContainer({
      imports: [first, second, hidden],
      providers: [DI.singleton(DI.factoryProvider(consumer, [token], value => value))], exports: [],
    }, { validateOnBuild: true });
    expect(container.resolve(consumer)).toBe("second");
    expect(container.resolveAll(token)).toEqual(["first", "second"]);
    expect(container.resolveKeyed(token, "hidden")).toBe("private");
    await container.dispose();
  });

  test("configure replacement retains its declaring module owner", () => {
    const token = createToken<string>("ReplacedValue");
    const consumer = createToken<string>("ReplacementConsumer");
    const visible = { providers: [singletonValue(token, "visible")], exports: [token] };
    const owner = { imports: [visible], providers: [DI.singleton(DI.factoryProvider(consumer, [token], value => value))], exports: [consumer] };
    const hidden: BazisModuleRef = {
      exports: [], configure(di) { di.replace(token, DI.valueProvider(token, "hidden"), "singleton"); },
    };
    expect(() => createContainer({ imports: [owner, hidden] })).toThrow(ModuleEncapsulationError);

  });

  test("rejects private generic selection as well as late generic consumer dependencies", () => {
    const argument = createToken<unknown>("Argument");
    const family = createOpenGenericTokenFamily<unknown, string>("Values");
    const make = (value: string, exports: BazisModuleRef["exports"]): BazisModuleRef => ({
      exports, configure(di) { di.addOpenGeneric(family, "singleton", arg => DI.valueProvider(family.of(arg), value)); },
    });
    const visible = make("visible", [family]);
    const hidden = make("hidden", []);
    const consumer = createToken<string>("GenericConsumer");
    const owner = { imports: [visible], providers: [DI.singleton(DI.factoryProvider(consumer, [family.of(argument)], value => value))], exports: [consumer] };
    expect(() => createContainer({ imports: [owner, hidden] })).toThrow(ModuleEncapsulationError);

    const namedOwner = {
      imports: [visible],
      providers: [singletonValue(argument, {}), DI.singleton(DI.factoryProvider(consumer, [namedDependency<string>("Values<Argument>")], value => value))],
      exports: [consumer],
    };
    expect(() => createContainer({ imports: [namedOwner, hidden] })).toThrow(ModuleEncapsulationError);

    const dependency = createToken<string>("GenericDependency");
    const exported = { providers: [singletonValue(dependency, "visible")], exports: [dependency] };
    const privateOwner = { providers: [singletonValue(dependency, "hidden")], exports: [] };
    const genericOwner: BazisModuleRef = {
      imports: [exported], exports: [family],
      configure(di) { di.addOpenGeneric(family, "singleton", arg => DI.factoryProvider(family.of(arg), [dependency], value => value)); },
    };
    const container = createContainer({ imports: [genericOwner, privateOwner] });
    expect(() => container.resolve(family.of(argument))).toThrow(ModuleEncapsulationError);
  });
});
