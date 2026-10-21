import { expect, test } from "bun:test";
import { createToken } from "@/core/di";
import { Bazis, KernelError, StartupTimeoutError, defineConfig, secret } from "@/core/kernel";
import { Infra, InfraError, redisConnect, type InfraConnector } from "@/core/infra";

/** A port the OS just handed out and nobody listens on any more. */
function closedPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test("an unreachable Redis fails the start within connectTimeoutMs and names the server without its password", async () => {
  const url = `redis://user:hunter2@127.0.0.1:${closedPort()}`;
  const config = defineConfig("redis", { default: { url: secret(url) } });
  const connector = redisConnect(config, { connectTimeoutMs: 200 });
  const client = connector.create();
  const started = performance.now();
  let failure: unknown;
  try {
    await connector.connect(client);
  } catch (error) {
    failure = error;
  } finally {
    await connector.dispose(client);
  }
  expect(failure).toBeInstanceOf(InfraError);
  expect((failure as Error).message).toMatch(/^Infra connector "redis": failed to connect to redis:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:\d+ within 200 ms\.$/);
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("redisConnect rejects a non-positive connectTimeoutMs", () => {
  const config = defineConfig("redis", { default: { url: secret("redis://127.0.0.1:6379") } });
  expect(() => redisConnect(config, { connectTimeoutMs: 0 })).toThrow("redisConnect connectTimeoutMs must be a positive integer.");
});

test("the startup timeout names the hosted service that is still starting and is not a configuration error", async () => {
  const HANGING = createToken<object>("Hanging");
  const hanging: InfraConnector<object> = {
    token: HANGING,
    create: () => ({}),
    connect: () => new Promise<void>(() => undefined),
    dispose: () => undefined,
  };
  @Infra({ slow: hanging })
  class AppInfra {}
  const kernel = await Bazis.createBuilder(AppInfra).useEnvironment("test").useStartupReport(false)
    .useStartupTimeout(50).useShutdownTimeout(50).build();
  let failure: unknown;
  try {
    await kernel.start();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(StartupTimeoutError);
  expect(failure).not.toBeInstanceOf(KernelError);
  expect((failure as StartupTimeoutError).pending).toBe("infra:slow");
  expect((failure as Error).message).toBe("Application startup did not finish within 50ms; still starting: infra:slow.");
});

// 0.111.2: connectors start together, and the timeout used to name all of them
// ("infra:fast, infra:slow") although only one was still connecting.
test("the startup timeout names only the connector that is still connecting, not the ones started with it", async () => {
  const connector = (name: string, connect: () => Promise<void>): InfraConnector<object> => ({
    token: createToken<object>(name), create: () => ({}), connect, dispose: () => undefined,
  });
  @Infra({ fast: connector("Fast", async () => undefined), slow: connector("Slow", () => new Promise<void>(() => undefined)) })
  class AppInfra {}
  const kernel = await Bazis.createBuilder(AppInfra).useEnvironment("test").useStartupReport(false)
    .useStartupTimeout(50).useShutdownTimeout(50).build();
  const failure = await kernel.start().then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(StartupTimeoutError);
  expect((failure as Error).message).toBe("Application startup did not finish within 50ms; still starting: infra:slow.");
});
