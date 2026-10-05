import type { HostedService } from "../../extensions/hosted-service";
import type { ProviderDefinition } from "../../provider";
import type { Class, OpenGenericTokenFamily, Token } from "../../token";
import type { DiRegistrar } from "./DiRegistrar";

/** What a module can expose to its importers: a token, a class-token or an open generic family. */
export type ModuleExport = Token<unknown> | OpenGenericTokenFamily<unknown, unknown>;

/** A config the module brings into the application, to be validated at startup. */
export interface ModuleConfig {
  ensureValid(environment?: "development" | "test" | "production"): void;
}

/** Module metadata (no name: the name comes from the class through `@Module`). */
export interface OsnvModuleMetadata {
  readonly imports?: readonly OsnvModuleRef[];
  /**
   * Declarative configs owned by the module. `runApp` collects them from the
   * module tree and calls `ensureValid()` before the container is built and the
   * servers start. This keeps, for example, `jwtConfig` inside `AuthModule`
   * rather than in `index.ts`.
   */
  readonly config?: ModuleConfig | readonly ModuleConfig[];
  readonly providers?: readonly ProviderDefinition[];
  /**
   * HTTP controllers of the module (classes with `@Controller`). Registered scoped,
   * one instance per request. `httpModule` collects them from `imports` for
   * routing; an explicit `controllers` in `httpModule({ ... })` remains for
   * backward compatibility.
   */
  readonly controllers?: readonly Class<object>[];
  /**
   * `@UiProfile()` declarations owned by this module. The DI layer keeps them
   * opaque; `runApp` resolves their controller/request/response references and
   * compiles the profiles per published surface.
   */
  readonly uiProfiles?: readonly unknown[];
  /**
   * Background / hosted services of the module (subclasses of
   * `BackgroundService` / `PeriodicBackgroundService`, or any `HostedService`).
   * Each is registered as a singleton (with auto-resolved constructor
   * dependencies) and exposed as a `HOSTED_SERVICE`, so the kernel starts it on
   * boot and gracefully stops it on shutdown — no manual `HOSTED_SERVICE`
   * factory wiring needed.
   */
  readonly background?: readonly Class<HostedService>[];
  /**
   * Encapsulation contract:
   * - omitted — the module is fully open (all providers visible to importers);
   * - present — only the listed tokens/families are visible to importers,
   *   everything else is private. `exports: []` makes the module fully private.
   *
   * Visibility is validated at `createContainer` time (build-time, zero
   * runtime cost). The root container itself is a composition root and can
   * resolve anything.
   */
  readonly exports?: readonly ModuleExport[];
  /**
   * Global module (like NestJS `@Global()`): its exported tokens are visible
   * to every module in the graph without an explicit import. Reserved for
   * infrastructure (kernel environment, configuration, lifetime).
   */
  readonly global?: boolean;
  configure?(di: DiRegistrar): void;
}

/** Module class with metadata on its constructor (`@Module`). */
export type OsnvModule = OsnvModuleMetadata & (abstract new (...args: never) => unknown);

/** A module class (`@Module`) or plain metadata returned by module factories (`ormModule`, `memory()`, `infraModule`). */
export type OsnvModuleRef = OsnvModule | OsnvModuleMetadata;
