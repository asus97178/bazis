import { HOSTED_SERVICE, type BazisModuleRef, type DiContainer, type ProviderDefinition, type Token } from "../di";
import { loadBazisGeneratedRuntime } from "../generatedRuntime";
import { HttpServer, type HttpModuleOptions } from "../http";
import { KernelBuilder, type Kernel } from "../kernel";
import { appOptionsOf, composeApp, type AppSettings } from "../app/runApp";

export interface TestContainerOptions {
  /** Replacements for registered providers: `singleton(ITaskStore, FakeStore)`. */
  readonly overrides?: readonly ProviderDefinition[];
  /** Adjust the kernel before it is built: config sources, a logger. */
  readonly configure?: (builder: KernelBuilder) => void;
}

/**
 * A container for module tests: the module graph with the kernel services an
 * application has — `Logger`, `EventBus`, `ConfigView` of declared configs,
 * `Environment` (`test`) — but nothing started: no hosted services, no HTTP.
 * Loads the project's generated code first (without it constructor
 * dependencies are missing and a test passes for the wrong reason).
 *
 * ```ts
 * const container = await createTestContainer(TaskModule, { overrides: [singleton(ITaskStore, FakeStore)] });
 * const tasks = container.createScope().resolve(TaskService);
 * ```
 *
 * Given an `@App` class, the graph also holds its infrastructure, cache and configs.
 */
export async function createTestContainer(root: BazisModuleRef, options: TestContainerOptions = {}): Promise<DiContainer> {
  await loadBazisGeneratedRuntime();
  const declared = appOptionsOf(root);
  const graph = declared === undefined ? root : composeApp(root, { infra: declared.infra, cache: declared.cache, config: declared.config, language: declared.language, messages: declared.messages });
  const builder = new KernelBuilder(graph).useOptions({ startupReport: false, environment: "test", signals: [] });
  options.configure?.(builder);
  if (options.overrides !== undefined) builder.useOverrides(options.overrides);
  const kernel: Kernel = await builder.build();
  return kernel.container;
}

/**
 * What a test changes in the application it starts. For an `@App` class every
 * field replaces the declared one; for a module it is the whole description.
 */
export interface TestAppOptions extends Omit<AppSettings, "http"> {
  /**
   * HTTP options; the test app always listens on 127.0.0.1 and a free port.
   * `false`: no HTTP server. Left out: the `http` of the `@App` class; a module
   * (or an `@App` without `http`, given other HTTP options here) gets a server with the defaults.
   */
  readonly http?: Omit<HttpModuleOptions, "port" | "hostname"> | false;
  /** Replacements for registered providers, see `createContainer` `overrides`. */
  readonly overrides?: readonly ProviderDefinition[];
}

export interface TestApp {
  /** `http://127.0.0.1:<port>`; empty without an HTTP server. */
  readonly url: string;
  /** `fetch` relative to {@link url}: `app.fetch("/tasks/1")`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Calls a service the way a request does: in a scope of its own, closed when
   * the work is done.
   *
   * ```ts
   * const task = await app.use(ITaskService, (tasks) => tasks.create("Write the report"));
   * ```
   */
  use<T, R>(service: Token<T>, work: (service: T) => R | Promise<R>): Promise<R>;
  /** The application container, when {@link use} is not enough: singletons, several services of one scope. */
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
 * const app = await startTestApp(TodoApp, { overrides: [singleton(ITaskStore, FakeStore)] });
 * try {
 *   expect((await app.fetch("/tasks/1")).status).toBe(200);
 * } finally {
 *   await app.stop();
 * }
 * ```
 *
 * `root` is the `@App` class: the test starts what production starts, and the
 * options only say what differs. A single module works too, to test a part of
 * the application: `startTestApp(TaskModule, { infra: TestInfra })`.
 */
export async function startTestApp(root: BazisModuleRef, options: TestAppOptions = {}): Promise<TestApp> {
  await loadBazisGeneratedRuntime();
  const declared = appOptionsOf(root);
  const { modules: _modules, ...base } = declared ?? { modules: [] };
  const merged: TestAppOptions & { readonly http?: HttpModuleOptions | Omit<HttpModuleOptions, "port" | "hostname"> | false } = { ...base, ...options };
  const { http: _http, overrides, configure, kernel: kernelOptions, ...rest } = merged;
  // A worker application (an `@App` without `http`) stays without a server unless the test asks for one.
  const serve = options.http !== false && (declared === undefined || declared.http !== undefined || options.http !== undefined);
  const http = options.http === false ? undefined : { ...declared?.http, ...options.http };
  const appRoot = composeApp(root, { ...rest, http: serve ? { ...http, hostname: "127.0.0.1", port: 0 } : undefined });
  const builder = new KernelBuilder(appRoot).useOptions({ startupReport: false, ...kernelOptions, environment: kernelOptions?.environment ?? "test", signals: [] });
  if (declared !== undefined) builder.useApplicationRoot(root);
  declared?.configure?.(builder);
  if (configure !== declared?.configure) configure?.(builder);
  if (overrides !== undefined) builder.useOverrides(overrides);
  const kernel: Kernel = await builder.build();
  await kernel.start();
  const server = kernel.container.resolveAll(HOSTED_SERVICE).find((service): service is HttpServer => service instanceof HttpServer);
  const url = server ? `http://127.0.0.1:${server.port}` : "";
  return {
    url,
    container: kernel.container,
    use: async (service, work) => {
      const scope = kernel.container.createScope();
      try {
        return await work(scope.resolve(service));
      } finally {
        await scope.dispose();
      }
    },
    fetch: (path, init) => {
      if (!url) throw new Error("startTestApp was started with http: false.");
      return fetch(`${url}${path}`, init);
    },
    stop: () => kernel.stop(),
  };
}
