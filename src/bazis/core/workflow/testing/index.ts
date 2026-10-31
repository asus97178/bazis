import { DI } from "../../di";
import { startTestApp, type TestApp, type TestAppOptions } from "../../testing";
import { durationMs } from "../../../library/workflow";
import { WorkflowClock } from "../contracts/WorkflowClock";
import type { WorkflowActor } from "../contracts/types";
import { WorkflowJobs } from "../runtime_module/internal/WorkflowJobs";
import { IWorkflowRuntime, type EmitOptions, type EmitResult, type HistoryEntry, type InstanceDetails, type StartInstance } from "../runtime_module/services/IWorkflowRuntime.service";
import { TasksDbContext } from "../tasks_module/model/Tasks.dbContext";
import { IWorkflowTasks } from "../tasks_module/services/IWorkflowTasks.service";

/** Rounds of `drain` before it gives up: a process that keeps creating due jobs never settles. */
const MAX_ROUNDS = 1000;
const BATCH = 50;
const TEST_ACTOR: WorkflowActor = { kind: "system", id: "test" };

/** A clock that stands still until the test moves it (WORKFLOW-001 §14). */
export class ManualWorkflowClock extends WorkflowClock {
  override readonly manual = true;
  private current: number;

  constructor(start: Date | string = new Date()) {
    super();
    this.current = toTime(start, "now");
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Moves the clock forward by an ISO duration (`PT2H`, `P1D`) or milliseconds. */
  advance(by: string | number): Date {
    const ms = typeof by === "number" ? by : durationMs(by);
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) throw new Error(`advance takes an ISO duration without months and years or milliseconds ≥ 0, not ${JSON.stringify(by)}`);
    this.current += ms;
    return this.now();
  }

  /** Moves the clock forward to a moment. */
  set(to: Date | string): Date {
    const time = toTime(to, "set");
    if (time < this.current) throw new Error(`The workflow clock only moves forward: it is ${this.now().toISOString()}`);
    this.current = time;
    return this.now();
  }
}

export interface TestWorkflowOptions extends TestAppOptions {
  /** Where the workflow clock starts; the current time by default. */
  readonly now?: Date | string;
  /** On whose behalf `start`, `emit` and `complete` act; `{ kind: "system", id: "test" }` by default. */
  readonly actor?: WorkflowActor;
}

/** A started application whose processes run only when the test says so. */
export interface TestWorkflow {
  readonly app: TestApp;
  readonly clock: ManualWorkflowClock;
  now(): Date;
  /** Starts the latest version of a process from its manual start; jobs wait for {@link drain}. */
  start(processKey: string, options?: Partial<StartInstance>): Promise<InstanceDetails>;
  emit(eventKey: string, payload?: unknown, options?: EmitOptions): Promise<EmitResult>;
  /** Completes the user task waiting at `nodeId` (through its task when the Tasks part is there). */
  complete(instanceId: string, nodeId: string, output?: unknown, actor?: WorkflowActor): Promise<InstanceDetails>;
  /** Plans scheduled starts and runs every job due by the workflow clock until none is left; returns how many ran. */
  drain(): Promise<number>;
  /** Moves the clock forward (ISO duration or milliseconds), then {@link drain}. */
  advance(by: string | number): Promise<number>;
  instance(instanceId: string): Promise<InstanceDetails>;
  history(instanceId: string): Promise<readonly HistoryEntry[]>;
  stop(): Promise<void>;
}

/**
 * Starts the application like `startTestApp`, with a {@link ManualWorkflowClock}
 * and no background worker: jobs run only in `drain`, so a test of a process is
 * deterministic. Needs PostgreSQL, as the workflow module does.
 *
 * ```ts
 * const wf = await testWorkflow(AppModule, { now: "2026-11-02T09:00:00Z" });
 * try {
 *   const order = await wf.start("order-approval", { input: { amount: 5000 } });
 *   await wf.drain();
 *   await wf.complete(order.id, "approve", { approved: true });
 *   await wf.advance("PT2H");
 *   expect((await wf.instance(order.id)).status).toBe("completed");
 * } finally {
 *   await wf.stop();
 * }
 * ```
 */
export async function testWorkflow(root: Parameters<typeof startTestApp>[0], options: TestWorkflowOptions = {}): Promise<TestWorkflow> {
  const { now, actor = TEST_ACTOR, overrides = [], ...appOptions } = options;
  const clock = new ManualWorkflowClock(now);
  const app = await startTestApp(root, { ...appOptions, overrides: [...overrides, DI.singleton(DI.valueProvider(WorkflowClock, clock))] });
  const failures: unknown[] = [];
  const jobs = new WorkflowJobs(app.container, (message, error, fields) => failures.push({ message, error, ...fields }));
  const signal = new AbortController().signal;

  const inScope = async <T>(work: (scope: ReturnType<TestApp["container"]["createScope"]>) => Promise<T>): Promise<T> => {
    const scope = app.container.createScope();
    try {
      return await work(scope);
    } finally {
      await scope.dispose();
    }
  };

  const drain = async (): Promise<number> => {
    await jobs.reconcile();
    let ran = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const due = await jobs.claim(BATCH);
      if (due.length === 0) return ran;
      for (const job of due) await jobs.run(job, signal);
      ran += due.length;
      // A failure outside a Tool (a failing Tool is a step result) is a bug the test should see.
      if (failures.length > 0) {
        const found = failures.splice(0);
        throw new AggregateError(found.map((failure) => (failure as { error: unknown }).error), `drain: ${found.length} job(s) failed outside their Tools: ${found.map((failure) => { const { message, error } = failure as { message: string; error: unknown }; return `${message}: ${error instanceof Error ? error.message : String(error)}`; }).join("; ")}`);
      }
    }
    throw new Error(`drain did not settle after ${MAX_ROUNDS} rounds: a process keeps creating due jobs`);
  };

  return {
    app,
    clock,
    now: () => clock.now(),
    start: (processKey, start = {}) => inScope((scope) => scope.resolve(IWorkflowRuntime).start(processKey, { ...start, actor: start.actor ?? actor })),
    emit: (eventKey, payload, emitOptions = {}) => inScope((scope) => scope.resolve(IWorkflowRuntime).emit(eventKey, payload, { ...emitOptions, actor: emitOptions.actor ?? actor })),
    complete: (instanceId, nodeId, output = {}, by = actor) => inScope(async (scope) => {
      const runtime = scope.resolve(IWorkflowRuntime);
      const instance = await runtime.instance(instanceId);
      const token = instance.tokens.find((t) => t.nodeId === nodeId && t.status === "waiting");
      if (!token) {
        const waiting = instance.tokens.filter((t) => t.status === "waiting").map((t) => t.nodeId);
        throw new Error(`No step waits at ${nodeId} in instance ${instanceId} (${instance.status}); waiting: ${waiting.length === 0 ? "none" : waiting.join(", ")}`);
      }
      const tasks = scope.tryResolve(IWorkflowTasks);
      const task = tasks === undefined ? undefined : await scope.resolve(TasksDbContext).tasks.asNoTracking().firstOrDefault((t) => t.tokenId.eq(token.id).and(t.status.in(["open", "claimed"])));
      if (tasks !== undefined && task) {
        await tasks.complete(task.id, output, by);
        return await runtime.instance(instanceId);
      }
      return await runtime.completeToken(token.id, output, by);
    }),
    drain,
    advance: async (by) => {
      clock.advance(by);
      return await drain();
    },
    instance: (instanceId) => inScope((scope) => scope.resolve(IWorkflowRuntime).instance(instanceId)),
    history: (instanceId) => inScope((scope) => scope.resolve(IWorkflowRuntime).history(instanceId)),
    stop: () => app.stop(),
  };
}

function toTime(value: Date | string, what: string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`The workflow clock ${what} must be a date, not ${JSON.stringify(value)}`);
  return time;
}
