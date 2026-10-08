import {
  collectModuleUiProfiles,
  collectModuleControllers,
  DI,
  Global,
  Module,
  singletonValue,
  type BazisModuleRef,
} from "../di";
import { loadBazisGeneratedRuntime } from "../generatedRuntime";
import { httpModule, useModelValidator, type HttpModuleOptions, type ModelValidator } from "../http";
import { grpcModule, type GrpcModuleOptions } from "../grpc";
import { buildHttpOpenApiDocument } from "../http/OpenApi/openApiDocument";
import { KernelBuilder, Bazis, type KernelOptions, type ValidatableConfig } from "../kernel";
import {
  isUiProfileAuthoringClass,
  type UiProfileV1,
} from "../../library/ui";
import { modelValidatorAdapter } from "../../library/validation";
import {
  type RunAppUiOptions,
  type RunAppUiSurfaceOptions,
  type UiSurfaceHostingOptions,
} from "./ui/uiSurfaceHosting";
import { resolveUiProfileAuthoringV1, UiProfileV1Registry, type UiLabels } from "./ui/uiProfileResolver";
import { UiSurfaceDocumentProvider, UiSurfaceHttpController } from "./ui/uiSurfaceHttp";

/**
 * Application start options. Everything is optional: without `http` and `grpc` the app
 * starts as a worker/CLI (kernel and hosted services only).
 */
export interface RunAppOptions {
  /**
   * Start the HTTP server. Controllers are collected from the whole module tree
   * automatically, no need to list them. Pass `{}` for the defaults
   * (port 3000) or an object with settings (port/prefix/cors/...).
   */
  readonly http?: HttpModuleOptions;
  /** gRPC server; discovers feature-module grpcControllers, independently of HTTP. */
  readonly grpc?: GrpcModuleOptions;
  /** Kernel options (environment, shutdown timeout, signals, ...). */
  readonly kernel?: KernelOptions;
  /**
   * Request-model validator. The `@/library/validation` engine is used by
   * default. Pass your own to replace it.
   */
  readonly validator?: ModelValidator;
  /** Fine-tuning of the kernel builder (logger, config sources, ...). */
  readonly configure?: (builder: KernelBuilder) => void;
  /**
   * Additional declarative configs (`defineConfig`) that do not belong to a
   * specific module. Usually configs live next to their owner: `@Infra` brings
   * connector configs, and a feature module brings its own `config`.
   * Every config is checked at startup (fail-fast): missing secrets and
   * invalid values stop the start immediately.
   */
  readonly config?: ValidatableConfig | readonly ValidatableConfig[];
  /**
   * Infrastructure manifest: a class with `@Infra` (or the result of `infraModule(...)`).
   * It is a global module with connectors (DB/cache/search): clients are registered under
   * their tokens, connections open before the servers and close after them.
   *
   * ```ts
   * await runApp(AppModule, { infra: AppInfra, http: { port: 3000 } });
   * ```
   */
  readonly infra?: BazisModuleRef;
  /**
   * Application cache as a self-installing value. Pass `memory({ ... })` for
   * an in-memory cache. The distributed Redis backend is enabled separately via
   * `infra: AppInfra` (`redisConnect(redisConfig, { cache: "distributed" })`).
   * Registers `ICache`, enables `@OutputCache`/`@Cacheable` and a health check.
   *
   * ```ts
   * import { memory } from "@/core/cache";
   * await runApp(AppModule, { cache: memory({ maxEntries: 1000 }), http: {} });
   * ```
   */
  readonly cache?: BazisModuleRef;
  /**
   * Declarative UI surface hosting. Feature modules contribute reference-based
   * `@UiProfile` declarations through module `uiProfiles` metadata. Explicit
   * surfaces expose protected `/ui/:surface`, `/openapi` and `/session`
   * endpoints. Every published surface must provide authorization, a monotonic
   * policy projection and a safe session mapper.
   */
  readonly ui?: RunAppUiOptions;
}

function withUiRuntime(
  root: BazisModuleRef,
  option: RunAppOptions["ui"],
  http: HttpModuleOptions | undefined,
): BazisModuleRef {
  const declarations = collectModuleUiProfiles([root]);
  const openApi = http === undefined ? undefined : buildUiOpenApiDocument(root, http);
  const profiles = resolveUiProfiles(root, declarations, http, openApi, option?.labels);
  const profileRegistry = new UiProfileV1Registry(profiles, openApi);
  const httpOptions = http === undefined ? undefined : normalizeUiSurfaceHostingOptions(option, http);
  if (httpOptions === undefined || openApi === undefined) {
    return root;
  }
  const surfaceDocuments = new UiSurfaceDocumentProvider(httpOptions, profileRegistry, openApi);

  @Global()
  @Module({
    providers: [singletonValue(UiSurfaceDocumentProvider, surfaceDocuments)],
    exports: [UiSurfaceDocumentProvider],
  })
  class BazisUiModule {}

  @Module({
    imports: [BazisUiModule],
    controllers: [
      DI.bindDeps(UiSurfaceHttpController, UiSurfaceDocumentProvider),
    ],
  })
  class BazisUiHttpModule {}

  return { imports: [BazisUiModule, BazisUiHttpModule, root] };
}

/** @internal Resolves module-owned `@UiProfile` declarations before DI wiring. */
export function resolveUiProfiles(
  root: BazisModuleRef,
  declarations: readonly unknown[],
  http: HttpModuleOptions | undefined,
  prebuiltOpenApi?: ReturnType<typeof buildHttpOpenApiDocument>,
  labels?: UiLabels,
): readonly UiProfileV1[] {
  const authoring: object[] = [];
  for (const declaration of declarations) {
    if (isUiProfileAuthoringClass(declaration)) {
      authoring.push(declaration);
      continue;
    }
    throw new TypeError(
      `uiProfiles declaration ${declarationName(declaration)} must use @UiProfile().`,
    );
  }
  if (authoring.length === 0) {
    return [];
  }

  const openApi = prebuiltOpenApi ?? buildUiOpenApiDocument(root, http ?? {});
  const profiles: UiProfileV1[] = [];
  for (const declaration of authoring) {
    const result = resolveUiProfileAuthoringV1({ declaration, openApi, labels });
    if (!result.ok) {
      const details = result.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("\n");
      throw new TypeError(`@UiProfile resolution failed:\n${details}`);
    }
    profiles.push(...result.profiles);
  }
  return Object.freeze(profiles);
}

function buildUiOpenApiDocument(
  root: BazisModuleRef,
  http: HttpModuleOptions,
): ReturnType<typeof buildHttpOpenApiDocument> {
  const docs = typeof http.docs === "object" && http.docs !== null ? http.docs : undefined;
  return buildHttpOpenApiDocument({
    controllers: collectModuleControllers([root]),
    globalPrefix: http.prefix,
    versioning: http.versioning,
    title: docs?.title ?? "Bazis UI profiles",
    version: docs?.version ?? "1.0.0",
  });
}

function declarationName(value: unknown): string {
  if (typeof value === "function") {
    return value.name || "<anonymous>";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

/** @internal Exported for hosting contract tests. */
export function normalizeUiSurfaceHostingOptions(
  option: RunAppOptions["ui"],
  http: HttpModuleOptions,
): UiSurfaceHostingOptions | undefined {
  if (option === undefined) {
    return undefined;
  }
  requirePublishedSurfaces(option.surfaces);
  return {
    app: {
      name: option.app?.name ?? "Bazis",
      version: option.app?.version ?? "1.0.0",
    },
    ...uiSurfaceHostingPaths(http),
    surfaces: option.surfaces,
  };
}

function requirePublishedSurfaces(surfaces: readonly RunAppUiSurfaceOptions[]): void {
  if (surfaces.length === 0) {
    throw new TypeError("UI hosting requires at least one explicitly registered surface.");
  }
}

function uiSurfaceHostingPaths(http: HttpModuleOptions): Pick<UiSurfaceHostingOptions, "apiBasePath"> {
  const prefix = http.prefix?.trim() ?? "";
  return {
    apiBasePath: prefix.length === 0 ? "/" : normalizeAbsolutePath(prefix),
  };
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim();
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `/${prefixed.split("/").filter((part) => part.length > 0).join("/")}`;
}

/**
 * The single application entry point, simpler than `NestFactory`.
 *
 * ```ts
 * // main.ts
 * import { runApp } from "@/core/app";
 * import { AppModule } from "./modules/App.module";
 *
 * await runApp(AppModule, { http: { port: 3000, prefix: "api" } });
 * ```
 *
 * It does three things you would otherwise write by hand:
 * 1. starts the HTTP server and collects controllers from the whole module tree;
 * 2. plugs in the request body validator (DIP glue between the kernel and the library);
 * 3. starts the kernel with graceful shutdown on SIGINT/SIGTERM.
 *
 * The root module stays clean: `@Module({ imports: [UsersModule] })`.
 */
export async function runApp(root: BazisModuleRef, options: RunAppOptions = {}): Promise<number> {
  await loadBazisGeneratedRuntime();
  return Bazis.run(composeApp(root, options), options.kernel, options.configure);
}

/**
 * @internal The application root `runApp` starts: infrastructure, cache and
 * configs next to the feature root, wrapped in the HTTP/gRPC/UI hosts the
 * options ask for. Shared with `startTestApp`, so tests run the same graph.
 */
export function composeApp(root: BazisModuleRef, options: RunAppOptions = {}): BazisModuleRef {
  // Infrastructure and cache are global modules; add them to the graph next to the feature root.
  const globals: BazisModuleRef[] = [];
  if (options.infra !== undefined) {
    globals.push(options.infra);
  }
  if (options.cache !== undefined) {
    globals.push(options.cache);
  }
  const appRoot: BazisModuleRef =
    globals.length > 0 || options.config !== undefined
      ? {
          imports: [...globals, root],
          ...(options.config !== undefined ? { config: options.config } : {}),
        }
      : root;

  if (options.http !== undefined) {
    // Validation is glued in the composition root (the HTTP kernel only knows
    // the `ModelValidator` port; the validation engine is a library).
    const validator = options.validator ?? modelValidatorAdapter;
    // Keep the legacy bridge for direct bindModel() callers, while also
    // passing an instance-owned validator to the HTTP server. Capturing it per
    // server prevents another app in the same process from changing validation
    // behavior after startup.
    useModelValidator(validator);

    const httpAppRoot = withUiRuntime(
      { imports: [appRoot, ...(options.http.imports ?? [])] },
      options.ui,
      options.http,
    );
    const httpRoot = httpModule({
      ...options.http,
      validator,
      imports: [httpAppRoot],
    });
    return options.grpc === undefined ? httpRoot : {
      imports: [httpRoot, grpcModule({ ...options.grpc, validator: options.grpc.validator === undefined ? validator : options.grpc.validator, imports: [appRoot, ...(options.grpc.imports ?? [])] })],
    };
  }

  if (options.validator) {
    useModelValidator(options.validator);
  }
  const runtimeRoot = withUiRuntime(appRoot, options.ui, undefined);
  return options.grpc === undefined ? runtimeRoot
    : grpcModule({ ...options.grpc, validator: options.grpc.validator === undefined ? options.validator ?? modelValidatorAdapter : options.grpc.validator, imports: [runtimeRoot, ...(options.grpc.imports ?? [])] });
}
