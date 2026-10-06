import { expect, test } from "bun:test";
import { Cacheable, memory } from "../index";
import { type DiRegistrar, CLASS_PROVIDER_HOOK, DI, ServiceCollection, createContainer, createOpenGenericTokenFamily, createToken, singleton, singletonValue } from "../../di";

test("cache activation belongs to a container, independent of declaration/build order", async () => {
  class CounterService {
    calls = 0;
    @Cacheable({ seconds: 60 }) get() { return ++this.calls; }
  }
  const definition = singleton(CounterService);
  const plainModule = { providers: [definition] };
  const before = createContainer(plainModule, { validateOnBuild: true });
  expect([before.resolve(CounterService).get(), before.resolve(CounterService).get()]).toEqual([1, 2]);
  const cache = memory();
  for (const cacheFirst of [true, false]) {
    const withCache = () => createContainer({ imports: [cache], providers: [definition] }, { validateOnBuild: true });
    const withoutCache = () => createContainer(plainModule, { validateOnBuild: true });
    const containers = cacheFirst ? [withCache(), withoutCache()] : [withoutCache(), withCache()];
    for (const [index, container] of containers.entries()) {
      const service = container.resolve(CounterService);
      expect([service.get(), service.get()]).toEqual(index === (cacheFirst ? 0 : 1) ? [1, 1] : [1, 2]);
      await container.dispose();
    }
  }
  const collection = new ServiceCollection().addMany(cache.providers!).add(definition);
  for (let iteration = 0; iteration < 2; iteration++) {
    const provider = collection.buildServiceProvider({ validateOnBuild: true });
    const service = provider.resolve(CounterService);
    expect([service.get(), service.get()]).toEqual([1, 1]);
    await provider.dispose();
  }
  expect("activation" in definition.provider).toBe(false);
  expect(before.resolve(CounterService).get()).toBe(3);
  await before.dispose();
});

test("configure replacements and keyed definitions receive only their container's hook", async () => {
  class CounterService {
    calls = 0;
    @Cacheable({ seconds: 60 }) get() { return ++this.calls; }
  }
  const cache = memory();
  const configured = createContainer({ imports: [cache], providers: [singleton(CounterService)], configure(di) {
    di.replace(CounterService, DI.classProvider(CounterService, CounterService), "singleton");
    di.keyedSingleton("other", DI.classProvider(CounterService, CounterService));
  } }, { validateOnBuild: true });
  for (const service of [configured.resolve(CounterService), configured.resolveKeyed(CounterService, "other")]) {
    expect([service.get(), service.get()]).toEqual([1, 1]);
  }
  await configured.dispose();
});

test("generic class activation is local for both container and collection builds", async () => {
  class CounterService {
    calls = 0;
    @Cacheable({ seconds: 60 }) get() { return ++this.calls; }
  }
  const family = createOpenGenericTokenFamily<unknown, CounterService>("CounterFamily");
  const argument = createToken<unknown>("CounterArgument");
  for (const useCollection of [true, false]) for (const cached of [true, false]) {
    const configure = (di: Pick<DiRegistrar, "addOpenGeneric">) => {
      di.addOpenGeneric(family, "singleton", token => DI.classProvider(family.of(token), CounterService));
    };
    let provider;
    if (useCollection) {
      const collection = new ServiceCollection();
      if (cached) collection.addMany(memory().providers!);
      configure(collection);
      provider = collection.buildServiceProvider({ validateOnBuild: true });
    } else {
      provider = createContainer({ imports: cached ? [memory()] : [], configure }, { validateOnBuild: true });
    }
    try {
      const service = provider.resolve(family.of(argument));
      expect([service.get(), service.get()]).toEqual(cached ? [1, 1] : [1, 2]);
    } finally { await provider.dispose(); }
  }
});

test("build extensions cannot execute factories or use scoped/keyed hook state", () => {
  let called = false;
  for (const definition of [
    DI.singleton(DI.factoryProvider(CLASS_PROVIDER_HOOK, [], () => { called = true; return () => undefined; })),
    DI.scoped(DI.valueProvider(CLASS_PROVIDER_HOOK, () => undefined)),
    DI.keyedSingleton("key", DI.valueProvider(CLASS_PROVIDER_HOOK, () => undefined)),
    singletonValue(CLASS_PROVIDER_HOOK, null as never),
  ]) {
    expect(() => createContainer({ providers: [definition] })).toThrow("unkeyed singleton value");
    expect(() => new ServiceCollection().add(definition).buildServiceProvider()).toThrow("unkeyed singleton value");
  }
  expect(called).toBe(false);
});
