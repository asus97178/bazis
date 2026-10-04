import type { OsnovaModuleMetadata } from "./types";

const OSNV_MODULE_MARKER = Symbol.for("@osnova/core/di/module");

/**
 * Registers module metadata on the decorated class (NestJS-style).
 *
 * ```ts
 * @Module({
 *   imports: [ormModule({ context: UsersDbContext, entities: [User] })],
 *   controllers: [UsersController],
 *   providers: [scoped(IUserStore, UserService)],
 *   exports: [IUserStore],
 * })
 * export class UsersModule {}
 * ```
 *
 * Combine with {@link Global} for infrastructure modules:
 *
 * ```ts
 * @Global()
 * @Module({ providers: [...], exports: [DATABASE_PROVIDER] })
 * export class OrmRootModule {}
 * ```
 *
 * Static modules: `@Module` on the exported class (`OpenSearchLoggingModule`).
 * Inline overrides: factory `openSearchLoggingModule(config)` (see `@/core/infra/opensearch`).
 */
export function Module(metadata: OsnovaModuleMetadata) {
  return (target: abstract new (...args: never) => unknown, _context: ClassDecoratorContext): void => {
    Object.assign(target, metadata);
    Object.defineProperty(target, OSNV_MODULE_MARKER, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  };
}

/** @internal Distinguishes decorated module classes from profile factory functions. */
export function isOsnovaModuleClass(value: unknown): value is abstract new (...args: never) => unknown {
  return typeof value === "function" && Reflect.get(value, OSNV_MODULE_MARKER) === true;
}
