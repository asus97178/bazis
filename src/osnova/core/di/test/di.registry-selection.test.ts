import { describe, expect, test } from "bun:test";
import {
  DI,
  ModuleEncapsulationError,
  ProviderNotFoundError,
  ScopeDisposedError,
  ScopedServiceFromRootError,
  ServiceCollection,
  createContainer,
  createOpenGenericTokenFamily,
  createToken,
  type ServiceKey,
} from "../index";
import { ServiceRegistry } from "../internal/ServiceRegistry";

describe("DI cached registration selection", () => {
  test("keeps key identity, last registration priority and enumeration order after warmup", async () => {
    const token = createToken<string>("SelectionIdentity");
    const keys: ServiceKey[] = [1, "1", Symbol("same"), Symbol("same"), "__proto__", "constructor", 0];
    const services = new ServiceCollection();
    services.addSingleton(DI.valueProvider(token, "unkeyed"));
    keys.forEach((key, index) => {
      services.addKeyedSingleton(key, DI.valueProvider(token, `first-${index}`));
      services.addKeyedSingleton(key, DI.valueProvider(token, `last-${index}`));
    });
    // Existing strict equality treats NaN as a nonmatching key; Map must not change that.
    services.addKeyedSingleton(NaN, DI.valueProvider(token, "nan"));
    const provider = services.buildServiceProvider();
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        for (const [index, key] of keys.entries()) {
          expect(provider.resolveKeyed(token, key)).toBe(`last-${index}`);
          expect(await provider.resolveKeyedAsync(token, key)).toBe(`last-${index}`);
          expect(provider.resolveAllKeyed(token, key)).toEqual([`first-${index}`, `last-${index}`]);
        }
        expect(provider.resolve(token)).toBe("unkeyed");
        expect(provider.resolveAll(token)).toEqual(["unkeyed"]);
        expect(provider.resolveKeyed(token, -0)).toBe("last-6");
        expect(provider.has(token, NaN)).toBe(false);
        expect(provider.resolveAllKeyed(token, NaN)).toEqual([]);
        expect(() => provider.resolveKeyed(token, NaN)).toThrow(ProviderNotFoundError);
      }
    } finally {
      await provider.dispose();
    }
  });

  test("preserves warmed selections through failed and successful generic materialization", async () => {
    const family = createOpenGenericTokenFamily<unknown, string>("SelectionGeneric");
    const token = family.of(createToken<object>("SelectionArgument"));
    const services = new ServiceCollection();
    services.addKeyedSingleton("red", DI.valueProvider(token, "explicit-first"));
    services.addKeyedSingleton("red", DI.valueProvider(token, "explicit-last"));
    for (let key = 0; key < 8; key += 1) {
      services.addKeyedSingleton(key, DI.valueProvider(token, "other-key"));
    }
    let blueFactories = 0;
    let redAttempts = 0;
    services.addOpenGeneric(family, "singleton", argument => {
      blueFactories += 1;
      return DI.valueProvider(family.of(argument), "blue");
    }, "blue");
    services.addOpenGeneric(family, "singleton", argument =>
      DI.valueProvider(family.of(argument), "generic-first"), "red");
    services.addOpenGeneric(family, "singleton", argument => {
      if (++redAttempts === 1) throw new Error("retry materialization");
      return DI.valueProvider(family.of(argument), "generic-last");
    }, "red");
    const provider = services.buildServiceProvider();
    try {
      expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue"]);
      expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue"]);
      expect(provider.resolveKeyed(token, "red")).toBe("explicit-last");
      expect(provider.resolveKeyed(token, "red")).toBe("explicit-last");
      expect(() => provider.resolveAllKeyed(token, "red")).toThrow("retry materialization");
      expect(provider.resolveKeyed(token, "red")).toBe("explicit-last");
      for (let pass = 0; pass < 2; pass += 1) {
        expect(provider.resolveAllKeyed(token, "red")).toEqual([
          "explicit-first", "explicit-last", "generic-first", "generic-last",
        ]);
        expect(provider.resolveKeyed(token, "red")).toBe("explicit-last");
        expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue"]);
      }
      expect(redAttempts).toBe(2);
      expect(blueFactories).toBe(1);
    } finally {
      await provider.dispose();
    }
  });

  test("invalidates a whole-group selection when a different generic key is materialized", async () => {
    const family = createOpenGenericTokenFamily<unknown, string>("SelectionGrowingGroup");
    const token = family.of(createToken<object>("SelectionGrowingArgument"));
    const services = new ServiceCollection();
    services.addOpenGeneric(family, "singleton", argument =>
      DI.valueProvider(family.of(argument), "blue-first"), "blue");
    services.addOpenGeneric(family, "singleton", argument =>
      DI.valueProvider(family.of(argument), "blue-last"), "blue");
    services.addOpenGeneric(family, "singleton", argument =>
      DI.valueProvider(family.of(argument), "red"), "red");
    const provider = services.buildServiceProvider();
    try {
      expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue-first", "blue-last"]);
      expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue-first", "blue-last"]);
      expect(provider.resolveKeyed(token, "red")).toBe("red");
      expect(provider.resolveAllKeyed(token, "blue")).toEqual(["blue-first", "blue-last"]);
      expect(provider.resolveAllKeyed(token, "red")).toEqual(["red"]);
      expect(provider.resolveKeyed(token, "blue")).toBe("blue-last");
    } finally {
      await provider.dispose();
    }
  });

  test("checks lifetime and disposed scopes on cache hits without sharing scoped instances", async () => {
    const token = createToken<{ dispose(): void }>("SelectionScoped");
    const captive = createToken<object>("SelectionCaptive");
    const services = new ServiceCollection();
    let disposed = 0;
    services.addKeyedScoped("used", DI.factoryProvider(token, [], () => ({ dispose() { disposed += 1; } })));
    for (let key = 0; key < 8; key += 1) {
      services.addKeyedScoped(key, DI.factoryProvider(token, [], () => ({ dispose() {} })));
    }
    services.addSingleton(DI.factoryProvider(captive, [DI.keyed(token, "used")], resource => ({ resource })));
    const provider = services.buildServiceProvider();
    const first = provider.createScope();
    const second = provider.createScope();
    try {
      const resource = first.resolveKeyed(token, "used");
      expect(first.resolveAllKeyed(token, "used")).toEqual([resource]);
      expect(await first.resolveKeyedAsync(token, "used")).toBe(resource);
      const another = second.resolveKeyed(token, "used");
      expect(another).not.toBe(resource);
      expect(() => provider.resolveKeyed(token, "used")).toThrow(ScopedServiceFromRootError);
      expect(() => provider.resolveAllKeyed(token, "used")).toThrow(ScopedServiceFromRootError);
      await expect(provider.resolveKeyedAsync(token, "used")).rejects.toBeInstanceOf(ScopedServiceFromRootError);
      expect(() => first.resolve(captive)).toThrow(ScopedServiceFromRootError);
      await first.dispose();
      expect(disposed).toBe(1);
      expect(() => first.resolveKeyed(token, "used")).toThrow(ScopeDisposedError);
      expect(() => first.resolveAllKeyed(token, "used")).toThrow(ScopeDisposedError);
      expect(second.resolveKeyed(token, "used")).toBe(another);
    } finally {
      await provider.dispose();
    }
    expect(disposed).toBe(2);
  });

  test("keeps module visibility checks when a private keyed selection is already cached", async () => {
    const hidden = createToken<string>("SelectionPrivate");
    const family = createOpenGenericTokenFamily<unknown, string>("SelectionPrivateConsumer");
    const token = family.of(createToken<object>("SelectionPrivateArgument"));
    const provider = createContainer({
      imports: [
        {
          exports: [],
          providers: [
            DI.keyedSingleton("blue", DI.valueProvider(hidden, "first")),
            DI.keyedSingleton("blue", DI.valueProvider(hidden, "last")),
            ...Array.from({ length: 8 }, (_, key) => DI.keyedSingleton(key, DI.valueProvider(hidden, "other-key"))),
          ],
        },
        {
          exports: [family],
          configure(di) {
            di.addOpenGeneric(family, "singleton", argument =>
              DI.factoryProvider(family.of(argument), [DI.keyed(hidden, "blue")], value => value));
          },
        },
      ],
    });
    try {
      expect(provider.resolveKeyed(hidden, "blue")).toBe("last");
      expect(provider.resolveAllKeyed(hidden, "blue")).toEqual(["first", "last"]);
      expect(() => provider.resolve(token)).toThrow(ModuleEncapsulationError);
      expect(() => provider.resolveAll(token)).toThrow(ModuleEncapsulationError);
      await expect(provider.resolveAsync(token)).rejects.toBeInstanceOf(ModuleEncapsulationError);
    } finally {
      await provider.dispose();
    }
  });

  test("public result arrays cannot mutate a cached registration selection", async () => {
    const token = createToken<string>("SelectionResultArray");
    const services = new ServiceCollection();
    services.addKeyedSingleton("a", DI.valueProvider(token, "first"));
    services.addKeyedSingleton("b", DI.valueProvider(token, "other-key"));
    services.addKeyedSingleton("a", DI.valueProvider(token, "last"));
    const provider = services.buildServiceProvider();
    try {
      const result = provider.resolveAllKeyed(token, "a") as string[];
      result.splice(0, result.length, "modified");
      expect(provider.resolveAllKeyed(token, "a")).toEqual(["first", "last"]);
      expect(provider.resolveAllKeyed(token, "b")).toEqual(["other-key"]);
      expect(provider.resolveKeyed(token, "a")).toBe("last");
    } finally {
      await provider.dispose();
    }
  });

  test("missing keys cannot grow selection caches", () => {
    const token = createToken<string>("SelectionMissingKeys");
    const registry = new ServiceRegistry([
      DI.keyedSingleton("registered", DI.valueProvider(token, "value")),
      ...Array.from({ length: 8 }, (_, key) => DI.keyedSingleton(key, DI.valueProvider(token, "another"))),
    ], []);
    registry.find(token, "registered");
    registry.all(token, "registered");
    let unexpectedMatches = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const key = `missing-${index}`;
      unexpectedMatches += Number(registry.find(token, key) !== undefined);
      unexpectedMatches += registry.all(token, key).length;
    }
    expect(unexpectedMatches).toBe(0);
    // White-box memory invariant; do not add a public cache inspection API.
    const state = registry as unknown as {
      lastSelections: WeakMap<object, Map<unknown, unknown>>;
      allSelections: WeakMap<object, Map<unknown, unknown>>;
    };
    const group = [...registry.groups()][0]!;
    expect(state.lastSelections.get(group)?.size).toBe(1);
    expect(state.allSelections.get(group)?.size).toBe(1);
  });
});
