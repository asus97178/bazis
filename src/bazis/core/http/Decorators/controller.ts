import { ownMeta } from "./metadata";

/**
 * Marks a class as an HTTP controller with an optional base path:
 *
 * ```ts
 * @Controller("users")
 * class UsersController {
 *   @Get(":id(int)")
 *   getUser(id: number) { ... }
 * }
 * ```
 *
 * The controller is a regular DI service: register it in a module
 * (`controllers: [...]` on `BazisModule`, or `httpModule({ controllers: [...] })`)
 * with scoped lifetime and declare constructor dependencies as usual — auto deps work.
 */
export function Controller(prefix = "") {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    const meta = ownMeta(context.metadata);
    meta.isController = true;
    meta.prefix = prefix;
  };
}
