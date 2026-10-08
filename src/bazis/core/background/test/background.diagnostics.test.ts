import { expect, test } from "bun:test";
import { Module } from "../../di";
import { KernelBuilder, type LogFields, type Logger } from "../../kernel";
import { BackgroundService, PeriodicBackgroundService } from "../index";

// Background failures go to the application logger (like HTTP errors since
// 0.97.1), say when restarts ran out, and are honest about a slow stop.
interface Line { readonly level: string; readonly message: string; readonly fields?: LogFields }
function recordingLogger(lines: Line[]): Logger {
  const write = (level: string) => (message: string, fields?: LogFields) => { lines.push({ level, message, fields }); };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(2); };

test("crashes and the end of restarts are logged with the service name", async () => {
  const lines: Line[] = [];
  class Crasher extends BackgroundService {
    runs = 0;
    constructor() { super({ restart: { maxRestarts: 1, backoffMs: 1 } }); }
    protected execute(): void { this.runs += 1; throw new Error("db password=hunter2 refused"); }
  }
  const service = new Crasher();
  service.useDiagnostics(recordingLogger(lines));
  service.start();
  await until(() => lines.length >= 3);
  await service.stop();
  expect(lines.map((line) => `${line.level}: ${line.message}`)).toEqual([
    "error: background Crasher crashed",
    "error: background Crasher crashed",
    "error: background Crasher stopped after 1 restart and will not run again",
  ]);
  expect(lines[0]?.fields).toMatchObject({ service: "Crasher", restarts: 0 });
  expect(JSON.stringify(lines)).toContain("password=***");
  expect(JSON.stringify(lines)).not.toContain("hunter2");
});

test("without a restart policy one crash is final, and the log says so", async () => {
  const lines: Line[] = [];
  class Once extends BackgroundService {
    protected execute(): void { throw new Error("boom"); }
  }
  const service = new Once();
  service.useDiagnostics(recordingLogger(lines));
  service.start();
  await until(() => lines.length >= 2);
  await service.stop();
  expect(lines.map((line) => line.message)).toEqual([
    "background Once crashed",
    "background Once stopped after a crash and will not run again (no restart policy)",
  ]);
});

test("a failing tick and a slow stop are reported through the logger", async () => {
  const lines: Line[] = [];
  class Ticker extends PeriodicBackgroundService {
    constructor() { super({ intervalMs: 1, stopTimeoutMs: 20 }); }
    protected async tick(): Promise<void> { throw new Error("tick failed on purpose"); }
  }
  class Stubborn extends BackgroundService {
    constructor() { super({ stopTimeoutMs: 20 }); }
    protected async execute(): Promise<void> { await Bun.sleep(100); }
  }
  const ticker = new Ticker();
  ticker.useDiagnostics(recordingLogger(lines));
  ticker.start();
  await until(() => lines.length >= 1);
  await ticker.stop();
  expect(lines[0]).toMatchObject({ level: "error", message: "background Ticker tick failed", fields: { service: "Ticker" } });

  const stubborn = new Stubborn();
  const slow: Line[] = [];
  stubborn.useDiagnostics(recordingLogger(slow));
  stubborn.start();
  await stubborn.stop();
  expect(slow).toEqual([{
    level: "warn",
    message: "background Stubborn did not stop within 20ms: shutdown continues, but its unfinished work keeps the process alive until it ends",
    fields: { service: "Stubborn", stopTimeoutMs: 20 },
  }]);
});

test("the kernel passes the application logger to background services", async () => {
  const lines: Line[] = [];
  class Once extends BackgroundService {
    protected execute(): void { throw new Error("boom"); }
  }
  @Module({ background: [Once], exports: [] })
  class App {}
  const kernel = await new KernelBuilder(App).useLogger(recordingLogger(lines)).useStartupReport(false).build();
  await kernel.start();
  await until(() => lines.some((line) => line.message.includes("will not run again")));
  await kernel.stop();
  expect(lines.filter((line) => line.message.startsWith("background ")).map((line) => line.message)).toEqual([
    "background Once crashed",
    "background Once stopped after a crash and will not run again (no restart policy)",
  ]);
});
