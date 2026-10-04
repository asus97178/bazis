export class ResolutionScopeState {
  public readonly cache = new Map<number, unknown>();
  // In-flight async creations: dedupes concurrent resolveAsync of the same registration.
  public readonly pendingAsync = new Map<number, Promise<unknown>>();
  // Active async activation wait edges, keyed by registration identity. They
  // are scope-local because scoped registrations may be active independently
  // in different scopes.
  public readonly pendingWaits = new Map<number, Set<number>>();
  public readonly pendingAsyncActivationIds = new Map<number, number>();
  /** Active executions by concrete activation identity. */
  public readonly activeActivationIds = new Set<number>();
  // Every async resolution (including transients), so disposal cannot race a late-created resource.
  public readonly pendingCreations = new Set<Promise<unknown>>();
  public readonly disposables: unknown[] = [];
  public disposed = false;
  public disposalPromise?: Promise<void>;

  public constructor(public readonly isRoot: boolean) {}
}
