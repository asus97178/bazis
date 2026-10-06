import { expect, test } from "bun:test";
import { DI, ModuleEncapsulationError, ServiceCollection, ServiceValidationError, createContainer, createToken, namedDependency, singletonValue } from "../index";

test("class wrapper dependencies participate in lifetime and module validation", () => {
  class Service {}
  class ScopedDependency {}
  const registration = DI.singleton({
    ...DI.classProvider(Service, Service),
    activation: { deps: [ScopedDependency], wrap: (instance: Service) => instance },
  });
  const services = new ServiceCollection().add(registration).addScoped(DI.classProvider(ScopedDependency, ScopedDependency));
  expect(() => services.buildServiceProvider({ validateOnBuild: true })).toThrow(ServiceValidationError);
  expect(() => createContainer({ imports: [
    { providers: [registration], exports: [Service] },
    { providers: [DI.singleton(DI.classProvider(ScopedDependency, ScopedDependency))], exports: [] },
  ] })).toThrow(ModuleEncapsulationError);
});

test("named binding preserves separate constructor and wrapper arguments", async () => {
  const input = createToken<string>("InputValue");
  const suffix = createToken<string>("SuffixValue");
  class Service { constructor(readonly input: string) {} }
  const container = createContainer({ providers: [
    singletonValue(input, "constructor"), singletonValue(suffix, "wrapper"),
    DI.singleton({
      ...DI.classProvider(Service, Service, [namedDependency("InputValue")]),
      activation: {
        deps: [namedDependency("SuffixValue")],
        wrap(instance: Service, _resolver, value) { return Object.assign(instance, { suffix: value }); },
      },
    }),
  ], exports: [Service] }, { validateOnBuild: true });
  expect(container.resolve(Service)).toMatchObject({ input: "constructor", suffix: "wrapper" });
  await container.dispose();
});

test.each(["sync", "async"] as const)("failed class wrapper preserves disposal: %s", async mode => {
  let disposed = 0;
  class Resource { dispose() { disposed++; } }
  const container = createContainer({ providers: [DI.singleton({
    ...DI.classProvider(Resource, Resource),
    activation: { deps: [], wrap() { throw new Error("wrapper failed"); } },
  })] });
  if (mode === "sync") expect(() => container.resolve(Resource)).toThrow("wrapper failed");
  else await expect(container.resolveAsync(Resource)).rejects.toThrow("wrapper failed");
  await container.dispose();
  await container.dispose();
  expect(disposed).toBe(1);
});
