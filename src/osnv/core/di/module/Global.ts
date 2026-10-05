import type { OsnvModule, OsnvModuleRef } from "./types";

/**
 * Marks a module as global (NestJS `@Global()`): its exports are visible to every
 * module without an explicit import. Apply above `@Module`:
 *
 * ```ts
 * @Global()
 * @Module({ providers: [...], exports: [DATABASE_PROVIDER] })
 * class OrmRootModule {}
 * ```
 */
export function Global() {
  return (target: abstract new (...args: never) => unknown, _context: ClassDecoratorContext): void => {
    markGlobal(target as OsnvModule);
  };
}

/** Marks a dynamically created module (class or plain metadata) as global, e.g. connection-mode `ormModule({ provider })`. */
export function markGlobal<T extends OsnvModuleRef>(module: T): T {
  if (module.global !== true) {
    Object.assign(module, { global: true });
  }
  return module;
}
