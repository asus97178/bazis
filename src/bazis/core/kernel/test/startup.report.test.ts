import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, DI, ServiceValidationError, type BazisModuleRef, type HostedService } from "../../di";
import { PLAIN, Screen } from "../../../library/terminal";
import {
  Bazis,
  ConfigValidationError,
  StartupFailuresError,
  StartupReport,
  defineConfig,
  memorySource,
  secret,
} from "../index";
import { diagnoseStartupFailure } from "../report/startupProblems";
import { StartupScreen } from "../report/StartupScreen";

function buffer() {
  let text = "";
  return { output: { write: (chunk: string) => { text += chunk; }, isTTY: false }, text: () => text };
}

describe("configuration errors", () => {
  test("every invalid key of every config comes in one error with its variable and file", async () => {
    const db = defineConfig("db", { default: { port: 5432, password: secret() } });
    const mail = defineConfig("mail", { default: { mode: "smtp", apiKey: secret("dev-key") } });
    const build = Bazis.createBuilder({ config: [db, mail] })
      .useEnvironment("production")
      .useStartupReport(false)
      .addConfigSource(memorySource({ db: { port: "abc" } }))
      .build();
    const error = await build.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigValidationError);
    const issues = (error as ConfigValidationError).issues;
    expect(issues.map((issue) => [issue.key, issue.kind])).toEqual([
      ["db.port", "number"],
      ["db.password", "missing-secret"],
      ["mail.apiKey", "development-secret"],
    ]);
    expect(issues[0]?.env).toEqual(["BAZIS_DB__PORT"]);
    expect(issues[0]?.declaredIn).toMatch(/startup\.report\.test\.ts:\d+$/);
    // The message stays one readable line for logs.
    expect((error as Error).message).toContain('db.port — expected a finite number, got "abc"');
  });
});

describe("concurrent start", () => {
  function service(name: string, log: string[], outcome: "ok" | "fail", gate?: Promise<void>): HostedService {
    return {
      diagnosticName: name,
      concurrentStart: true,
      phase: -100,
      async start() {
        log.push(`start:${name}`);
        await gate;
        if (outcome === "fail") throw new Error(`${name} refused`);
      },
      stop() { log.push(`stop:${name}`); },
    };
  }

  function app(services: readonly HostedService[]): BazisModuleRef {
    return { providers: services.map((item) => DI.singleton(DI.valueProvider(HOSTED_SERVICE, item))) };
  }

  test("connections start together and every failure is reported at once", async () => {
    const log: string[] = [];
    const gate = Promise.withResolvers<void>();
    const kernel = await Bazis.createBuilder(app([
      service("infra:db", log, "fail", gate.promise),
      service("infra:cache", log, "fail", gate.promise),
      service("infra:search", log, "ok", gate.promise),
    ])).useEnvironment("test").useStartupReport(false).build();
    const started = kernel.start().then(() => undefined, (error: unknown) => error);
    await Bun.sleep(5);
    // All three are running before any of them finished.
    expect(log).toEqual(["start:infra:db", "start:infra:cache", "start:infra:search"]);
    gate.resolve();
    const error = await started;
    expect(error).toBeInstanceOf(StartupFailuresError);
    expect((error as StartupFailuresError).failures.map((failure) => failure.name)).toEqual(["infra:db", "infra:cache"]);
    // The one that came up is rolled back.
    expect(log).toContain("stop:infra:search");
    expect(kernel.failedServices).toEqual(["infra:db", "infra:cache"]);
  });

  test("a single failure keeps its own error", async () => {
    const log: string[] = [];
    const kernel = await Bazis.createBuilder(app([service("infra:db", log, "fail"), service("infra:cache", log, "ok")]))
      .useEnvironment("test").useStartupReport(false).build();
    const error = await kernel.start().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("infra:db refused");
  });
});

describe("startup screen", () => {
  test("a configuration failure names every key, its variable and the stages it stopped", async () => {
    const db = defineConfig("db", { default: { password: secret() } });
    const error = await Bazis.createBuilder({ config: db }).useEnvironment("production").useStartupReport(false).build()
      .then(() => undefined, (caught: unknown) => caught);
    const out = buffer(), err = buffer();
    new StartupScreen({ stdout: out.output, stderr: err.output, language: "en", header: false }).failed(error);
    const text = err.text();
    expect(text).toContain("FAILED   configuration is invalid · 1 problem");
    expect(text).toContain("[CONFIG] db.password");
    expect(text).toContain("required secret is not set");
    expect(text).toContain("set BAZIS_DB__PASSWORD");
    expect(text).toContain("not checked — configuration is invalid");
  });

  test("a module without a database gets one problem that says how to connect it", () => {
    const screen = new Screen(buffer().output, { language: "en", style: PLAIN });
    const missing = diagnoseStartupFailure(new ServiceValidationError([
      'Missing dependency "DatabaseProvider" for "TaskDbContext"',
      'Missing dependency "DatabaseProvider" for "IHostedService"',
      'Missing dependency "DatabaseProvider" for "OrdersDbContext"',
    ]), screen);
    expect(missing.stage).toBe("modules");
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]?.cause).toContain("TaskDbContext, OrdersDbContext");
    expect(missing.problems[0]?.fixes?.[0]).toContain("@Infra({ db: ormBazisConnect(dbConfig) })");
  });

  test("refused connections become one problem each with the variables to check", () => {
    const report = new StartupReport(true);
    report.connection({ name: "db", status: "down", kind: "PostgreSQL", address: "app@127.0.0.1:5432/app", settings: ["BAZIS_DB__HOST", "BAZIS_DB__USERNAME", "BAZIS_DB__PASSWORD"], error: new Error('Infra connector "database": cannot connect: password authentication failed for user "app"') });
    report.connection({ name: "cache", status: "down", kind: "Redis", address: "127.0.0.1:6390", settings: ["BAZIS_REDIS__URL"], error: new Error('Infra connector "redis": failed to connect to redis://127.0.0.1:6390 within 5000 ms.') });
    report.connection({ name: "search", status: "up", kind: "OpenSearch 2.17.1" });
    const screen = new Screen(buffer().output, { language: "en", style: PLAIN });
    const diagnosis = diagnoseStartupFailure(new StartupFailuresError([]), screen, { report });
    expect(diagnosis.stage).toBe("infrastructure");
    expect(diagnosis.title).toBe("infrastructure is down · 2 of 3 connections");
    expect(diagnosis.problems.map((problem) => problem.where)).toEqual(["db · app@127.0.0.1:5432/app", "cache · 127.0.0.1:6390"]);
    expect(diagnosis.problems[0]?.fixes?.[0]).toBe("check the user and password: BAZIS_DB__USERNAME, BAZIS_DB__PASSWORD");
    expect(diagnosis.problems[1]?.fixes).toEqual(["no answer in time — the server is down or the address is wrong", "address: BAZIS_REDIS__URL"]);
  });

  test("a started application lists its configuration, modules and timing, then the success banner", async () => {
    const config = defineConfig("app", { default: { region: "eu", token: secret("dev-token") } });
    const out = buffer();
    const screen = new StartupScreen({ stdout: out.output, stderr: buffer().output, language: "en", header: false });
    const root: BazisModuleRef = { config };
    const kernel = await Bazis.createBuilder(root).useEnvironment("development").useStartupScreen((started) => screen.started(started)).build();
    kernel.report.schema({ context: "TaskDbContext", mode: "ensureCreated", applied: ["create table tasks"], migrated: [], baselined: [], warnings: [] });
    await kernel.start();
    await kernel.stop();
    const text = out.text();
    expect(text).toContain("CONFIGURATION");
    expect(text).toContain("region eu");
    expect(text).toContain("token ← development default (set BAZIS_APP__TOKEN in production)");
    expect(text).toContain("app.token uses the development default from the code.");
    expect(text).toContain("STARTUP");
    // The count is of database contexts, not of PostgreSQL schemas.
    expect(text).toContain("1 operation · 1 database context");
    expect(text).toContain("SUCCESS");
  });
});
