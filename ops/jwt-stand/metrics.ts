import assert from "node:assert/strict";

/** Bounded 1 ms histogram. Overflow retains a conservative upper bound. */
export class Histogram {
  private readonly bins = new Uint32Array(10002);
  private maximum = 0;
  private samples = 0;

  get count(): number { return this.samples; }

  add(ms: number): void {
    assert(Number.isFinite(ms) && ms >= 0, "Invalid timing sample");
    this.bins[Math.min(10001, Math.ceil(ms))]!++;
    this.samples++;
    this.maximum = Math.max(this.maximum, ms);
  }

  p(percent: number): number {
    assert(this.samples > 0 && percent > 0 && percent <= 1, "Invalid percentile");
    let sum = 0;
    for (let i = 0; i < this.bins.length; i++) {
      sum += this.bins[i]!;
      if (sum >= Math.ceil(this.samples * percent)) return i === 10001 ? this.maximum : i;
    }
    throw new Error("Invalid histogram");
  }

  result() {
    return this.samples === 0 ? { count: 0 } : {
      count: this.samples, p95MsUpper: this.p(.95), p99MsUpper: this.p(.99), maxMs: this.maximum,
    };
  }
}

/** A busy session can already be late before its next timer is scheduled. */
export function splitDelay(due: number, ready: number, begin: number) {
  assert([due, ready, begin].every(Number.isFinite) && begin >= ready, "Invalid request timeline");
  return { queueMs: Math.max(0, ready - due), wakeMs: Math.max(0, begin - Math.max(due, ready)) };
}
