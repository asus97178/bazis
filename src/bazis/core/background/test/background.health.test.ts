import { describe, expect, test } from "bun:test";
import { Module } from "@/core/di";
import { startTestApp } from "@/core/testing";
import { BackgroundService, PeriodicBackgroundService } from "../index";

// 0.98.33: /health reports a background service that stopped for good.

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

class Crasher extends BackgroundService {
  constructor() { super({ restart: { maxRestarts: 0 } }); }
  runs = 0;
  protected override async execute(): Promise<void> { this.runs++; throw new Error("cannot connect password=hunter2"); }
}

class FlakyThenFine extends BackgroundService {
  constructor() { super({ restart: { maxRestarts: 3, backoffMs: 1 } }); }
  runs = 0;
  protected override async execute(signal: AbortSignal): Promise<void> {
    this.runs++;
    if (this.runs < 3) throw new Error("not yet");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

class GivesUp extends BackgroundService {
  constructor() { super({ restart: { maxRestarts: 2, backoffMs: 1 } }); }
  runs = 0;
  protected override async execute(): Promise<void> { this.runs++; throw new Error("still down"); }
}

class FailingTicks extends PeriodicBackgroundService {
  constructor() { super({ intervalMs: 5 }); }
  ticks = 0;
  protected override async tick(): Promise<void> { this.ticks++; throw new Error("tick failed"); }
}

class Finishes extends BackgroundService {
  done = false;
  protected override async execute(): Promise<void> { this.done = true; }
}

const quiet = { error() {}, warn() {} };

describe("BackgroundService.checkHealth", () => {
  test("a crash without restarts, and used-up restarts, are unhealthy with the reason", async () => {
    const crasher = new Crasher(); crasher.useDiagnostics(quiet);
    expect(crasher.checkHealth()).toEqual({ healthy: true });
    crasher.start();
    await eventually(() => !crasher.checkHealth().healthy);
    expect(crasher.checkHealth()).toEqual({ healthy: false, details: "stopped after a crash and will not run again (no restart policy): cannot connect password=hunter2" });
    await crasher.stop();

    const givesUp = new GivesUp(); givesUp.useDiagnostics(quiet);
    givesUp.start();
    await eventually(() => !givesUp.checkHealth().healthy);
    expect(givesUp.runs).toBe(3);
    expect(givesUp.checkHealth().details).toBe("stopped after 2 restarts and will not run again: still down");
    await givesUp.stop();
  });

  test("restarts that succeed, failing ticks and a normal end stay healthy", async () => {
    const flaky = new FlakyThenFine(); flaky.useDiagnostics(quiet);
    flaky.start();
    await eventually(() => flaky.runs === 3);
    expect(flaky.checkHealth()).toEqual({ healthy: true });
    await flaky.stop();

    const ticks = new FailingTicks(); ticks.useDiagnostics(quiet);
    ticks.start();
    await eventually(() => ticks.ticks >= 3);
    expect(ticks.checkHealth()).toEqual({ healthy: true });
    await ticks.stop();

    const finishes = new Finishes();
    finishes.start();
    await eventually(() => finishes.done);
    expect(finishes.checkHealth()).toEqual({ healthy: true });
    await finishes.stop();
  });
});

describe("/health and background services of a module", () => {
  test("a dead worker turns /health into 503 with background:<Class>; details stay hidden by default", async () => {
    @Module({ background: [Crasher, FailingTicks] })
    class Workers {}
    const app = await startTestApp(Workers, { http: { health: true }, configure: (builder) => builder.useLogger({ debug() {}, info() {}, warn() {}, error() {} }) });
    try {
      const crasher = app.container.resolve(Crasher);
      await eventually(() => crasher.runs === 1);
      await eventually(() => !crasher.checkHealth().healthy);
      const response = await app.fetch("/health");
      expect(response.status).toBe(503);
      const report = await response.json() as { healthy: boolean; checks: { name: string; healthy: boolean; details?: string }[] };
      expect(report.healthy).toBe(false);
      expect(report.checks.map((check) => [check.name, check.healthy])).toEqual([["background:Crasher", false], ["background:FailingTicks", true]]);
      expect(JSON.stringify(report)).not.toContain("hunter2");
    } finally {
      await app.stop();
    }
  });

  test("with exposeDetails the reason is shown redacted", async () => {
    @Module({ background: [Crasher] })
    class Workers {}
    const app = await startTestApp(Workers, { http: { health: { exposeDetails: true } }, configure: (builder) => builder.useLogger({ debug() {}, info() {}, warn() {}, error() {} }) });
    try {
      await eventually(() => !app.container.resolve(Crasher).checkHealth().healthy);
      const report = await (await app.fetch("/health")).json() as { checks: { name: string; details?: string }[] };
      expect(report.checks[0]).toMatchObject({ name: "background:Crasher", details: "stopped after a crash and will not run again (no restart policy): cannot connect password=***" });
    } finally {
      await app.stop();
    }
  });
});
