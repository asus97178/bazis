import { afterEach, describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, type BazisModuleRef, type HostedService } from "../../di";
import { APPLICATION_STARTED, APPLICATION_STOPPING, Bazis, LIFECYCLE_HOOK, onEvent, type LifecycleHook } from "../index";

function hosted(log: string[], name: string, phase: number): HostedService {
  return { phase, start: () => void log.push(`start:${name}`), stop: () => void log.push(`stop:${name}`) };
}

function app(log: string[]): BazisModuleRef {
  const hook: LifecycleHook = {
    onInit: () => void log.push("hook:init"),
    onBootstrap: () => void log.push("hook:bootstrap"),
    onShutdown: () => void log.push("hook:shutdown"),
    onDestroy: () => void log.push("hook:destroy"),
  };
  return {
    providers: [
      DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "db", -110))),
      DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "schema", -105))),
      DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "worker", 0))),
      DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "http", 10))),
      DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, hook)),
      onEvent(APPLICATION_STARTED, () => void log.push("event:started")),
      onEvent(APPLICATION_STOPPING, () => void log.push("event:stopping")),
    ],
  };
}

const builder = (moduleRef: BazisModuleRef) => Bazis.createBuilder(moduleRef).useEnvironment("production").useStartupReport(false).useSignals([]);

afterEach(() => {
  delete process.env.BAZIS_SCHEMA_ONLY;
});

describe("schema-only start (0.98.30)", () => {
  test("starts only the infrastructure and the schema, then stops with exit code 0", async () => {
    const log: string[] = [];
    const kernel = await builder(app(log)).useOptions({ schemaOnly: true }).build();
    kernel.lifetime.onStarted(() => void log.push("lifetime:started"));
    kernel.lifetime.onStopping(() => void log.push("lifetime:stopping"));

    expect(await kernel.run()).toBe(0);
    expect(log).toEqual(["start:db", "start:schema", "stop:schema", "stop:db"]);
  });

  test("BAZIS_SCHEMA_ONLY=1 turns it on; an explicit option wins", async () => {
    process.env.BAZIS_SCHEMA_ONLY = "1";
    const log: string[] = [];
    expect(await (await builder(app(log)).build()).run()).toBe(0);
    expect(log).toEqual(["start:db", "start:schema", "stop:schema", "stop:db"]);

    const full: string[] = [];
    const kernel = await builder(app(full)).useOptions({ schemaOnly: false }).build();
    await kernel.start();
    await kernel.stop();
    // The same graph without the mode starts everything and announces it.
    expect(full).toEqual(expect.arrayContaining(["hook:init", "start:worker", "start:http", "hook:bootstrap", "event:started", "event:stopping", "hook:destroy"]));
  });

  test("a failing schema step fails the run like a normal start", async () => {
    const log: string[] = [];
    const broken: BazisModuleRef = {
      providers: [
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, hosted(log, "db", -110))),
        DI.singleton(DI.valueProvider(HOSTED_SERVICE, { phase: -105, start: () => { throw new Error("must be owner of table notes"); }, stop: () => undefined })),
      ],
    };
    const kernel = await builder(broken).useOptions({ schemaOnly: true }).build();
    await expect(kernel.run()).rejects.toThrow("must be owner of table notes");
    expect(log).toEqual(["start:db", "stop:db"]);
  });

  test("an unknown BAZIS_SCHEMA_ONLY value stops the build", async () => {
    process.env.BAZIS_SCHEMA_ONLY = "yes";
    await expect(builder(app([])).build()).rejects.toThrow('BAZIS_SCHEMA_ONLY must be 1, true, 0 or false, got "yes".');
  });
});
