import { expect, test } from "bun:test";
import { DI, Module, ModuleEncapsulationError, createContainer, createToken, keyedDependency, singletonValue } from "../index";
import { redactSensitiveText } from "../../../library/redaction";

// The error tells why a provided service is not visible: the owner does not
// export it, or the consumer does not import the owner. Both used to read
// "provided by another module but not exported".
const CLOCK = createToken<string>("Clock");
const REPORT = createToken<string>("Report");

// The console prints DI errors through redactSensitiveText: check that text, so a
// phrase like "token: the" cannot turn into "token: ***" unnoticed.
function messageOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof ModuleEncapsulationError) return redactSensitiveText(error.message);
    throw error;
  }
  throw new Error("expected ModuleEncapsulationError");
}

test("exported by its owner, but the owner is not imported", () => {
  @Module({ providers: [singletonValue(CLOCK, "now")], exports: [CLOCK] })
  class ClockModule {}
  @Module({ providers: [DI.singleton(DI.factoryProvider(REPORT, [CLOCK], (clock) => clock))], exports: [] })
  class ReportModule {}
  @Module({ imports: [ClockModule, ReportModule], exports: [] })
  class AppModule {}
  expect(messageOf(() => createContainer(AppModule))).toContain(
    `Module "ReportModule": "Report" depends on "Clock", which module "ClockModule" exports, but "ReportModule" does not list "ClockModule" in its imports. Add "ClockModule" to the imports of "ReportModule".`,
  );
});

test("imported, but the owner does not export it", () => {
  @Module({ providers: [singletonValue(CLOCK, "now")], exports: [] })
  class ClockModule {}
  @Module({ imports: [ClockModule], providers: [DI.singleton(DI.factoryProvider(REPORT, [CLOCK], (clock) => clock))], exports: [] })
  class ReportModule {}
  expect(messageOf(() => createContainer(ReportModule))).toContain(
    `Module "ReportModule": "Report" depends on "Clock", which module "ClockModule" provides but does not export. Add it to the exports of "ClockModule".`,
  );
});

test("an import sees the token through its own imports but does not export it (0.98.15)", () => {
  // As `ormBazis` does: an unnamed inner module registers and exports the
  // token to its parent; the parent does not pass it on.
  const inner = { providers: [singletonValue(CLOCK, "now")], exports: [CLOCK] };
  @Module({ imports: [inner], exports: [] })
  class ClockModule {}
  @Module({ imports: [ClockModule], providers: [DI.singleton(DI.factoryProvider(REPORT, [CLOCK], (clock) => clock))], exports: [] })
  class ReportModule {}
  expect(messageOf(() => createContainer(ReportModule))).toContain(
    `Module "ReportModule": "Report" depends on "Clock", which its import "ClockModule" receives from its own imports but does not export. Add it to the exports of "ClockModule".`,
  );
});

test("a chain of imports offers to import the owner directly or to re-export", () => {
  @Module({ providers: [singletonValue(CLOCK, "now")], exports: [CLOCK] })
  class ClockModule {}
  @Module({ imports: [ClockModule], exports: [] })
  class ReportModule {}
  @Module({ imports: [ReportModule], providers: [DI.singleton(DI.factoryProvider(REPORT, [CLOCK], (clock) => clock))], exports: [] })
  class AppModule {}
  expect(messageOf(() => createContainer(AppModule))).toContain(
    `Module "AppModule": "Report" depends on "Clock", which its import "ReportModule" receives from "ClockModule" but does not export. Add "ClockModule" to the imports of "AppModule", or add it to the exports of "ReportModule".`,
  );
});

// One implementation per token for the whole application: a second registration
// in the importer becomes the selected one, which the imported module cannot see.
abstract class IClock { abstract now(): string; }
class SystemClock implements IClock { now() { return "system"; } }
class FixedClock implements IClock { now() { return "fixed"; } }
class Report { constructor(readonly clock: IClock) {} }

test("a token registered in two modules names both and says how to fix it", () => {
  @Module({ providers: [DI.singleton(DI.classProvider(IClock, SystemClock)), DI.scoped(DI.classProvider(Report, Report, [IClock] as const))], exports: [IClock, Report] })
  class ClockModule {}
  @Module({ imports: [ClockModule], providers: [DI.singleton(DI.classProvider(IClock, FixedClock))], exports: [] })
  class AppModule {}
  expect(messageOf(() => createContainer(AppModule))).toContain(
    `Module "ClockModule": "Report" depends on "IClock", but "IClock" is registered in "ClockModule" and "AppModule", and the application uses one implementation per token, the last registered one, from "AppModule", which "ClockModule" cannot see. Register "IClock" in one module, or give each implementation its own contract.`,
  );
});

test("the same for a keyed registration", () => {
  @Module({ providers: [DI.keyedSingleton("main", DI.classProvider(IClock, SystemClock)), DI.scoped(DI.classProvider(Report, Report, [keyedDependency(IClock, "main")] as const))], exports: [IClock, Report] })
  class ClockModule {}
  @Module({ imports: [ClockModule], providers: [DI.keyedSingleton("main", DI.classProvider(IClock, FixedClock))], exports: [] })
  class AppModule {}
  expect(messageOf(() => createContainer(AppModule))).toContain(
    `"Report" depends on "IClock" with key "main", but "IClock" with key "main" is registered in "ClockModule" and "AppModule"`,
  );
});

test("a closed generic token names the module to export its family from, skipping unnamed inner modules", async () => {
  const { createOpenGenericTokenFamily } = await import("../index");
  const Store = createOpenGenericTokenFamily<object, string>("Store");
  class Item {}
  const ITEM_STORE = Store.of(Item as never);
  const inner = { providers: [singletonValue(ITEM_STORE, "items")], exports: [Store] };
  @Module({ imports: [inner], exports: [] })
  class ItemsModule {}
  @Module({ imports: [ItemsModule], providers: [DI.singleton(DI.factoryProvider(REPORT, [ITEM_STORE], (store) => store))], exports: [] })
  class ReportModule {}
  const message = messageOf(() => createContainer(ReportModule));
  expect(message).toContain(`Module "ReportModule": "Report" depends on "Store<Item>", which its import "ItemsModule" receives from its own imports but does not export. Add Store (or only Store<Item>) to the exports of "ItemsModule".`);
  expect(message).not.toContain("module#");

  @Module({ imports: [inner], exports: [ITEM_STORE] })
  class OneStoreModule {}
  @Module({ imports: [OneStoreModule], providers: [DI.singleton(DI.factoryProvider(REPORT, [ITEM_STORE], (store) => store))], exports: [] })
  class OneStoreReport {}
  expect(createContainer(OneStoreReport).resolve(REPORT)).toBe("items");
});
