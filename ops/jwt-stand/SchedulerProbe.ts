import { readFileSync } from "node:fs";
import { Histogram } from "./metrics";

type Counters = { mainCpuMs?: number; runQueueMs?: number; processCpuMs: number;
  throttledMs?: number; cpuPressureMs?: number; memoryPressureMs?: number };

/** Linux counters supplement timer gaps; missing counters are never reported as zero. */
export class SchedulerProbe {
  private previous?: { now: number; epoch: number; counters: Counters };
  private readonly cost = new Histogram();
  private readonly unavailable = new Set<string>();

  private read(path: string): string {
    try { return readFileSync(path, "utf8"); }
    catch { this.unavailable.add(path); return ""; }
  }

  sample(now: number, epoch: number) {
    const started = performance.now();
    const sched = this.read("/proc/self/schedstat").trim().split(/\s+/);
    const cpu = process.cpuUsage();
    const counters: Counters = { processCpuMs: (cpu.user + cpu.system) / 1000 };
    if (sched.length === 3 && sched.every(value => /^\d+$/.test(value))) {
      counters.mainCpuMs = Number(sched[0]) / 1e6;
      counters.runQueueMs = Number(sched[1]) / 1e6;
    } else this.unavailable.add("/proc/self/schedstat");
    const fields = [
      ["throttledMs", "/sys/fs/cgroup/cpu.stat", /^throttled_usec (\d+)$/m],
      ["cpuPressureMs", "/proc/pressure/cpu", /^some .*total=(\d+)$/m],
      ["memoryPressureMs", "/proc/pressure/memory", /^full .*total=(\d+)$/m],
    ] as const;
    for (const [key, path, pattern] of fields) {
      const value = this.read(path).match(pattern)?.[1];
      if (value !== undefined) counters[key] = Number(value) / 1000;
      else this.unavailable.add(path);
    }
    const previous = this.previous;
    this.previous = { now, epoch, counters };
    this.cost.add(performance.now() - started);
    if (!previous) return undefined;
    return { fromEpochMs: previous.epoch, toEpochMs: epoch, elapsedMs: now - previous.now,
      delta: counterDelta(previous.counters, counters) };
  }

  diagnostics() { return { sampleCost: this.cost.result(), unavailable: [...this.unavailable] }; }
}

export function counterDelta(before: Counters, after: Counters): Partial<Counters> {
  const delta: Partial<Counters> = {};
  for (const key of Object.keys(after) as (keyof Counters)[]) {
    const first = before[key], last = after[key];
    if (first !== undefined && last !== undefined && Number.isFinite(first) && Number.isFinite(last) && last >= first) delta[key] = last - first;
  }
  return delta;
}
