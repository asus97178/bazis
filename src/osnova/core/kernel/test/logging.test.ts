import { describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, type HostedService, type OsnovaModuleRef } from "../../di";
import { ConsoleLogger, LOGGER, Osnova, type Logger } from "../index";

describe("ConsoleLogger", () => {
  test("filters below the minimum level", () => {
    const lines: string[] = [];
    const original = { debug: console.debug, info: console.info };
    console.debug = (m?: unknown) => void lines.push(`debug:${String(m)}`);
    console.info = (m?: unknown) => void lines.push(`info:${String(m)}`);
    try {
      const logger = new ConsoleLogger({ minLevel: "info" });
      logger.debug("hidden");
      logger.info("shown");
      expect(lines.some((l) => l.includes("hidden"))).toBe(false);
      expect(lines.some((l) => l.includes("shown"))).toBe(true);
    } finally {
      console.debug = original.debug;
      console.info = original.info;
    }
  });

  test("appends structured fields as JSON", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (m?: unknown) => void lines.push(String(m));
    try {
      new ConsoleLogger({ name: "app" }).info("hello", { a: 1, b: "x" });
      expect(lines[0]).toBe('[app] info: hello {"a":1,"b":"x"}');
    } finally {
      console.info = original;
    }
  });

  test("redacts sensitive structured fields by default", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (m?: unknown) => void lines.push(String(m));
    try {
      new ConsoleLogger().info("login", {
        user: "alice",
        password: "p@ss",
        nested: { apiKey: "api-secret" },
        authorization: "Bearer abcdefghijk",
      });
      expect(lines[0]).toContain('"user":"alice"');
      expect(lines[0]).toContain('"password":"***"');
      expect(lines[0]).toContain('"apiKey":"***"');
      expect(lines[0]).toContain('"authorization":"***"');
      expect(lines[0]).not.toContain("p@ss");
      expect(lines[0]).not.toContain("api-secret");
      expect(lines[0]).not.toContain("abcdefghijk");
    } finally {
      console.info = original;
    }
  });
});

describe("kernel registers LOGGER", () => {
  test("startup stderr shows nested schema details without collapsing objects or exposing secrets", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/kernel.schema-diagnostic.fixture.ts`], {
      stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("ORM_SCHEMA_MIGRATION_REQUIRED");
      expect(stderr).toContain('Table "public"."dm_table", object "osnova_drill_unexpected"');
      expect(stderr).toContain("column exists in the database but is absent from the ORM model");
      expect(stderr).toContain("expected (ORM): absent; actual (database): present");
      // These lines are nested in verification.differences, beyond the old console depth.
      expect(stderr).toMatch(/expected: \{\s*kind: ['"]absent['"]/);
      expect(stderr).toMatch(/actual: \{\s*kind: ['"]present['"]/);
      expect(stderr).not.toContain("[Object");
      expect(stderr).not.toContain("fixture-password-must-stay-private");
      expect(stderr).toContain("***");
      expect(stderr).toContain("12n");
      expect(stderr).toContain("[Circular]");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
  test("default ConsoleLogger is resolvable; useLogger overrides it", async () => {
    const moduleRef: OsnovaModuleRef = { providers: [] };

    const defaultKernel = await Osnova.createBuilder(moduleRef)
      .useEnvironment("test")
      .useStartupReport(false)
      .build();
    expect(defaultKernel.container.resolve(LOGGER)).toBeInstanceOf(ConsoleLogger);
    await defaultKernel.stop();

    const calls: string[] = [];
    const custom: Logger = {
      debug: () => {},
      info: (m) => void calls.push(m),
      warn: () => {},
      error: () => {},
    };
    const kernel = await Osnova.createBuilder(moduleRef)
      .useEnvironment("test")
      .useStartupReport(true)
      .useLogger(custom)
      .build();
    expect(kernel.container.resolve(LOGGER)).toBe(custom);
    await kernel.start();
    expect(calls.some((m) => m.includes("osnv started"))).toBe(true); // startup report routed through Logger
    await kernel.stop();
  });

  test("Osnova fallback failure logging redacts exceptional data", async () => {
    const lines: unknown[][] = [];
    const originalError = console.error;
    const previousExitCode = process.exitCode ?? 0;
    console.error = (...args: unknown[]) => void lines.push(args);
    try {
      const moduleRef: OsnovaModuleRef = {
        providers: [
          DI.singleton(
            DI.valueProvider(HOSTED_SERVICE, {
              start: () => {
                throw new Error("token=very-secret-token-value");
              },
              stop: () => {},
            } satisfies HostedService),
          ),
        ],
      };

      const exitCode = await Osnova.run(moduleRef, {
        environment: "test",
        startupReport: false,
        signals: [],
      });
      const output = JSON.stringify(lines);
      expect(exitCode).toBe(1);
      expect(output).toContain("***");
      expect(output).not.toContain("very-secret-token-value");
    } finally {
      console.error = originalError;
      process.exitCode = previousExitCode;
    }
  });
});
