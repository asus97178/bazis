import { expect, test } from "bun:test";
import { Module } from "../../di";
import { KernelBuilder, type Logger } from "../../kernel";
import { composeApp } from "../runApp";

@Module({ exports: [] })
class App {}

function recording() {
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug: () => {}, warn: () => {}, error: () => {},
    info: (message, fields) => void lines.push({ message, fields: fields as Record<string, unknown> | undefined }),
  };
  return { logger, lines };
}

test("production prints the started line with the address, and the stopped line", async () => {
  const { logger, lines } = recording();
  const kernel = await new KernelBuilder(composeApp(App, { http: { hostname: "127.0.0.1", port: 0, health: true } }))
    .useEnvironment("production").useLogger(logger).build();
  await kernel.start();
  const started = lines.find((line) => line.message === "bazis started");
  expect(started?.fields?.environment).toBe("production");
  expect(started?.fields?.listening).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);

  await kernel.stop({ exitCode: 0, signal: "SIGTERM" });
  const stopped = lines.find((line) => line.message === "bazis stopped");
  expect(stopped?.fields).toMatchObject({ signal: "SIGTERM", exitCode: 0 });
  expect(typeof stopped?.fields?.shutdownMs).toBe("number");
});

test("useStartupReport(false) prints neither line", async () => {
  const { logger, lines } = recording();
  const kernel = await new KernelBuilder(composeApp(App)).useEnvironment("production").useStartupReport(false).useLogger(logger).build();
  await kernel.start();
  await kernel.stop();
  expect(lines.map((line) => line.message)).not.toContain("bazis started");
  expect(lines.map((line) => line.message)).not.toContain("bazis stopped");
});
