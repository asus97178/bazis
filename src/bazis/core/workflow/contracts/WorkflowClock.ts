/**
 * Where the engine takes the time from (WORKFLOW-001 §14): due times of timers,
 * retries, scheduled starts and job delays, the retention cutoff and task marks.
 * Record stamps (`createdAt`, history `at`) stay the database's time. The
 * default is the system clock; tests replace it (`bazis/core/workflow/testing`).
 */
export abstract class WorkflowClock {
  abstract now(): Date;
  /**
   * Time moves only when a test moves it: the worker and retention then leave
   * the jobs to the test's `drain`, so nothing runs behind its back.
   */
  readonly manual?: boolean;
}

/** The system clock. */
export class SystemWorkflowClock extends WorkflowClock {
  now(): Date {
    return new Date();
  }
}
