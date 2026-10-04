import { describe, expect, test } from "bun:test";
import {
  DI,
  ModuleEncapsulationError,
  createContainer,
  createOpenGenericTokenFamily,
  createToken,
  lazyDependency,
  namedDependency,
  type OsnovaModuleRef,
} from "../index";
import { registerGeneratedClassDeps, restoreGeneratedClassDeps, snapshotGeneratedClassDeps } from "../module/autoDeps";

describe("DI open generic module ownership", () => {
  for (const validateOnBuild of [false, true]) {
    test.each(["direct", "keyed", "lazy", "named", "class", "generated", "async"] as const)(
      `rejects private sibling dependencies: %s (validateOnBuild=${validateOnBuild})`,
      async (kind) => {
        const PRIVATE = createToken<string>("GenericPrivateDependency");
        const ARG = createToken<unknown>("GenericConsumerArgument");
        const FAMILY = createOpenGenericTokenFamily<unknown, object>("EncapsulatedGeneric");
        const snapshot = snapshotGeneratedClassDeps();
        class GenericService {
          constructor(readonly value: string) {}
        }
        if (kind === "class") DI.bindDeps(GenericService, PRIVATE);
        if (kind === "generated") registerGeneratedClassDeps(GenericService, ["GenericPrivateDependency"]);
        const hidden: OsnovaModuleRef = {
          providers: [
            DI.singleton(DI.valueProvider(PRIVATE, "private")),
            DI.keyedSingleton("blue", DI.valueProvider(PRIVATE, "private-keyed")),
          ],
          exports: [],
        };
        const generic: OsnovaModuleRef = {
          exports: [FAMILY],
          configure(di) {
            di.addOpenGeneric(FAMILY, "singleton", argument => {
              const token = FAMILY.of(argument);
              switch (kind) {
                case "class":
                case "generated": return { provide: token, useClass: GenericService };
                case "keyed": return DI.factoryProvider(token, [DI.keyed(PRIVATE, "blue")], value => ({ value }));
                case "lazy": return DI.factoryProvider(token, [lazyDependency(PRIVATE)], value => ({ value }));
                case "named": return DI.factoryProvider(token, [namedDependency("GenericPrivateDependency")], value => ({ value }));
                case "async": return DI.asyncFactoryProvider(token, [PRIVATE], async value => ({ value }));
                default: return DI.factoryProvider(token, [PRIVATE], value => ({ value }));
              }
            });
          },
        };
        try {
          const app: OsnovaModuleRef = { imports: [hidden, generic] };
          if (validateOnBuild) {
            expect(() => createContainer(app, { validateOnBuild })).toThrow(ModuleEncapsulationError);
          } else {
            const container = createContainer(app, { validateOnBuild });
            try {
              // A failed materialization must not publish any usable registration.
              expect(() => container.resolveAll(FAMILY.of(ARG))).toThrow(ModuleEncapsulationError);
              expect(() => container.resolve(FAMILY.of(ARG))).toThrow(ModuleEncapsulationError);
              await expect(container.resolveAsync(FAMILY.of(ARG))).rejects.toBeInstanceOf(ModuleEncapsulationError);
            } finally {
              await container.dispose();
            }
          }
        } finally {
          restoreGeneratedClassDeps(snapshot);
        }
      },
    );
  }

  test.each(["own", "imported", "global", "open"] as const)("permits %s dependencies of a generic provider", async (visibility) => {
    const DEP = createToken<string>("VisibleGenericDependency");
    const ARG = createToken<unknown>("VisibleGenericArgument");
    const FAMILY = createOpenGenericTokenFamily<unknown, { value: string }>("VisibleGeneric");
    const definition = DI.singleton(DI.valueProvider(DEP, visibility));
    const dependency: OsnovaModuleRef = {
      providers: [definition],
      exports: visibility === "open" ? undefined : [DEP],
      global: visibility === "global",
    };
    const generic: OsnovaModuleRef = {
      providers: visibility === "own" ? [definition] : [],
      imports: visibility === "imported" ? [dependency] : [],
      exports: visibility === "open" ? undefined : [FAMILY],
      configure(di) {
        di.addOpenGeneric(FAMILY, "singleton", argument => DI.factoryProvider(
          FAMILY.of(argument), [DEP], value => ({ value }),
        ));
      },
    };
    const container = createContainer({
      imports: visibility === "own" ? [generic] : [dependency, generic],
    }, { validateOnBuild: true });
    try {
      expect(container.resolve(FAMILY.of(ARG)).value).toBe(visibility);
    } finally {
      await container.dispose();
    }
  });

  test.each(["named", "lazy", "generated"] as const)("binds generic %s dependencies in the declaring module", async (kind) => {
    const ARG = createToken<unknown>("NamedGenericArgument");
    const FIRST = createToken<string>("SharedGenericDependencyName");
    const SECOND = createToken<string>("SharedGenericDependencyName");
    const FAMILY = createOpenGenericTokenFamily<unknown, { read(): string }>("NamedGeneric");
    const snapshot = snapshotGeneratedClassDeps();
    class GenericService {
      constructor(readonly value: string) {}
      read() { return this.value; }
    }
    registerGeneratedClassDeps(GenericService, ["SharedGenericDependencyName"]);
    const generic: OsnovaModuleRef = {
      providers: [DI.singleton(DI.valueProvider(FIRST, "owner"))],
      exports: [FAMILY],
      configure(di) {
        di.addOpenGeneric(FAMILY, "singleton", argument => {
          const token = FAMILY.of(argument);
          if (kind === "generated") return { provide: token, useClass: GenericService };
          const dep = namedDependency<string>("SharedGenericDependencyName");
          return kind === "lazy"
            ? DI.factoryProvider(token, [lazyDependency(dep)], value => ({ read: () => value.value }))
            : DI.factoryProvider(token, [dep], value => ({ read: () => value }));
        });
      },
    };
    const sibling: OsnovaModuleRef = {
      providers: [DI.singleton(DI.valueProvider(SECOND, "sibling"))], exports: [],
    };
    try {
      const container = createContainer({ imports: [generic, sibling] }, { validateOnBuild: true });
      try {
        expect(container.resolve(FAMILY.of(ARG)).read()).toBe("owner");
      } finally {
        await container.dispose();
      }
    } finally {
      restoreGeneratedClassDeps(snapshot);
    }
  });

  test("a generic provider may use an exported family but cannot reach a private family", async () => {
    const ARG = createToken<unknown>("NestedGenericArgument");
    const INNER = createOpenGenericTokenFamily<unknown, string>("PrivateInnerGeneric");
    const OUTER = createOpenGenericTokenFamily<unknown, { value: string }>("PublicOuterGeneric");
    for (const exported of [false, true]) {
      const inner: OsnovaModuleRef = {
        exports: exported ? [INNER] : [],
        configure(di) {
          di.addOpenGeneric(INNER, "singleton", argument => DI.valueProvider(INNER.of(argument), "inner"));
        },
      };
      const outer: OsnovaModuleRef = {
        imports: [inner], exports: [OUTER],
        configure(di) {
          di.addOpenGeneric(OUTER, "singleton", argument => DI.factoryProvider(
            OUTER.of(argument), [INNER.of(argument)], value => ({ value }),
          ));
        },
      };
      const container = createContainer(outer);
      try {
        if (exported) expect(container.resolve(OUTER.of(ARG)).value).toBe("inner");
        else expect(() => container.resolve(OUTER.of(ARG))).toThrow(ModuleEncapsulationError);
      } finally {
        await container.dispose();
      }
    }
  });
});
