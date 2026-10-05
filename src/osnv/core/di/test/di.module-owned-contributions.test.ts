import { describe, expect, test } from "bun:test";
import {
  DI,
  HOSTED_SERVICE,
  AsyncResolutionRequiredError,
  ModuleEncapsulationError,
  ModuleOwnedProviderConflictError,
  createContainer,
  createModuleOwnedMetadataChannel,
  createModuleOwnedProviderChannel,
  createToken,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  scoped,
  singleton,
  singletonAsyncFactory,
  type ModuleOwnedProviderContributionContext,
  type ModuleOwnedContributionSnapshot,
  type OsnvModuleMetadata,
  type ProviderDefinition,
} from "../index";
import { testModule } from "./test-fixtures";

interface PrivateDependency {
  readonly value: string;
}

class PrivateDependencyService implements PrivateDependency {
  public readonly value = "private";
}

class OwnedCapability {
  public constructor(public readonly dependency: PrivateDependency) {}
}

interface OwnedPayload {
  readonly key: string;
}

interface MetadataPayload {
  readonly key: string;
}

interface ProviderDeclaration {
  readonly definition: ProviderDefinition<OwnedCapability>;
  readonly payload: OwnedPayload;
}

interface TestContributionMetadata extends OsnvModuleMetadata {
  readonly ownedProviderDeclarations?: readonly ProviderDeclaration[];
  readonly attachedProviderDeclarations?: readonly ProviderDeclaration[];
  readonly ownedMetadataDeclarations?: readonly MetadataPayload[];
}

const PRIVATE_DEPENDENCY = createToken<PrivateDependency>("OwnedPrivateDependency");
const PROVIDER_CHANNEL = createModuleOwnedProviderChannel<OwnedPayload, OwnedCapability>("test.owned-provider");
const SAME_NAME_PROVIDER_CHANNEL = createModuleOwnedProviderChannel<OwnedPayload, OwnedCapability>(
  "test.owned-provider",
);
const METADATA_CHANNEL = createModuleOwnedMetadataChannel<MetadataPayload>("test.owned-metadata");
const validatedSnapshots = new WeakSet<object>();

const testContributor = (
  metadata: OsnvModuleMetadata,
  context: ModuleOwnedProviderContributionContext,
): void => {
  const declarations = metadata as TestContributionMetadata;
  for (const declaration of declarations.ownedProviderDeclarations ?? []) {
    context.addScoped(PROVIDER_CHANNEL, declaration.definition, declaration.payload);
  }
  for (const declaration of declarations.attachedProviderDeclarations ?? []) {
    const provider = declaration.definition.provider;
    if (!("useClass" in provider) || provider.provide !== provider.useClass) {
      throw new Error("Test fixture requires a self-class provider.");
    }
    context.attachExistingScoped(PROVIDER_CHANNEL, provider.useClass, declaration.payload);
  }
  for (const declaration of declarations.ownedMetadataDeclarations ?? []) {
    context.addMetadata(METADATA_CHANNEL, declaration);
  }
};

registerModuleOwnedProviderContributor(testContributor);
registerModuleOwnedProviderContributor(testContributor);

const testValidator = (snapshot: ModuleOwnedContributionSnapshot): void => {
  if (validatedSnapshots.has(snapshot)) {
    throw new Error("The same contribution validator ran twice for one snapshot.");
  }
  validatedSnapshots.add(snapshot);
  const records = snapshot.getMetadataContributions(METADATA_CHANNEL);
  if (!Object.isFrozen(snapshot) || !Object.isFrozen(records) || records.some((record) => !Object.isFrozen(record))) {
    throw new Error("Contribution validation snapshot must be frozen.");
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (seen.has(record.payload.key)) {
      duplicates.add(record.payload.key);
    }
    seen.add(record.payload.key);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate test metadata: ${[...duplicates].sort().join(", ")}`);
  }
};

registerModuleOwnedContributionValidator(testValidator);
registerModuleOwnedContributionValidator(testValidator);

function capabilityDefinition(): ProviderDefinition<OwnedCapability> {
  return scoped(OwnedCapability, OwnedCapability, [PRIVATE_DEPENDENCY] as const);
}

function moduleWith(metadata: TestContributionMetadata) {
  return testModule("OwnedFeatureModule", metadata);
}

describe("module-owned provider contributors", () => {
  test("activates a scoped capability with its owning module's private dependency", async () => {
    const feature = moduleWith({
      providers: [singleton(PRIVATE_DEPENDENCY, PrivateDependencyService)],
      exports: [],
      ownedProviderDeclarations: [
        { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.reserve" }) },
      ],
    });
    const app = testModule("AppModule", { imports: [feature], exports: [] });

    const container = createContainer(app, { validateOnBuild: true });
    const records = container.getModuleOwnedProviderContributions(PROVIDER_CHANNEL);

    expect(records).toHaveLength(1);
    expect(records[0]?.ownerName).toBe("OwnedFeatureModule");
    expect(records[0]?.payload).toEqual({ key: "orders.reserve" });
    expect(container.has(OwnedCapability)).toBe(false);

    const firstScope = container.createScope();
    const first = records[0]!.activation.activate(firstScope);
    expect(first.dependency.value).toBe("private");
    expect(records[0]!.activation.activate(firstScope)).toBe(first);
    expect(await records[0]!.activation.activateAsync(firstScope)).toBe(first);

    const secondScope = container.createScope();
    expect(records[0]!.activation.activate(secondScope)).not.toBe(first);
    await firstScope.dispose();
    await secondScope.dispose();
    await container.dispose();
  });

  test("activates through the same private key when an owner-private dependency is async", async () => {
    let creations = 0;
    const feature = moduleWith({
      providers: [
        singletonAsyncFactory(PRIVATE_DEPENDENCY, [], async () => {
          creations += 1;
          return { value: "async-private" };
        }),
      ],
      exports: [],
      ownedProviderDeclarations: [
        { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.async-reserve" }) },
      ],
    });
    const container = createContainer(testModule("AppModule", { imports: [feature], exports: [] }));
    const record = container.getModuleOwnedProviderContributions(PROVIDER_CHANNEL)[0]!;
    const scope = container.createScope();

    expect(() => record.activation.activate(scope)).toThrow(AsyncResolutionRequiredError);
    const first = await record.activation.activateAsync(scope);
    const second = await record.activation.activateAsync(scope);
    expect(first.dependency.value).toBe("async-private");
    expect(second).toBe(first);
    expect(creations).toBe(1);

    await scope.dispose();
    await container.dispose();
  });

  test("does not make the same private dependency injectable from another module", () => {
    class ForeignConsumer {
      public constructor(public readonly dependency: PrivateDependency) {}
    }

    const feature = moduleWith({
      providers: [singleton(PRIVATE_DEPENDENCY, PrivateDependencyService)],
      exports: [],
      ownedProviderDeclarations: [
        { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.reserve" }) },
      ],
    });
    const foreign = testModule("ForeignModule", {
      providers: [singleton(ForeignConsumer, ForeignConsumer, [PRIVATE_DEPENDENCY] as const)],
      exports: [],
    });
    const app = testModule("AppModule", { imports: [feature, foreign], exports: [] });

    expect(() => createContainer(app)).toThrow(ModuleEncapsulationError);
    expect(() => createContainer(app)).toThrow(/OwnedPrivateDependency/);
  });

  test("keeps metadata-only contributions inert and scoped to the actual root graph", () => {
    const imported = moduleWith({
      ownedMetadataDeclarations: [Object.freeze({ key: "orders.created" })],
      exports: [],
    });
    const notImported = moduleWith({
      ownedMetadataDeclarations: [Object.freeze({ key: "orders.hidden" })],
      exports: [],
    });
    void notImported;
    const container = createContainer(testModule("AppModule", { imports: [imported], exports: [] }));

    expect(container.getModuleOwnedMetadataContributions(METADATA_CHANNEL).map((entry) => entry.payload.key)).toEqual([
      "orders.created",
    ]);
    expect(container.resolveAll(HOSTED_SERVICE)).toHaveLength(0);
  });

  test("uses opaque channel identity and exposes frozen container-local snapshots", () => {
    const feature = moduleWith({
      providers: [singleton(PRIVATE_DEPENDENCY, PrivateDependencyService)],
      exports: [],
      ownedProviderDeclarations: [
        { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.reserve" }) },
      ],
    });
    const container = createContainer(testModule("AppModule", { imports: [feature], exports: [] }));
    const records = container.getModuleOwnedProviderContributions(PROVIDER_CHANNEL);

    expect(container.getModuleOwnedProviderContributions(SAME_NAME_PROVIDER_CHANNEL)).toHaveLength(0);
    expect(Object.isFrozen(PROVIDER_CHANNEL)).toBe(true);
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(Object.isFrozen(records[0]?.activation)).toBe(true);
    expect(() => (records as unknown as unknown[]).push({})).toThrow();

    const otherContainer = createContainer(testModule("OtherAppModule", { exports: [] }));
    expect(otherContainer.getModuleOwnedProviderContributions(PROVIDER_CHANNEL)).toHaveLength(0);
  });

  test("runs final validators on a frozen full-graph snapshot with order-independent diagnostics", () => {
    const left = moduleWith({
      ownedMetadataDeclarations: [Object.freeze({ key: "orders.duplicate" })],
      exports: [],
    });
    const right = moduleWith({
      ownedMetadataDeclarations: [Object.freeze({ key: "orders.duplicate" })],
      exports: [],
    });

    const buildMessage = (imports: readonly ReturnType<typeof moduleWith>[]): string => {
      try {
        createContainer(testModule("AppModule", { imports, exports: [] }));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    };

    const leftFirst = buildMessage([left, right]);
    const rightFirst = buildMessage([right, left]);
    expect(leftFirst).toBe("Duplicate test metadata: orders.duplicate");
    expect(rightFirst).toBe(leftFirst);
  });

  test("rejects an ordinary registration of the contributed implementation regardless of load order", () => {
    const feature = moduleWith({
      providers: [
        singleton(PRIVATE_DEPENDENCY, PrivateDependencyService),
        singleton(OwnedCapability, OwnedCapability, [PRIVATE_DEPENDENCY] as const),
      ],
      exports: [],
      ownedProviderDeclarations: [
        { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.reserve" }) },
      ],
    });

    expect(() => createContainer(testModule("AppModule", { imports: [feature], exports: [] }))).toThrow(
      ModuleOwnedProviderConflictError,
    );
    expect(() => createContainer(testModule("AppModule", { imports: [feature], exports: [] }))).toThrow(
      /OwnedCapability.*another DI registration/,
    );
  });

  test("isolates the same contributed class/token across multiple owners with private keys", async () => {
    const LEFT_PRIVATE = createToken<PrivateDependency>("LeftOwnedPrivateDependency");
    const RIGHT_PRIVATE = createToken<PrivateDependency>("RightOwnedPrivateDependency");
    const declaration = (dependency: typeof LEFT_PRIVATE, key: string): ProviderDeclaration => ({
      definition: scoped(OwnedCapability, OwnedCapability, [dependency] as const),
      payload: Object.freeze({ key }),
    });
    const left = testModule("LeftFeatureModule", {
      providers: [DI.singleton(DI.valueProvider(LEFT_PRIVATE, { value: "left" }))],
      exports: [],
      ownedProviderDeclarations: [declaration(LEFT_PRIVATE, "left.reserve")],
    } as TestContributionMetadata);
    const right = testModule("RightFeatureModule", {
      providers: [DI.singleton(DI.valueProvider(RIGHT_PRIVATE, { value: "right" }))],
      exports: [],
      ownedProviderDeclarations: [declaration(RIGHT_PRIVATE, "right.reserve")],
    } as TestContributionMetadata);

    const container = createContainer(testModule("AppModule", { imports: [left, right], exports: [] }));
    const records = container.getModuleOwnedProviderContributions(PROVIDER_CHANNEL);
    const scope = container.createScope();
    expect(records).toHaveLength(2);
    expect(records[0]?.activation.activate(scope).dependency.value).toBe("left");
    expect(records[1]?.activation.activate(scope).dependency.value).toBe("right");
    await scope.dispose();
    await container.dispose();
  });

  test("accepts only unkeyed scoped self-class definitions", () => {
    const invalidDefinitions: readonly ProviderDefinition<OwnedCapability>[] = [
      DI.singleton(DI.classProvider(OwnedCapability, OwnedCapability, [PRIVATE_DEPENDENCY] as const)),
      DI.keyedScoped("public-key", DI.classProvider(OwnedCapability, OwnedCapability, [PRIVATE_DEPENDENCY] as const)),
      DI.scoped(DI.factoryProvider(OwnedCapability, [PRIVATE_DEPENDENCY] as const, (dependency) =>
        new OwnedCapability(dependency))),
    ];

    for (const definition of invalidDefinitions) {
      const feature = moduleWith({
        ownedProviderDeclarations: [
          { definition, payload: Object.freeze({ key: "orders.reserve" }) },
        ],
      });
      expect(() => createContainer(testModule("AppModule", { imports: [feature] }))).toThrow(
        /unkeyed scoped self-class definition/,
      );
    }
  });

  test("attaches to the exact existing owner scoped provider without an alias", async () => {
    const definition = capabilityDefinition();
    const feature = moduleWith({
      providers: [singleton(PRIVATE_DEPENDENCY, PrivateDependencyService), definition],
      exports: [],
      attachedProviderDeclarations: [{ definition, payload: Object.freeze({ key: "orders.attached" }) }],
    });
    const container = createContainer(testModule("AppModule", { imports: [feature], exports: [] }));
    const record = container.getModuleOwnedProviderContributions(PROVIDER_CHANNEL)[0]!;
    const scope = container.createScope();
    expect(record.activation.activate(scope)).toBe(scope.resolve(OwnedCapability));
    expect(container.has(OwnedCapability)).toBe(true);
    await scope.dispose();
    await container.dispose();
  });

  test("rejects an attached provider which is missing, foreign, duplicate, or not scoped", () => {
    const declaration = { definition: capabilityDefinition(), payload: Object.freeze({ key: "orders.attached" }) };
    const missing = moduleWith({ exports: [], attachedProviderDeclarations: [declaration] });
    expect(() => createContainer(testModule("AppModule", { imports: [missing], exports: [] }))).toThrow(/is missing/);

    const foreign = moduleWith({ exports: [], attachedProviderDeclarations: [declaration] });
    const owner = testModule("OtherModule", { providers: [declaration.definition], exports: [] });
    expect(() => createContainer(testModule("AppModule", { imports: [foreign, owner], exports: [] }))).toThrow(/is missing/);

    const duplicate = moduleWith({ providers: [declaration.definition, declaration.definition], exports: [], attachedProviderDeclarations: [declaration] });
    expect(() => createContainer(testModule("AppModule", { imports: [duplicate], exports: [] }))).toThrow(/is duplicated/);

    const singletonDefinition = singleton(OwnedCapability, OwnedCapability, [PRIVATE_DEPENDENCY] as const);
    const wrongLifetime = moduleWith({ providers: [singletonDefinition], exports: [], attachedProviderDeclarations: [{ definition: singletonDefinition as ProviderDefinition<OwnedCapability>, payload: declaration.payload }] });
    expect(() => createContainer(testModule("AppModule", { imports: [wrongLifetime], exports: [] }))).toThrow(/is missing/);
  });
});
