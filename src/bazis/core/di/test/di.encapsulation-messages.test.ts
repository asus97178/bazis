import { expect, test } from "bun:test";
import { DI, Module, ModuleEncapsulationError, createContainer, createToken, singletonValue } from "../index";

// The error tells why a provided service is not visible: the owner does not
// export it, or the consumer does not import the owner. Both used to read
// "provided by another module but not exported".
const CLOCK = createToken<string>("Clock");
const REPORT = createToken<string>("Report");

function messageOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof ModuleEncapsulationError) return error.message;
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
    `Module "ReportModule": "Report" depends on "Clock", which module "ClockModule" exports, but "ReportModule" does not import "ClockModule". Add "ClockModule" to the imports of "ReportModule".`,
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
