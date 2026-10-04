import { describe, expect, test } from "bun:test";
import {
  CircularDependencyError,
  DI,
  ServiceCollection,
  createOpenGenericTokenFamily,
  createToken,
  createContainer,
  type OsnovaModuleRef,
} from "../index";
import { KeyedAppService, LOGGER, TestLogger } from "./test-fixtures";

describe("DI keyed and collection", () => {
  test("resolveAllKeyed excludes another key materialized during factory execution", async () => {
    const family = createOpenGenericTokenFamily<unknown, string>("ReentrantKeyedFamily");
    const argument = createToken<object>("ReentrantKeyedArgument");
    const token = family.of(argument);
    const collection = new ServiceCollection();
    let blueCreated = 0;
    collection.addOpenGeneric(family, "transient", arg => DI.factoryProvider(family.of(arg), [], () => {
      blueCreated += 1;
      return "blue";
    }), "blue");
    collection.addOpenGeneric(family, "transient", arg => DI.factoryProvider(family.of(arg), [], () => {
      expect(provider.resolveKeyed(token, "blue")).toBe("blue");
      return "red";
    }), "red");
    const provider = collection.buildServiceProvider();
    try {
      expect(provider.resolveAllKeyed(token, "red")).toEqual(["red"]);
      expect(blueCreated).toBe(1);
      expect(provider.resolveAllKeyed(token, "red")).toEqual(["red"]);
      expect(blueCreated).toBe(2);
    } finally {
      await provider.dispose();
    }
  });

  test("resolveAll returns all registrations in order", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.singleton(DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(
          DI.factoryProvider(LOGGER, [], () => ({
            log() {
              return undefined;
            },
          })),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    const all = container.resolveAll(LOGGER);
    expect(all.length).toBe(2);
    expect(all[0]).toBeInstanceOf(TestLogger);
    expect(typeof all[1]?.log).toBe("function");
  });

  test("resolves keyed services", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.keyedSingleton("console", DI.classProvider(LOGGER, TestLogger)),
        DI.keyedSingleton(
          "null",
          DI.factoryProvider(LOGGER, [], () => ({
            log() {
              return undefined;
            },
          })),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    expect(container.resolveKeyed(LOGGER, "console")).toBeInstanceOf(TestLogger);
    expect(typeof container.resolveKeyed(LOGGER, "null").log).toBe("function");
  });

  test("supports keyed dependency injection in deps list", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.keyedSingleton("console", DI.classProvider(LOGGER, TestLogger)),
        DI.singleton(
          DI.classProvider(KeyedAppService, KeyedAppService, [DI.keyed(LOGGER, "console")]),
        ),
      ],
    };

    const container = createContainer(moduleRef);
    expect(container.resolve(KeyedAppService).logger).toBeInstanceOf(TestLogger);
  });

  test("service collection supports tryAdd, replace and remove", () => {
    const collection = new ServiceCollection();

    const addedFirst = collection.tryAddSingleton(DI.classProvider(LOGGER, TestLogger));
    const addedSecond = collection.tryAddSingleton(DI.classProvider(LOGGER, TestLogger));
    expect(addedFirst).toBe(true);
    expect(addedSecond).toBe(false);

    collection.replace(
      LOGGER,
      DI.factoryProvider(LOGGER, [], () => ({
        log() {
          return undefined;
        },
      })),
      "singleton",
    );
    expect(collection.remove(LOGGER)).toBe(1);
  });

  test("tryAddEnumerable ignores duplicates by implementation", () => {
    const services = new ServiceCollection();
    const definitionA = DI.singleton(DI.classProvider(LOGGER, TestLogger));
    const definitionB = DI.singleton(DI.classProvider(LOGGER, TestLogger));

    expect(services.tryAddEnumerable(definitionA)).toBe(true);
    expect(services.tryAddEnumerable(definitionB)).toBe(false);
  });

  test("service collection supports keyed tryAdd variants", () => {
    const services = new ServiceCollection();

    expect(services.tryAddKeyedSingleton("k1", DI.classProvider(LOGGER, TestLogger))).toBe(true);
    expect(services.tryAddKeyedSingleton("k1", DI.classProvider(LOGGER, TestLogger))).toBe(false);
    expect(services.tryAddKeyedTransient("k2", DI.classProvider(LOGGER, TestLogger))).toBe(true);
    expect(services.tryAddKeyedScoped("k3", DI.classProvider(LOGGER, TestLogger))).toBe(true);
  });

  test("resolveAllKeyed returns only matching key registrations", () => {
    const moduleRef: OsnovaModuleRef = {
      providers: [
        DI.keyedSingleton("a", DI.classProvider(LOGGER, TestLogger)),
        DI.keyedSingleton("b", DI.classProvider(LOGGER, TestLogger)),
        DI.keyedSingleton("a", DI.classProvider(LOGGER, TestLogger)),
      ],
    };

    const container = createContainer(moduleRef);
    expect(container.resolveAllKeyed(LOGGER, "a").length).toBe(2);
    expect(container.resolveAllKeyed(LOGGER, "b").length).toBe(1);
  });

  test("keyed registrations use registration identity for runtime cycle detection", async () => {
    const VALUE = createToken<number>("KeyedComposition");
    const container = createContainer({
      providers: [
        DI.keyedSingleton("base", DI.valueProvider(VALUE, 10)),
        DI.keyedSingleton("decorated", DI.factoryProvider(VALUE, [DI.keyed(VALUE, "base")], (base) => base + 1)),
      ],
    });
    expect(container.resolveKeyed(VALUE, "decorated")).toBe(11);
    expect(await container.resolveKeyedAsync(VALUE, "decorated")).toBe(11);

    const cyclic = createContainer({
      providers: [DI.keyedSingleton("same", DI.factoryProvider(VALUE, [DI.keyed(VALUE, "same")], () => 1))],
    });
    expect(() => cyclic.resolveKeyed(VALUE, "same")).toThrow(CircularDependencyError);
  });
});
