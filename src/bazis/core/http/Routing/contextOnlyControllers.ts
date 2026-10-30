const contextOnly = new WeakSet<object>();

/**
 * @internal Marks a framework controller whose actions read the `HttpContext`
 * themselves. The application's codegen never covers framework classes, so a
 * stale application codegen says nothing about them and must not stop the start.
 */
export function contextOnlyController<T extends object>(controller: T): T {
  contextOnly.add(controller);
  return controller;
}

/** @internal */
export function isContextOnlyController(controller: object): boolean {
  return contextOnly.has(controller);
}
