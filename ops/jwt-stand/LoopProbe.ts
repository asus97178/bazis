import assert from "node:assert/strict";
import { Histogram } from "./metrics";
import type { SchedulerProbe } from "./SchedulerProbe";

type TimerGap = { sequence: number; fromEpochMs: number; toEpochMs: number; delayMs: number;
  scheduler?: ReturnType<SchedulerProbe["sample"]> };

/** Bounded timer-gap trace. A gap brackets a stall; it does not locate its exact start. */
export class LoopProbe {
  readonly intervalMs = 20;
  private readonly histogram = new Histogram();
  private readonly events: TimerGap[] = [];
  private sequence = 0;
  private previous: number;
  private previousEpoch: number;
  private schedulerAt: number;

  constructor(now = performance.now(), epoch = Date.now(), private readonly scheduler?: SchedulerProbe) {
    this.previous = now;
    this.previousEpoch = epoch;
    this.schedulerAt = now;
    scheduler?.sample(now, epoch);
  }

  sample(now = performance.now(), epoch = Date.now()): void {
    assert(Number.isFinite(now) && Number.isFinite(epoch) && now >= this.previous, "Invalid timer timeline");
    const delayMs = Math.max(0, now - this.previous - this.intervalMs);
    this.histogram.add(delayMs);
    let scheduler;
    if (this.scheduler && (delayMs >= 50 || now - this.schedulerAt >= 100)) {
      scheduler = this.scheduler.sample(now, epoch);
      this.schedulerAt = now;
    }
    if (delayMs >= 50) {
      this.events.push({ sequence: ++this.sequence, fromEpochMs: this.previousEpoch, toEpochMs: epoch, delayMs, ...(scheduler ? { scheduler } : {}) });
      if (this.events.length > 512) this.events.shift();
    }
    this.previous = now;
    this.previousEpoch = epoch;
  }

  snapshot() {
    return { intervalMs: this.intervalMs, thresholdMs: 50, eventsSeen: this.sequence,
      dropped: this.sequence - this.events.length, timerDelay: this.histogram.result(), events: this.events.slice(),
      scheduler: this.scheduler?.diagnostics() };
  }
}
