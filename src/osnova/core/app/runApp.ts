import {
  collectModuleUiProfiles,
  collectModuleControllers,
  DI,
  Global,
  Module,
  singletonValue,
  type OsnovaModuleRef,
} from "../di";
import { loadOsnovaGeneratedRuntime } from "../generatedRuntime";
import { httpModule, useModelValidator, type HttpModuleOptions, type ModelValidator } from "../http";
import { grpcModule, type GrpcModuleOptions } from "../grpc";
import { buildHttpOpenApiDocument } from "../http/OpenApi/openApiDocument";
import { KernelBuilder, Osnova, type KernelOptions, type ValidatableConfig } from "../kernel";
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
 * Опции запуска приложения. Всё необязательно: без `http` и `grpc` приложение
 * стартует как воркер/CLI (только ядро и hosted-сервисы).
 */
export interface RunAppOptions {
  /**
   * Поднять HTTP-сервер. Контроллеры собираются из всего дерева модулей
   * автоматически — перечислять их не нужно. Передай `{}` для значений по
   * умолчанию (порт 3000) или объект с настройками (port/prefix/cors/...).
   */
  readonly http?: HttpModuleOptions;
  /** gRPC server; discovers feature-module grpcControllers, independently of HTTP. */
  readonly grpc?: GrpcModuleOptions;
  /** Опции ядра (окружение, таймаут остановки, сигналы, ...). */
  readonly kernel?: KernelOptions;
  /**
   * Валидатор request-моделей. По умолчанию подключается движок
   * `@/library/validation`. Передай свой, чтобы заменить.
   */
  readonly validator?: ModelValidator;
  /** Тонкая настройка билдера ядра (логгер, конфиг-источники, ...). */
  readonly configure?: (builder: KernelBuilder) => void;
  /**
   * Дополнительные декларативные конфиги (`defineConfig`), если они не
   * принадлежат конкретному модулю. Обычно configs живут рядом с владельцем:
   * `@Infra` приносит configs коннекторов, а feature-модуль — свой `config`.
   * Каждый config проверяется на старте (fail-fast): отсутствующие секреты и
   * неверные значения роняют запуск сразу.
   */
  readonly config?: ValidatableConfig | readonly ValidatableConfig[];
  /**
   * Манифест инфраструктуры — класс с `@Infra` (или результат `infraModule(...)`).
   * Это global-модуль с коннекторами (БД/кэш/поиск): клиенты регистрируются под
   * своими токенами, соединения открываются до серверов и гасятся после них.
   *
   * ```ts
   * await runApp(AppModule, { infra: AppInfra, http: { port: 3000 } });
   * ```
   */
  readonly infra?: OsnovaModuleRef;
  /**
   * Кэш приложения как self-installing значение. Передай `memory({ ... })` для
   * in-memory кэша. Распределённый Redis-backend включается отдельно через
   * `infra: AppInfra` (`redisConnect(redisConfig, { cache: "distributed" })`).
   * Регистрирует `ICache`, включает `@OutputCache`/`@Cacheable` и health-check.
   *
   * ```ts
   * import { memory } from "@/core/cache";
   * await runApp(AppModule, { cache: memory({ maxEntries: 1000 }), http: {} });
   * ```
   */
  readonly cache?: OsnovaModuleRef;
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
  root: OsnovaModuleRef,
  option: RunAppOptions["ui"],
  http: HttpModuleOptions | undefined,
): OsnovaModuleRef {
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
  class OsnovaUiModule {}

  @Module({
    imports: [OsnovaUiModule],
    controllers: [
      DI.bindDeps(UiSurfaceHttpController, UiSurfaceDocumentProvider),
    ],
  })
  class OsnovaUiHttpModule {}

  return { imports: [OsnovaUiModule, OsnovaUiHttpModule, root] };
}

/** @internal Resolves module-owned `@UiProfile` declarations before DI wiring. */
export function resolveUiProfiles(
  root: OsnovaModuleRef,
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
  root: OsnovaModuleRef,
  http: HttpModuleOptions,
): ReturnType<typeof buildHttpOpenApiDocument> {
  const docs = typeof http.docs === "object" && http.docs !== null ? http.docs : undefined;
  return buildHttpOpenApiDocument({
    controllers: collectModuleControllers([root]),
    globalPrefix: http.prefix,
    versioning: http.versioning,
    title: docs?.title ?? "Osnova UI profiles",
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
      name: option.app?.name ?? "Osnova",
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
 * Единая точка входа приложения — проще, чем `NestFactory`.
 *
 * ```ts
 * // main.ts
 * import { runApp } from "@/core/app";
 * import { AppModule } from "./modules/App.module";
 *
 * await runApp(AppModule, { http: { port: 3000, prefix: "api" } });
 * ```
 *
 * Делает за тебя три вещи, которые иначе пришлось бы писать руками:
 * 1. поднимает HTTP-сервер и собирает контроллеры из всего дерева модулей;
 * 2. подключает валидатор тела запросов (DIP-склейка ядра и библиотеки);
 * 3. запускает ядро с graceful shutdown по SIGINT/SIGTERM.
 *
 * Корневой модуль остаётся чистым: `@Module({ imports: [UsersModule] })`.
 */
export async function runApp(root: OsnovaModuleRef, options: RunAppOptions = {}): Promise<number> {
  const configure = options.configure;
  await loadOsnovaGeneratedRuntime();

  // Инфраструктура и кэш — global-модули; добавляем их в граф рядом с корнем фич.
  const globals: OsnovaModuleRef[] = [];
  if (options.infra !== undefined) {
    globals.push(options.infra);
  }
  if (options.cache !== undefined) {
    globals.push(options.cache);
  }
  const appRoot: OsnovaModuleRef =
    globals.length > 0 || options.config !== undefined
      ? {
          imports: [...globals, root],
          ...(options.config !== undefined ? { config: options.config } : {}),
        }
      : root;

  if (options.http !== undefined) {
    // Склейка валидации делается в композиционном корне (ядро HTTP знает только
    // про порт `ModelValidator`, а движок валидации — это библиотека).
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
    const runtimeRoot = options.grpc === undefined ? httpRoot : {
      imports: [httpRoot, grpcModule({ ...options.grpc, validator: options.grpc.validator === undefined ? validator : options.grpc.validator, imports: [appRoot, ...(options.grpc.imports ?? [])] })],
    };
    return Osnova.run(runtimeRoot, options.kernel, configure);
  }

  if (options.validator) {
    useModelValidator(options.validator);
  }
  const runtimeRoot = withUiRuntime(appRoot, options.ui, undefined);
  const transportRoot = options.grpc === undefined ? runtimeRoot
    : grpcModule({ ...options.grpc, validator: options.grpc.validator === undefined ? options.validator ?? modelValidatorAdapter : options.grpc.validator, imports: [runtimeRoot, ...(options.grpc.imports ?? [])] });
  return Osnova.run(transportRoot, options.kernel, configure);
}
