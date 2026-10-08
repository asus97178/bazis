import { expect, test } from "bun:test";
import { DI, Module, createContainer, keyedDependency, scoped, singleton } from "../index";

// Test replacements: registered after the graph, visible to every module, and
// they must replace something. Before, a replacement in the importing module
// failed with "registered in two modules", and a @Global workaround depended
// on the order of imports.
abstract class IStore { abstract name(): string; }
class RealStore implements IStore { name() { return "real"; } }
class FakeStore implements IStore { name() { return "fake"; } }
class Service { constructor(readonly store: IStore) {} }

@Module({ providers: [scoped(IStore, RealStore), scoped(Service, Service, [IStore] as const)], exports: [Service] })
class FeatureModule {}

test("an override replaces a provider the module itself consumes", () => {
  const container = createContainer(FeatureModule, { overrides: [singleton(IStore, FakeStore)] });
  expect(container.createScope().resolve(Service).store.name()).toBe("fake");
});

test("the result does not depend on where the feature module sits in the graph", () => {
  @Module({ imports: [FeatureModule], exports: [] }) class Late {}
  @Module({ imports: [Late, FeatureModule], exports: [] }) class AppModule {}
  expect(createContainer(AppModule, { overrides: [singleton(IStore, FakeStore)] }).createScope().resolve(Service).store.name()).toBe("fake");
});

test("keyed registrations are overridden by key", () => {
  class Uses { constructor(readonly store: IStore) {} }
  @Module({
    providers: [DI.keyedSingleton("main", DI.classProvider(IStore, RealStore)), scoped(Uses, Uses, [keyedDependency(IStore, "main")] as const)],
    exports: [],
  })
  class KeyedModule {}
  const container = createContainer(KeyedModule, { overrides: [DI.keyedSingleton("main", DI.classProvider(IStore, FakeStore))] });
  expect(container.createScope().resolve(Uses).store.name()).toBe("fake");
});

test("an override that replaces nothing is an error", () => {
  abstract class IMissing { abstract x(): void; }
  class Missing implements IMissing { x() {} }
  expect(() => createContainer(FeatureModule, { overrides: [singleton(IMissing, Missing)] }))
    .toThrow('Override of "IMissing" replaces nothing: no module registers it. Check the token, or register it in a module first.');
});
