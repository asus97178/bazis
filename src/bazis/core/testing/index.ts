import { HOSTED_SERVICE, createContainer, type BazisModuleRef, type CreateContainerOptions, type DiContainer, type ProviderDefinition } from "../di";
import { loadBazisGeneratedRuntime } from "../generatedRuntime";
import { HttpServer, type HttpModuleOptions } from "../http";
import { KernelBuilder, type Kernel } from "../kernel";
import { composeApp } from "../app/runApp";
import type { RunAppOptions } from "../app";

/**
 * A container for module tests. Loads the project's generated code first
 * (without it constructor dependencies are missing and a test passes for the
 * wrong reason), then builds the graph with the replacements.
 *
 * ```ts
 * const container = await createTestContainer(TaskModule, { overrides: [singleton(ITaskStore, FakeStore)] });
 * const tasks = container.createScope().resolve(TaskService);
 * ```
 */
export async function createTestContainer(root: BazisModuleRef, options: CreateContainerOptions = {}): Promise<DiContainer> {
  await loadBazisGeneratedRuntime();
  return createContainer(root, { validateOnBuild: true, ...options });
}

export interface TestAppOptions extends Omit<RunAppOptions, "http"> {
  /** HTTP options; the test app always listens on 127.0.0.1 and a free port. `false`: no HTTP server. */
  readonly http?: Omit<HttpModuleOptions, "port" | "hostname"> | false;
  /** Replacements for registered providers, see `createContainer` `overrides`. */
  readonly overrides?: readonly ProviderDefinition[];
}

export interface TestApp {
  /** `http://127.0.0.1:<port>`; empty without an HTTP server. */
  readonly url: string;
  /** `fetch` relative to {@link url}: `app.fetch("/tasks/1")`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The application container: `app.container.createScope().resolve(TaskService)`. */
  readonly container: DiContainer;
  /** Graceful stop, like SIGTERM in a real run. */
  stop(): Promise<void>;
}

/**
 * Starts the application in this process the way `runApp` does, for tests:
 * environment `test`, a free port, no signal handlers, no startup report.
 * Configuration errors and failing startup throw instead of exiting the process.
 *
 * ```ts
 * const app = await startTestApp(AppModule, { overrides: [singleton(ITaskStore, FakeStore)] });
 * try {
 *   expect((await app.fetch("/tasks/1")).status).toBe(200);
 * } finally {
 *   await app.stop();
 * }
 * ```
 */
export async function startTestApp(root: BazisModuleRef, options: TestAppOptions = {}): Promise<TestApp> {
  await loadBazisGeneratedRuntime();
  const { http, overrides, configure, kernel: kernelOptions, ...rest } = options;
  const appRoot = composeApp(root, { ...rest, http: http === false ? undefined : { ...http, hostname: "127.0.0.1", port: 0 } });
  const builder = new KernelBuilder(appRoot).useOptions({ startupReport: false, ...kernelOptions, environment: kernelOptions?.environment ?? "test", signals: [] });
  configure?.(builder);
  if (overrides !== undefined) builder.useOverrides(overrides);
  const kernel: Kernel = await builder.build();
  await kernel.start();
  const server = kernel.container.resolveAll(HOSTED_SERVICE).find((service): service is HttpServer => service instanceof HttpServer);
  const url = server ? `http://127.0.0.1:${server.port}` : "";
  return {
    url,
    container: kernel.container,
    fetch: (path, init) => {
      if (!url) throw new Error("startTestApp was started with http: false.");
      return fetch(`${url}${path}`, init);
    },
    stop: () => kernel.stop(),
  };
}
