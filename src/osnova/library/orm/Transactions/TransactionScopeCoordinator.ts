import { AsyncLocalStorage } from "node:async_hooks";
import type { DbContext } from "../DbContext";
import { ConcurrentTransactionScopeError, OrmDatabaseTimeError, OrmProviderIdentityMismatchError, OrmTransactionScopeError } from "../errors";
import { baseProvider, withPostgresScopeOptions, createObservedProvider, postgresTransactionCapability, rootAuthority, withProviderDispatchObserver, withoutProviderDispatchObserver, type CancellableProviderDispatch } from "../Providers/ormTransactionRuntime";
import type { DatabaseProvider } from "../Providers/types";
import { OrmTransaction, type OrmDatabaseTimeV1, type OrmTransactionScopeOptions } from "./OrmTransaction";

import { isUnknownTransactionOutcome, TransactionOutcomeUnknownError } from "../Providers/transactionOutcome";
import { OperationDeadline, positiveTimeout } from "../Providers/operationDeadline";

interface Frame {
  readonly allEnrolled: Set<object>;
  readonly id: symbol;
  readonly authority: object;
  readonly provider: DatabaseProvider;
  readonly enrolled: ReadonlySet<object>;
  readonly parent?: Frame;
  state: "active" | "closing" | "revoked";
  activeChild?: symbol;
  activeChildFrame?: Frame;
  rollbackOnly?: unknown;
  cancellationRequested?: boolean;
  readonly pending: Set<PendingTask>;
  readonly abortPromise: Promise<never>;
  abort(error: OrmTransactionScopeError): void;
  readonly cancellationPromise: Promise<"cancelled">;
  cancelDrain(): void;
}
interface PendingTask {
  readonly frame: Frame;
  readonly dispatches: Set<CancellableProviderDispatch>;
  readonly attached: Set<Promise<unknown>>;
  promise: Promise<unknown>;
  settled: boolean;
  readonly kind: "user" | "save" | "provider" | "immediate";
  readonly underlying: Promise<unknown>;
  abort?: (error: OrmTransactionScopeError) => void;
  /** A SaveExecutor task has crossed validation and must restore its tracker
   * before rollback callbacks even when the caller-facing projection aborts. */
  requiresFrameworkUnwind?: boolean;
}

interface View { readonly frame: Frame; readonly enrolled: ReadonlySet<object>; }
const views = new AsyncLocalStorage<View>();
const currentTasks = new AsyncLocalStorage<PendingTask>();
const uncertainContexts = new WeakSet<object>();
const contextTokens = new WeakMap<object, object>();
const contextProviders = new WeakMap<object, DatabaseProvider>();

/** Private, non-barrel signal: SaveExecutor uses it to suppress retries only
 * in a coordinator-owned ORM scope, never in arbitrary provider transactions. */
export function isNewOrmTransactionScopeActive(): boolean {
  return views.getStore()?.frame.state === "active";
}

export function contextToken(context: object): object {
  let token = contextTokens.get(context);
  if (!token) { token = {}; contextTokens.set(context, token); }
  return token;
}

export function observedProvider(context: object, provider: DatabaseProvider): DatabaseProvider {
  contextProviders.set(context, provider);
  const token = contextToken(context);
  const authority = rootAuthority(provider);
  const fence = <T>(operation: () => Promise<T>, view = views.getStore()): Promise<T> => {
    if (uncertainContexts.has(token)) return Promise.reject(new TransactionOutcomeUnknownError());
    const guarded = () => operation().catch((error) => { if (postgresTransactionCapability(provider)?.isOutcomeUncertain?.(error)) uncertainContexts.add(token); throw error; });
    if (!view) return guarded();
    const frame = view.frame;
    if (frame.authority !== authority || !view.enrolled.has(token) || frame.state !== "active" || frame.activeChild !== undefined) {
      return Promise.reject(new OrmTransactionScopeError());
    }
    return trackTask(frame, guarded);
  };
  return createObservedProvider(provider, (operation) => fence(operation), () => {
    const captured = views.getStore();
    return (operation) => {
      if (!captured) return fence(operation);
      return fence(operation, captured);
    };
  });
}

/** Registers a whole ORM task before async validation or provider dispatch begins. */
export function monitorWholeOperation<T>(context: object, operation: () => Promise<T>): Promise<T> {
  if (uncertainContexts.has(contextToken(context))) return Promise.reject(new TransactionOutcomeUnknownError());
  const view = views.getStore();
  if (!view) return operation();
  if (!view.enrolled.has(contextToken(context)) || view.frame.state !== "active" || view.frame.activeChild !== undefined) return Promise.reject(new OrmTransactionScopeError());
  // Save work must not inherit a forever `use` callback task: only its
  // post-validation unwind is framework-owned during physical quarantine.
  return trackTask(view.frame, operation, "save", true);
}

/** A separate synchronous enrollment for immediate DML. */
export function monitorImmediateOperation<T>(context: object, operation: () => T | Promise<T>): Promise<T> {
  if (uncertainContexts.has(contextToken(context))) return Promise.reject(new TransactionOutcomeUnknownError());
  const view = views.getStore();
  const token = contextToken(context);
  const run = () => Promise.resolve().then(() => {
    if (view && (!view.enrolled.has(token) || view.frame.state !== "active" || view.frame.activeChild !== undefined)) throw new OrmTransactionScopeError();
    return operation();
  });
  if (!view) return run();
  if (!view.enrolled.has(token) || view.frame.state !== "active" || view.frame.activeChild !== undefined) return Promise.reject(new OrmTransactionScopeError());
  return trackTask(view.frame, run, "immediate", true);
}

/** Private SaveExecutor marker.  Deliberately no-ops outside an ORM scope. */
export function markCurrentSaveRequiresUnwind(): void {
  const frame = views.getStore()?.frame;
  if (!frame) return;
  const task = currentTasks.getStore();
  if (!task || task.kind !== "save" || task.frame !== frame || !frame.pending.has(task) || frame.state !== "active") {
    throw new OrmTransactionScopeError("ORM save lost its active transaction task.");
  }
  task.requiresFrameworkUnwind = true;
}

/** A root ORM task is registered before its first async turn; driver dispatches
 * inherit it through ALS and therefore cannot escape when a callback settles. */
function trackTask<T>(frame: Frame, operation: () => Promise<T>, kind: PendingTask["kind"] = "user", distinct = false): Promise<T> {
  const parent = currentTasks.getStore();
  if (!distinct && parent?.frame === frame && frame.pending.has(parent)) {
    const promise = Promise.resolve().then(() => { if (frame.state !== "active") throw new OrmTransactionScopeError(); return operation(); });
    parent.attached.add(promise);
    void promise.catch(() => { frame.rollbackOnly ??= new OrmTransactionScopeError(); });
    promise.finally(() => { parent.attached.delete(promise); releaseTask(parent); }).catch(() => {});
    return Promise.race([promise, frame.abortPromise]);
  }
  let abort!: (error: OrmTransactionScopeError) => void;
  const abortProjection = new Promise<never>((_, reject) => { abort = reject; });
  const task: PendingTask = { frame, kind, dispatches: new Set(), attached: new Set(), promise: Promise.resolve(), underlying: Promise.resolve(), abort, settled: false };
  frame.pending.add(task);
  const underlying = Promise.resolve().then(() => {
    if (frame.state !== "active") throw new OrmTransactionScopeError();
    return currentTasks.run(task, operation);
  });
  task.promise = underlying;
  (task as { underlying: Promise<unknown> }).underlying = underlying;
  void underlying.catch(() => { frame.rollbackOnly ??= new OrmTransactionScopeError(); });
  underlying.finally(() => { task.settled = true; releaseTask(task); }).catch(() => {});
  // Permanent rejection sink makes detached hostile user tails safe.
  void abortProjection.catch(() => {});
  return Promise.race([underlying, abortProjection]);
}

function releaseTask(task: PendingTask): void {
  if (task.settled && task.dispatches.size === 0 && task.attached.size === 0) task.frame.pending.delete(task);
}

export async function transactionScope<TResult>(context: DbContext, provider: DatabaseProvider, work: (transaction: OrmTransaction) => Promise<TResult>, options?: OrmTransactionScopeOptions): Promise<TResult> {
  let signal = options?.signal;
  if (options?.timeoutMs !== undefined) positiveTimeout(options.timeoutMs, 30_000, "timeoutMs");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("ORM transaction signal must be an AbortSignal.");
  const assertNotAborted = () => { if (signal?.aborted) throw new OrmTransactionScopeError("ORM transaction scope was aborted."); };
  assertNotAborted();
  const token = contextToken(context);
  if (uncertainContexts.has(token)) throw new TransactionOutcomeUnknownError();
  const authority = rootAuthority(provider);
  const current = views.getStore();
  if (current) {
    if (current.frame.authority !== authority || !current.enrolled.has(token) || current.frame.state !== "active") throw new OrmProviderIdentityMismatchError();
    if (current.frame.activeChild !== undefined) throw new ConcurrentTransactionScopeError();
  }
  const base = baseProvider(provider);
  if (!base || !base.transactionScope) throw new OrmTransactionScopeError("ORM transaction scopes require a provider with transactionScope support.");
  const postgres = postgresTransactionCapability(base);
  if (!postgres) throw new OrmTransactionScopeError("ORM transaction provider capability is unavailable.");
  const uncertain = (error: unknown) => postgres.isOutcomeUncertain ? postgres.isOutcomeUncertain(error) : isUnknownTransactionOutcome(error);
  const inheritedSignal = postgres.operationSignal?.();
  const timeoutMs = positiveTimeout(options?.timeoutMs, postgres.operationTimeoutMs ?? 30_000, "timeoutMs");
  const deadline = new OperationDeadline(timeoutMs, signal && inheritedSignal ? AbortSignal.any([signal, inheritedSignal]) : signal ?? inheritedSignal);
  signal = deadline.signal;
  const parent = current?.frame;
  const ownership = Symbol("orm transaction child");
  if (parent) parent.activeChild = ownership;
  // This record is inserted synchronously, before `base.transactionScope()`
  // can reach its first SAVEPOINT await. A parent callback that forgets to
  // await its child therefore cannot commit around an orphaned savepoint.
  let settleParentTask: (() => void) | undefined;
  let parentTask: PendingTask | undefined;
  if (parent) {
    const promise = new Promise<void>((resolve) => { settleParentTask = resolve; });
    parentTask = { frame: parent, kind: "user", dispatches: new Set(), attached: new Set(), promise, underlying: promise, settled: false };
    parent.pending.add(parentTask);
  }
  let childFrame: Frame | undefined;
  try {
    return await withPostgresScopeOptions({ signal, timeoutMs }, () => base.transactionScope!(async () => {
      assertNotAborted();
      try { await postgres.assertScopedClose(); } catch { throw new OrmTransactionScopeError("ORM transaction scoped-session close capability is unavailable."); }
      assertNotAborted();
      if (parent && parent.state !== "active") {
        throw new OrmTransactionScopeError("Nested ORM transaction scope started after its parent began closing.");
      }
      // A savepoint gets a distinct frame. It inherits enrollment but never
      // shares pending state or closing/revocation with its parent.
      let abort!: (error: OrmTransactionScopeError) => void;
      const abortPromise = new Promise<never>((_, reject) => { abort = reject; });
      // A detached child has a caller-facing projection without pretending
      // that arbitrary user JS itself became cancellable.
      void abortPromise.catch(() => {});
      let cancelDrain!: () => void;
      const cancellationPromise = new Promise<"cancelled">((resolve) => { cancelDrain = () => resolve("cancelled"); });
      const frame: Frame = { allEnrolled: new Set([token]), id: Symbol("orm transaction"), authority, provider: base, parent, enrolled: parent ? current!.enrolled : new Set([token]), state: "active", pending: new Set(), abortPromise, abort, cancellationPromise, cancelDrain }; childFrame = frame;
      if (parent) parent.activeChildFrame = frame;
      const view: View = { frame, enrolled: frame.enrolled };
      return withProviderDispatchObserver((dispatch) => registerDispatch(frame, dispatch), () => views.run(view, async () => {
        const transaction = new ScopedOrmTransaction(frame);
        const onAbort = () => {
          const error = new OrmTransactionScopeError("ORM transaction scope was aborted.");
          // Fence synchronously: a callback catching its aborted operation
          // cannot enqueue another query before asynchronous close starts.
          for (let target: Frame | undefined = frame; target; target = target.activeChildFrame) {
            target.cancellationRequested = true;
            target.rollbackOnly ??= error;
            target.state = "closing";
            target.cancelDrain();
            target.abort(error);
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        let result: TResult | undefined;
        let failed = false;
        let failure: unknown;
        try {
          const callbackWork = Promise.resolve().then(() => { assertNotAborted(); return work(transaction); });
          // The original callback may resume/reject after its forced abort
          // projection; retain a sink and the stale-frame SQL fence.
          void callbackWork.catch(() => {});
          result = await Promise.race([callbackWork, frame.abortPromise]);
        } catch (error) {
          failed = true;
          failure = error;
          frame.rollbackOnly ??= error;
        } finally {
          frame.state = "closing";
          try { await closeActiveChild(frame); await settleFrame(frame); } catch (error) { failed = true; if (uncertain(error)) { failure = error; for (let f: Frame | undefined = frame; f; f = f.parent) for (const token of f.allEnrolled) uncertainContexts.add(token); } else failure ??= error; }
          frame.state = "revoked";
          // COMMIT and its known-outcome callbacks belong to the provider.
          signal?.removeEventListener("abort", onAbort);
        }
        if (failed) throw failure;
        if (frame.rollbackOnly !== undefined) throw frame.rollbackOnly;
        return result as TResult;
      }));
    }));
  } catch (error) {
    if (uncertain(error)) { uncertainContexts.add(token); if (childFrame) for (const t of childFrame.allEnrolled) uncertainContexts.add(t); }
    throw error;
  } finally {
    deadline.dispose();
    if (parent?.activeChild === ownership) parent.activeChild = undefined;
    if (parent && parent.activeChildFrame === childFrame) parent.activeChildFrame = undefined;
    if (parentTask) { parentTask.settled = true; releaseTask(parentTask); }
    settleParentTask?.();
  }
}

async function closeActiveChild(frame: Frame): Promise<void> {
  const child = frame.activeChildFrame;
  if (!child || child.state !== "active") return;
  child.rollbackOnly ??= new OrmTransactionScopeError("Parent ORM transaction scope began closing.");
  child.abort(child.rollbackOnly instanceof OrmTransactionScopeError ? child.rollbackOnly : new OrmTransactionScopeError("Parent ORM transaction scope began closing."));
  child.state = "closing";
  try { await closeActiveChild(child); await settleFrame(child); } finally { child.state = "revoked"; }
}

function registerDispatch(frame: Frame, dispatch: CancellableProviderDispatch): void {
  if (frame.state !== "active") {
    try { void Promise.resolve(dispatch.cancel()).catch(() => {}); } catch { /* the closing owner handles quarantine */ }
    void Promise.resolve(dispatch.settled).catch(() => {});
    return;
  }
  let task = currentTasks.getStore();
  if (!task || task.frame !== frame || !frame.pending.has(task)) {
    // Provider dispatches started directly by a scope callback still need a
    // root record; normal query/save/use paths inherit one through ALS.
    task = { frame, kind: "provider", dispatches: new Set(), attached: new Set(), promise: Promise.resolve(dispatch.settled), underlying: Promise.resolve(dispatch.settled), settled: false };
    frame.pending.add(task);
    task.promise.finally(() => { task!.settled = true; releaseTask(task!); }).catch(() => {});
  }
  task.dispatches.add(dispatch);
  const settled = Promise.resolve(dispatch.settled);
  // Keep a rejection sink for detached driver promises while preserving the
  // original caller-facing rejection returned by query/execute.
  void settled.catch(() => { frame.rollbackOnly ??= new OrmTransactionScopeError(); });
  settled.finally(() => { task.dispatches.delete(dispatch); releaseTask(task); }).catch(() => {});
}

async function settleFrame(frame: Frame): Promise<void> {
  if (frame.pending.size === 0) return;
  frame.rollbackOnly ??= new OrmTransactionScopeError("ORM transaction scope has unresolved operations.");
  const capability = postgresTransactionCapability(frame.provider);
  const hasDispatch = [...frame.pending].some((task) => task.dispatches.size > 0);
  let quarantine = frame.cancellationRequested || (capability?.quarantineOnPendingDispatch && hasDispatch);
  if (!quarantine) {
    let cancellationFailed!: () => void;
    const failed = new Promise<"failed">((resolve) => { cancellationFailed = () => resolve("failed"); });
    for (const task of frame.pending) {
      for (const dispatch of task.dispatches) {
        try { void Promise.resolve(dispatch.cancel()).catch(cancellationFailed); } catch { cancellationFailed(); }
      }
    }
    // Keep the bounded drain for ordinary JS work and providers with working
    // cancellation. The qualified PostgreSQL owner bypasses it for active SQL.
    const settled = Promise.allSettled([...frame.pending].flatMap((task) => [task.promise, ...task.attached, ...[...task.dispatches].map((dispatch) => dispatch.settled)]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 5_000); });
    try {
      quarantine = await Promise.race([settled.then(() => "settled" as const), deadline, failed, frame.cancellationPromise]) !== "settled";
    } finally { clearTimeout(timer); }
  }
  if (quarantine) {
    if (!capability) throw new OrmTransactionScopeError("ORM transaction scope cannot quarantine this provider.");
    for (let ancestor: Frame | undefined = frame; ancestor; ancestor = ancestor.parent) ancestor.rollbackOnly ??= frame.rollbackOnly;
    let quarantineError: unknown;
    try { await capability.quarantine(); } catch (error) { quarantineError = error; }
    const abort = new OrmTransactionScopeError("ORM transaction scope was physically quarantined.");
    for (let target: Frame | undefined = frame; target; target = target.parent) {
      target.cancellationRequested = true;
      target.cancelDrain();
      target.abort(abort);
    }
    for (const task of frame.pending) task.abort?.(abort);
    if (quarantineError !== undefined) throw quarantineError;
    await Promise.allSettled([...frame.pending].flatMap((task) => [...task.dispatches].map((dispatch) => dispatch.settled)));
    // Only driver dispatches and explicitly marked SaveExecutor unwind are
    // framework-owned. Arbitrary callback/validator promises stay detached;
    // their stale ALS view is already fenced by observedProvider.
    await Promise.allSettled([...frame.pending].filter((task) => task.requiresFrameworkUnwind).map((task) => task.promise));
    throw new OrmTransactionScopeError("ORM transaction scope operations did not settle before close.");
  }
}

const transactionFrames = new WeakMap<ScopedOrmTransaction, Frame>();
class ScopedOrmTransaction extends OrmTransaction {
  constructor(frame: Frame) { super(); transactionFrames.set(this, frame); }

  async use<TContext extends DbContext, TResult>(context: TContext, work: (context: TContext) => Promise<TResult>): Promise<TResult> {
    const frame = this.#requireCurrentFrame();
    const token = contextToken(context);
    const provider = contextProviders.get(context);
    if (!provider || rootAuthority(provider) !== frame.authority) throw new OrmProviderIdentityMismatchError();
    const parent = views.getStore();
    if (!parent || parent.frame !== frame) throw new OrmTransactionScopeError();
    if (uncertainContexts.has(token)) throw new TransactionOutcomeUnknownError();
    for (let target: Frame | undefined = frame; target; target = target.parent) target.allEnrolled.add(token);
    const enrolled = new Set(parent.enrolled); enrolled.add(token);
    return views.run({ frame, enrolled }, () => trackTask(frame, () => work(context)));
  }

  async databaseTime(): Promise<OrmDatabaseTimeV1> {
    const frame = this.#requireCurrentFrame();
    const capability = postgresTransactionCapability(frame.provider);
    if (!capability) throw new OrmDatabaseTimeError();
    return trackTask(frame, async () => {
      try { return await capability.databaseTime(); }
      catch { throw new OrmDatabaseTimeError(); }
    });
  }

  afterCommit(callback: () => void | Promise<void>): void {
    const frame = this.#requireCurrentFrame();
    if (!frame.provider.afterCommit) throw new OrmTransactionScopeError("ORM provider does not support afterCommit callbacks.");
    frame.provider.afterCommit(() => views.exit(() => currentTasks.exit(() => withoutProviderDispatchObserver(callback))));
  }

  #requireCurrentFrame(): Frame {
    const frame = transactionFrames.get(this);
    const view = views.getStore();
    if (!frame || frame.state !== "active" || frame.activeChild !== undefined || !view || view.frame !== frame) throw new OrmTransactionScopeError();
    return frame;
  }
}
